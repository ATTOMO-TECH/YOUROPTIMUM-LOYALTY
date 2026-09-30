// vipClub.js actualizado con Lista Blanca de Emails
const { shopifyGraphQL } = require("./shopifyAuth");

// Niveles base (tier) y líneas de producto: Woman = Optimum, Men = Optimum Men.
// Un cliente puede tener hasta 2 etiquetas (una por línea de producto).
const BASE_MT = "Club-Mensual-Trimestral";
const BASE_SA = "Club-Semestral-Anual";
const TAG_MT_WOMAN = `${BASE_MT}-Woman`;
const TAG_SA_WOMAN = `${BASE_SA}-Woman`;
const TAG_MT_MEN = `${BASE_MT}-Men`;
const TAG_SA_MEN = `${BASE_SA}-Men`;
const VIP_TAGS = [TAG_MT_WOMAN, TAG_SA_WOMAN, TAG_MT_MEN, TAG_SA_MEN];
// Etiquetas del modelo antiguo (una sola por cliente): se retiran solas en la migración.
const LEGACY_TAGS = [BASE_MT, BASE_SA];
const MANAGED_TAGS = [...VIP_TAGS, ...LEGACY_TAGS];

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
  // El valor puede ser una etiqueta o un array de etiquetas de VIP_TAGS:
  "ejemplo_mensual@gmail.com": TAG_MT_WOMAN,
  "ejemplo_anual@gmail.com": [TAG_SA_WOMAN, TAG_SA_MEN],

  // ── TEMPORAL (05-oct-2026): contrato ACTIVO/PAUSADO real según el export de Subify
  // del 30-09, pero Subify no les pone la etiqueta "Has Active/Paused Subscription" en
  // Shopify, y la política de baja a 15 días los expulsaría por error. Retirar cada
  // entrada cuando Subify resincronice las etiquetas de ese cliente.
  "lydiaconcheso@gmail.com": TAG_MT_WOMAN,
  "granlorena@hotmail.com": TAG_MT_WOMAN,
  "daniella.modern@yahoo.co.uk": TAG_MT_MEN,
  "mariagilgonz@gmail.com": TAG_MT_WOMAN,
  "mabelga@yahoo.es": TAG_SA_WOMAN,
  "esthercafe3@hotmail.com": TAG_MT_WOMAN,

  // ── TEMPORAL (07-oct-2026): categoría 8 del cruce del PM — activos con antigüedad
  // a los que Subify no etiqueta, expulsados por la regla antigua. Retirar cuando
  // Subify resincronice sus etiquetas.
  "robertome@economistas.org": TAG_MT_MEN,
  "manuelgonzalezdiaz@gmail.com": TAG_MT_MEN,
};

// ============================================================================
// 🚫 BAJAS FORZADAS (EXCEPCIONES MANUALES)
// Clientes que NO deben estar en el club aunque la matemática los quiera dentro.
// TEMPORAL (07-oct-2026): cancelados/expirados reales (export Subify 30-09) a los que
// Subify no etiqueta como cancelados en Shopify, por lo que la baja automática de 15
// días no puede verlos. Retirar cada entrada cuando Subify resincronice.
// IMPORTANTE: emails SIEMPRE en minúsculas.
// ============================================================================
const MANUAL_OUT_EMAILS = [
  "ainhoa.olivan@hotmail.com",
  "gema.pv7@gmail.com",
  "mariacapdevilaimarques@yahoo.es",
];

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
  if (cycle >= 180) return BASE_SA;
  return BASE_MT;
}

// --- Separación por línea de producto (Woman / Men) ---
function isMenLineItem(item) {
  return /\bmen\b/i.test(`${item?.title || ""} ${item?.variant?.title || ""}`);
}

/**
 * Reparte los pedidos de suscripción entre las dos líneas de producto.
 * Un pedido con artículos de ambas líneas cuenta para las dos (cada copia
 * conserva solo los artículos de su línea, para detectar bien el ciclo).
 */
