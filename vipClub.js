// vipClub.js actualizado con Lista Blanca de Emails
const { shopifyGraphQL } = require("./shopifyAuth");

const TAG_MT = "Club-Mensual-Trimestral";
const TAG_SA = "Club-Semestral-Anual";
const VIP_TAGS = [TAG_MT, TAG_SA];

const DAY_MS = 1000 * 60 * 60 * 24;
const QUALIFY_DAYS = 90;
const REENGAGE_WINDOW_DAYS = 30;
const MAX_DAYS_BETWEEN_ORDERS = 65;

// ============================================================================
// 🛡️ LISTA BLANCA (EXCEPCIONES MANUALES)
// Añade aquí los emails de los clientes que deben estar en el club pase lo que pase.
// IMPORTANTE: Escribe los emails SIEMPRE en minúsculas.
// ============================================================================
const MANUAL_VIP_EMAILS = {
  // Ejemplos (puedes borrarlos o sustituirlos por los tuyos):
  "holaqisalut@gmail.com": TAG_MT,
  "ejemplo_anual@gmail.com": TAG_SA,
};

// --- Funciones Dinámicas de Tiempo y Tiers ---
function getCycleDays(planName, variantTitle) {
  const textToAnalyze = `${planName || ""} ${variantTitle || ""}`.toLowerCase();

  if (
    textToAnalyze.includes("anual") ||
    textToAnalyze.includes("year") ||
    textToAnalyze.includes("12 meses")
  )
    return 365;
  if (textToAnalyze.includes("semestral") || textToAnalyze.includes("6 month"))
    return 180;
  if (
    textToAnalyze.includes("trimestral") ||
    textToAnalyze.includes("3 month") ||
    textToAnalyze.includes("90 day")
  )
    return 90;

  return 30;
}

function tierTagFromSellingPlanName(planName, variantTitle) {
  const cycle = getCycleDays(planName, variantTitle);
  if (cycle >= 180) return TAG_SA;
  return TAG_MT;
}

// --- Lógica de bloques de tiempo basada en pedidos ---
function buildBlocksFromOrders(orders) {
  if (!orders.length) return [];

  const sorted = [...orders].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );

  const blocks = [];
  let curStart = new Date(sorted[0].createdAt).getTime();
  let curEnd = curStart;

  let firstItem = sorted[0].lineItems.nodes.find((item) => item.sellingPlan);
  let lastPlanName = firstItem?.sellingPlan.name || "";
  let lastVariantTitle = firstItem?.variant?.title || "";

  for (let i = 0; i < sorted.length; i++) {
    const orderDate = new Date(sorted[i].createdAt).getTime();
    const gapMs = orderDate - curEnd;

    const cycleDays = getCycleDays(lastPlanName, lastVariantTitle);
    const maxGapDays = cycleDays + 35;

    if (gapMs <= maxGapDays * DAY_MS || i === 0) {
      curEnd = orderDate;
    } else {
      blocks.push({
        start: curStart,
        end: curEnd,
        lastPlanName,
        lastVariantTitle,
      });
      curStart = orderDate;
      curEnd = orderDate;
    }

    const currentItem = sorted[i].lineItems.nodes.find(
      (item) => item.sellingPlan,
    );
    if (currentItem) {
      lastPlanName = currentItem.sellingPlan.name || "";
      lastVariantTitle = currentItem.variant?.title || "";
    }
  }

  blocks.push({ start: curStart, end: curEnd, lastPlanName, lastVariantTitle });
  return blocks;
}

/**
 * Decide si el cliente merece el tag HOY, evaluando su bloque más reciente.
 */
function decideTag(
  orders,
  now = Date.now(),
  customerGid = "Desconocido",
  customerName = "Desconocido",
) {
  console.log(`\n🕵️ DIAGNÓSTICO CLIENTE: ${customerName} | ID: ${customerGid}`);
  console.log(
    `   - Total pedidos (Sub + Normales) devueltos por la API: ${orders._totalOrdersInShopify || 0}`,
  );

  if (!orders.length) {
    console.log(`   ❌ SUSPENDE: 0 pedidos de suscripción encontrados.`);
    return null;
  }

  const blocks = buildBlocksFromOrders(orders);
  const lastBlock = blocks[blocks.length - 1];

  const cycleDays = getCycleDays(
    lastBlock.lastPlanName,
    lastBlock.lastVariantTitle,
  );
  const maxInactiveDays = cycleDays + 15;

  const daysSinceLastOrder = (now - lastBlock.end) / DAY_MS;
  const tenureDays = (now - lastBlock.start) / DAY_MS;

  console.log(`   - Pedidos de suscripción validados: ${orders.length}`);
  console.log(
    `   - Ciclo detectado: ${cycleDays} días (Variante: ${lastBlock.lastVariantTitle || "N/A"})`,
  );
  console.log(
    `   - Fecha 1º pedido de su racha: ${new Date(lastBlock.start).toISOString().split("T")[0]}`,
  );
  console.log(
    `   - Fecha último pedido: ${new Date(lastBlock.end).toISOString().split("T")[0]}`,
  );

  if (daysSinceLastOrder > maxInactiveDays) {
    console.log(
      `   ❌ SUSPENDE: Hace ${daysSinceLastOrder.toFixed(1)} días de su último pago (Max permitido: ${maxInactiveDays})`,
    );
  } else {
    console.log(
      `   ✅ ACTIVO: Hace ${daysSinceLastOrder.toFixed(1)} días de su último pago (Max permitido: ${maxInactiveDays})`,
    );
  }

  if (tenureDays < QUALIFY_DAYS) {
    console.log(
      `   ❌ SUSPENDE: Tiene ${tenureDays.toFixed(1)} días de antigüedad real (Min: 90)`,
    );
  } else {
    console.log(
      `   ✅ VETERANO: Tiene ${tenureDays.toFixed(1)} días de antigüedad real acumulada`,
    );
  }

  if (daysSinceLastOrder > maxInactiveDays) return null;
  if (tenureDays < QUALIFY_DAYS) return null;

  return tierTagFromSellingPlanName(
    lastBlock.lastPlanName,
    lastBlock.lastVariantTitle,
  );
}

