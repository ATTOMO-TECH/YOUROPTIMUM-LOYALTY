require("dotenv").config();
const { shopifyGraphQL } = require("./shopifyAuth");
const { reconcileCustomer, MANAGED_TAGS } = require("./vipClub");

// Pausa para no saturar la API de Shopify (Rate Limiting)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Obtener clientes que YA tienen la etiqueta VIP
async function getTaggedCustomers() {
  console.log("🔍 Buscando clientes que ya tienen etiquetas VIP...");
  const query = `
    query getTagged($query: String!) {
      customers(first: 250, query: $query) {
        nodes { id }
      }
    }
  `;
  // Incluye las etiquetas antiguas para que sus clientes migren al modelo por línea.
  const searchQuery = MANAGED_TAGS.map((t) => `tag:'${t}'`).join(" OR ");

  const data = await shopifyGraphQL(query, { query: searchQuery });
  const ids = data.customers?.nodes.map((n) => n.id) || [];
  console.log(`   ✅ Encontrados: ${ids.length} clientes etiquetados.`);
  return ids;
}

// 2. Obtener clientes con pedidos recientes (ventana RECENT_DAYS, paginando con cursor)
//    Antes se leía UNA sola página de 250 pedidos (~54 días en esta tienda), por lo que los
//    suscriptores semestrales/anuales salían de la ventana antes de cumplir los 90 días y
//    nunca eran evaluados. Ahora se recorren todas las páginas de la ventana.
const RECENT_DAYS = Number(process.env.RECENT_DAYS) || 600; // debe ser >= 380 (ciclo anual + 15 días de gracia)
const MAX_PAGES = 100; // tope de seguridad (100 x 250 = 25.000 pedidos)

async function getRecentBuyers() {
  console.log(
    `🔍 Buscando clientes con compras en los últimos ${RECENT_DAYS} días....`,
  );
  const sinceDate = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const query = `
    query getRecentOrders($query: String!, $after: String) {
      orders(first: 250, sortKey: CREATED_AT, reverse: true, query: $query, after: $after) {
        nodes {
          customer { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const uniqueCustomerIds = new Set();
  let after = null;
  let pages = 0;
  let totalOrders = 0;

  do {
    const data = await shopifyGraphQL(query, {
      query: `created_at:>=${sinceDate}`,
      after,
    });
    const conn = data.orders;
    const nodes = conn?.nodes || [];
    totalOrders += nodes.length;
    nodes.forEach((order) => {
      if (order.customer?.id) uniqueCustomerIds.add(order.customer.id);
    });
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
    if (after) await delay(250); // respetar el rate limit entre páginas
  } while (after && pages < MAX_PAGES);

  if (after) {
    console.warn(
      `   ⚠️  Se alcanzó el tope de ${MAX_PAGES} páginas; puede haber pedidos sin revisar.`,
    );
  }
  console.log(
    `   ✅ Encontrados: ${uniqueCustomerIds.size} clientes con pedidos (${totalOrders} pedidos en ${pages} página(s)).`,
  );
  return Array.from(uniqueCustomerIds);
}

// 3. Función Principal del CRON
async function runNightlyCron() {
  console.log("==========================================");
  console.log("🌙 INICIANDO CRON NOCTURNO DEL VIP CLUB 🌙");
  console.log("==========================================\n");

  try {
    // Recolectamos candidatos
    const taggedIds = await getTaggedCustomers();
    const recentIds = await getRecentBuyers();

    // Unimos y eliminamos duplicados
    const allCandidateIds = Array.from(new Set([...taggedIds, ...recentIds]));
    console.log(
      `\n🎯 Total de candidatos únicos a evaluar: ${allCandidateIds.length}\n`,
    );

    let stats = { evaluated: 0, added: 0, removed: 0, kept: 0, errors: 0 };

    // Procesamos uno a uno (función central llamada por todos los caminos)
    for (const customerGid of allCandidateIds) {
      try {
        const result = await reconcileCustomer(customerGid);
        stats.evaluated++;

        if (result.added.length) {
          console.log(`[+] ${customerGid} -> Añadidas: ${result.added.join(", ")}`);
          stats.added++;
        }
        if (result.removed.length) {
          console.log(`[-] ${customerGid} -> Borradas: ${result.removed.join(", ")}`);
          stats.removed++;
        }
        if (!result.added.length && !result.removed.length) {
          stats.kept++; // Ya estaba correcto
        }
      } catch (err) {
        console.error(`[!] Error evaluando a ${customerGid}:`, err.message);
        stats.errors++;
      }

      // Pausamos 250ms entre cada cliente para que Shopify no nos bloquee
      await delay(250);
    }

    // Reporte Final
    console.log("\n==========================================");
    console.log("📊 REPORTE FINAL DEL CRON");
    console.log("==========================================");
    console.log(`Evaluados en total: ${stats.evaluated}`);
    console.log(`Nuevos VIPs (Tags Añadidos): ${stats.added}`);
    console.log(`Suscripciones Caídas (Tags Borrados): ${stats.removed}`);
    console.log(`Mantenidos sin cambios: ${stats.kept}`);
    console.log(`Errores: ${stats.errors}`);
    console.log("==========================================\n");
    return stats;
  } catch (globalError) {
    console.error("🚨 Error crítico en el CRON:", globalError);
    throw globalError;
  }
}

/* // Ejecutar el proceso
runNightlyCron(); */

module.exports = { runNightlyCron, getRecentBuyers, getTaggedCustomers };
