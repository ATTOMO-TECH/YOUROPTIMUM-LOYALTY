require("dotenv").config();
const { shopifyGraphQL } = require("./shopifyAuth");
const { reconcileCustomer, VIP_TAGS } = require("./vipClub");

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
  const searchQuery = `tag:'${VIP_TAGS[0]}' OR tag:'${VIP_TAGS[1]}'`;

  const data = await shopifyGraphQL(query, { query: searchQuery });
  const ids = data.customers?.nodes.map((n) => n.id) || [];
  console.log(`   ✅ Encontrados: ${ids.length} clientes etiquetados.`);
  return ids;
}

// 2. Obtener clientes activos (han hecho pedidos en los últimos 120 días)
async function getRecentBuyers() {
  console.log("🔍 Buscando clientes con compras en los últimos 120 días...");
  const date120DaysAgo = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const query = `
    query getRecentOrders($query: String!) {
      orders(first: 250, sortKey: CREATED_AT, reverse: true, query: $query) {
        nodes {
          customer { id }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    query: `created_at:>=${date120DaysAgo}`,
  });

  // Extraemos clientes únicos de esos pedidos
  const uniqueCustomerIds = new Set();
  data.orders?.nodes.forEach((order) => {
    if (order.customer?.id) uniqueCustomerIds.add(order.customer.id);
  });

  console.log(
    `   ✅ Encontrados: ${uniqueCustomerIds.size} clientes activos recientes.`,
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

        if (result.added) {
          console.log(
            `[+] ${customerGid} -> Etiqueta AÑADIDA: ${result.added}`,
          );
          stats.added++;
        } else if (result.removed && result.removed.length > 0) {
          console.log(
            `[-] ${customerGid} -> Etiquetas BORRADAS: ${result.removed.join(", ")}`,
          );
          stats.removed++;
        } else {
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
  } catch (globalError) {
    console.error("🚨 Error crítico en el CRON:", globalError);
  }
}

/* // Ejecutar el proceso
runNightlyCron(); */

module.exports = { runNightlyCron };