// --- Shopify read/write helpers ---
async function getSubscriptionOrdersForCustomer(customerGid) {
  const custData = await shopifyGraphQL(
    `query($id: ID!) {
       customer(id: $id) {
         displayName
         email
         orders(first: 250, reverse: true) {
           nodes {
             id
             createdAt
             tags
             lineItems(first: 5) {
               nodes {
                 title
                 variant { title }
                 sellingPlan { name }
               }
             }
           }
         }
       }
     }`,
    { id: customerGid },
  );

  const customer = custData.customer;
  const customerName = customer?.displayName || "Desconocido";
  const customerEmail = customer?.email ? customer.email.toLowerCase() : null; // Guardamos el email
  let rawOrders = customer?.orders?.nodes || [];

  if (customerEmail) {
    const emailData = await shopifyGraphQL(
      `query($query: String!) {
         orders(first: 250, query: $query) {
           nodes {
             id
             createdAt
             tags
             lineItems(first: 5) {
               nodes {
                 title
                 variant { title }
                 sellingPlan { name }
               }
             }
           }
         }
       }`,
      { query: `email:${customerEmail}` },
    );

    if (
      emailData.orders?.nodes &&
      emailData.orders.nodes.length > rawOrders.length
    ) {
      rawOrders = emailData.orders.nodes;
    }
  }

  const subOrders = rawOrders.filter((order) => {
    const hasSellingPlan = order.lineItems.nodes.some(
      (item) => item.sellingPlan !== null,
    );
    const orderTags = order.tags || [];
    const hasSubifyTag = orderTags.some((tag) => {
      const t = tag.toLowerCase();
      return (
        t.includes("subi subscription") ||
        t.includes("subify") ||
        t.includes("recurring") ||
        t.includes("subscription")
      );
    });
    return hasSellingPlan || hasSubifyTag;
  });

  const result = subOrders.map((order) => ({ ...order, status: "ACTIVE" }));

  result._customerName = customerName;
  result._customerEmail = customerEmail; // Exportamos el email para la lista blanca
  result._totalOrdersInShopify = rawOrders.length;

  return result;
}

async function getCustomerTags(customerGid) {
  const data = await shopifyGraphQL(
    `query($id: ID!) { customer(id: $id) { id tags } }`,
    { id: customerGid },
  );
  return data.customer?.tags || [];
}

async function addTag(customerGid, tag) {
  await shopifyGraphQL(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: customerGid, tags: [tag] },
  );
}

async function removeTags(customerGid, tags) {
  if (!tags.length) return;
  await shopifyGraphQL(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: customerGid, tags },
  );
}

async function reconcileCustomer(customerGid, now = Date.now()) {
  const subOrders = await getSubscriptionOrdersForCustomer(customerGid);
  const customerEmail = subOrders._customerEmail;
  const customerName = subOrders._customerName;

  let desired = null;

  // 1. Comprobamos la Lista Blanca primero
  if (customerEmail && MANUAL_VIP_EMAILS[customerEmail]) {
    desired = MANUAL_VIP_EMAILS[customerEmail];
    console.log(
      `\n⭐ EXCEPCIÓN MANUAL (LISTA BLANCA): ${customerName} | ${customerEmail}`,
    );
    console.log(`   ✅ Asignado directamente al nivel: ${desired}`);
  } else {
    // 2. Si no está en la lista blanca, aplicamos la matemática normal
    desired = decideTag(subOrders, now, customerGid, customerName);
  }

  const currentTags = await getCustomerTags(customerGid);

  const currentVip = currentTags.filter((t) => VIP_TAGS.includes(t));
  const toRemove = currentVip.filter((t) => t !== desired);
  const toAdd = desired && !currentVip.includes(desired) ? desired : null;

  if (toRemove.length) await removeTags(customerGid, toRemove);
  if (toAdd) await addTag(customerGid, toAdd);

  return { customerGid, desired, added: toAdd, removed: toRemove };
}

module.exports = {
  TAG_MT,
  TAG_SA,
  VIP_TAGS,
  QUALIFY_DAYS,
  REENGAGE_WINDOW_DAYS,
  MAX_DAYS_BETWEEN_ORDERS,
  tierTagFromSellingPlanName,
  buildBlocksFromOrders,
  decideTag,
  getSubscriptionOrdersForCustomer,
  getAllContractsForCustomer: getSubscriptionOrdersForCustomer,
  reconcileCustomer,
};