function splitSubOrdersByLine(orders) {
  const woman = [];
  const men = [];
  for (const order of orders) {
    const nodes = order.lineItems?.nodes || [];
    const planNodes = nodes.filter((n) => n.sellingPlan);
    if (planNodes.length) {
      const menNodes = planNodes.filter(isMenLineItem);
      const womanNodes = planNodes.filter((n) => !isMenLineItem(n));
      if (menNodes.length) men.push({ ...order, lineItems: { nodes: menNodes } });
      if (womanNodes.length) woman.push({ ...order, lineItems: { nodes: womanNodes } });
    } else {
      // Pedido detectado solo por etiquetas (sin selling plan): lo asignamos por títulos.
      const hasMen = nodes.some(isMenLineItem);
      const hasWoman = nodes.some((n) => !isMenLineItem(n) && /optimum/i.test(n?.title || ""));
      if (hasMen) men.push(order);
      if (hasWoman || !hasMen) woman.push(order);
    }
  }
  return { woman, men };
}

/**
 * Decide las etiquetas del cliente (0, 1 o 2): la lógica de rachas de siempre,
 * aplicada por separado a cada línea de producto.
 */
function decideTags(
  subOrders,
  now = Date.now(),
  customerGid = "Desconocido",
  customerName = "Desconocido",
) {
  const { woman, men } = splitSubOrdersByLine(subOrders);
  const tags = [];
  if (woman.length) {
    const base = decideTag(woman, now, customerGid, `${customerName} [Woman]`);
    if (base) tags.push(`${base}-Woman`);
  }
  if (men.length) {
    const base = decideTag(men, now, customerGid, `${customerName} [Men]`);
    if (base) tags.push(`${base}-Men`);
  }
  return tags;
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
         tags
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
  result._customerTags = customer?.tags || []; // Etiquetas del cliente (señal de Subify)
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

async function addTags(customerGid, tags) {
  if (!tags.length) return;
  await shopifyGraphQL(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: customerGid, tags },
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

  let desired = [];
  let isWhitelisted = false;
  const isForcedOut = customerEmail && MANUAL_OUT_EMAILS.includes(customerEmail);

  // 1. Comprobamos la Lista Blanca primero
  if (customerEmail && MANUAL_VIP_EMAILS[customerEmail]) {
    isWhitelisted = true;
    desired = [].concat(MANUAL_VIP_EMAILS[customerEmail]);
    console.log(
      `\n⭐ EXCEPCIÓN MANUAL (LISTA BLANCA): ${customerName} | ${customerEmail}`,
    );
    console.log(`   ✅ Asignado directamente a: ${desired.join(", ")}`);
  } else {
    // 2. Si no está en la lista blanca, aplicamos la matemática por línea de producto
    desired = decideTags(subOrders, now, customerGid, customerName);
  }

  const currentTags = await getCustomerTags(customerGid);

  // Política del cliente (sep-2026): el club NO se pierde por mover entregas ni por un
  // impago en reintento. Si Subify dice que la suscripción sigue ACTIVA, conservamos las
  // etiquetas del club que el cliente ya tiene aunque la regla de inactividad las quitara.
  // (La señal es la etiqueta de cliente "Has Active Subscription" de Subify; los contratos
  // no son legibles por API. La cualificación inicial de 90 días no cambia.)
  // Baja forzada: fuera del club pase lo que pase (y sin keep-alive ni marcas de baja)
  if (isForcedOut && !isWhitelisted) {
    if (desired.length) console.log(`   🚫 BAJA FORZADA (lista manual): ${customerName} | ${customerEmail}`);
    desired = [];
  }

  const custSubifyTags = (subOrders._customerTags || []).map((t) => t.trim());
  const subifyActive = custSubifyTags.includes("Has Active Subscription");
  // Política del cliente (oct-2026): con PAGO FALLIDO se sale del club. El keep-alive
  // solo protege a activos SIN impago; con la etiqueta 'payment failure' de Subify
  // vuelve a aplicar la regla de inactividad (ciclo+15 sin pedido pagado), que expulsa
  // al moroso sin echar por error a quien ya resolvió el impago y sigue pidiendo
  // (la etiqueta es pegajosa: no desaparece al volver a pagar).
  const paymentFailure = custSubifyTags.includes("payment failure");
  if (subifyActive && !paymentFailure && !isForcedOut) {
    for (const tag of currentTags.filter((t) => VIP_TAGS.includes(t))) {
      const lineSuffix = tag.endsWith("-Men") ? "-Men" : "-Woman";
      if (!desired.some((d) => d.endsWith(lineSuffix))) {
        desired.push(tag);
        console.log(
          `   🛡️ Mantengo ${tag}: suscripción ACTIVA en Subify (entrega movida o impago en reintento)`,
        );
      }
    }
  }

  // Política del cliente (oct-2026): al CANCELAR la suscripción, la pertenencia al club
  // termina como mucho 15 días después, sea cual sea el plan (mensual, trimestral o anual).
  // Subify no expone la fecha de cancelación por API, así que el cron marca la primera
  // noche en que ve al cliente cancelado (etiqueta club-baja-AAAA-MM-DD) y ejecuta la baja
  // cuando la marca cumple 15 días. Si reactiva o pausa, la marca se retira sin efecto.
  const CANCEL_MARK_PREFIX = "club-baja-";
  const cancelMark = currentTags.map((t) => t.trim()).find((t) => t.startsWith(CANCEL_MARK_PREFIX));
  const custTagsTrim = (subOrders._customerTags || []).map((t) => t.trim());
  const cancelledOnly =
    custTagsTrim.includes("Has Cancelled Subscription") &&
    !custTagsTrim.includes("Has Active Subscription") &&
    !custTagsTrim.includes("Has Paused Subscription");
  const marksToRemove = [];
  let markToAdd = null;
  // Estando cancelado se pueden CONSERVAR etiquetas del club (hasta la baja a 15 días),
  // pero nunca ganarlas: sin esto, tras la baja la regla de inactividad re-añadiría al
  // cliente la noche siguiente (p. ej. anuales, cuya ventana es de 380 días).
  if (!isWhitelisted && cancelledOnly) {
    const currentVipNow = currentTags.map((t) => t.trim()).filter((t) => VIP_TAGS.includes(t));
    desired = desired.filter((t) => currentVipNow.includes(t));
  }
  const holdsClub = desired.length > 0 || currentTags.some((t) => VIP_TAGS.includes(t.trim()));
  // Válvula de seguridad: las etiquetas de Subify a veces no reflejan un contrato activo
  // (clientes multi-contrato). Un cancelado de verdad no genera pedidos nuevos: si llega
  // un pedido de suscripción posterior a la marca, la marca se anula.
  const lastSubOrderMs = subOrders.reduce(
    (m, o) => Math.max(m, new Date(o.createdAt).getTime() || 0),
    0,
  );
  if (!isWhitelisted && !isForcedOut && cancelledOnly && holdsClub) {
    if (!cancelMark) {
      markToAdd = `${CANCEL_MARK_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
      console.log(`   ⏳ Cancelación detectada: baja del club en 15 días (${markToAdd})`);
    } else {
      const detected = new Date(cancelMark.slice(CANCEL_MARK_PREFIX.length));
      const daysSince = (now - detected.getTime()) / DAY_MS;
      if (!Number.isNaN(detected.getTime()) && lastSubOrderMs > detected.getTime()) {
        console.log(
          `   🛡️ Marca de baja anulada: pedido de suscripción posterior a la marca (contrato activo real)`,
        );
        marksToRemove.push(cancelMark);
      } else if (!Number.isNaN(detected.getTime()) && daysSince >= 15) {
        console.log(
          `   🚪 Baja del club: cancelación detectada hace ${daysSince.toFixed(0)} días (política de 15 días)`,
        );
        desired = [];
        marksToRemove.push(cancelMark);
      }
    }
  } else if (cancelMark) {
    marksToRemove.push(cancelMark); // reactivó, pausó o ya no tiene etiquetas del club
  }

  // Incluimos las etiquetas del modelo antiguo para que la migración las retire sola.
  const currentManaged = currentTags.filter((t) => MANAGED_TAGS.includes(t));
  const toRemove = currentManaged.filter((t) => !desired.includes(t));
  const toAdd = desired.filter((t) => !currentManaged.includes(t));

  if (toRemove.length || marksToRemove.length)
    await removeTags(customerGid, [...toRemove, ...marksToRemove]);
  if (toAdd.length || markToAdd) await addTags(customerGid, [...toAdd, ...(markToAdd ? [markToAdd] : [])]);

  return { customerGid, desired, added: toAdd, removed: toRemove };
}

module.exports = {
  TAG_MT: BASE_MT,
  TAG_SA: BASE_SA,
  TAG_MT_WOMAN,
  TAG_SA_WOMAN,
  TAG_MT_MEN,
  TAG_SA_MEN,
  VIP_TAGS,
  LEGACY_TAGS,
  MANAGED_TAGS,
  decideTags,
  splitSubOrdersByLine,
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
