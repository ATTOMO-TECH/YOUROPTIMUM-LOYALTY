require("dotenv").config();
const { shopifyGraphQL } = require("./shopifyAuth");

async function analyzeRecentOrders() {
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const dateString = twoDaysAgo.toISOString();

  console.log(`🔎 Buscando pedidos creados desde: ${dateString}\n`);

  const query = `
    query getRecentOrders($query: String) {
      orders(first: 50, query: $query) {
        nodes {
          id
          name
          createdAt
          tags
          customer {
            displayName
            id
          }
          lineItems(first: 5) {
            nodes {
              title
              quantity
              sellingPlan {
                name
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await shopifyGraphQL(query, {
      query: `created_at:>=${dateString}`,
    });

    const orders = response.orders.nodes;

    if (orders.length === 0) {
      console.log("❌ No se encontraron pedidos en los últimos 2 días.");
      return;
    }

    console.log(`✅ Se han encontrado ${orders.length} pedidos.\n`);

    orders.forEach((order) => {
      // Verificamos si algún producto tiene un plan de venta
      const subItems = order.lineItems.nodes.filter(
        (item) => item.sellingPlan !== null,
      );
      const isSubscription = subItems.length > 0;

      console.log(`--------------------------------------------------`);
      console.log(`📦 Pedido: ${order.name} (${order.id})`);
      console.log(
        `👤 Cliente: ${order.customer ? order.customer.displayName : "N/A"}`,
      );
      console.log(`📅 Fecha: ${order.createdAt}`);
      console.log(`🏷️  Tags: [${order.tags ? order.tags.join(", ") : ""}]`);
      console.log(
        `🔄 ¿Es suscripción oficial?: ${isSubscription ? "SÍ ✅" : "NO ❌"}`,
      );

      if (isSubscription) {
        subItems.forEach((item) => {
          console.log(`   🔹 Producto: ${item.title}`);
          console.log(`   🔹 Plan Detectado: ${item.sellingPlan.name}`);
        });
      }
      console.log(`--------------------------------------------------\n`);
    });
  } catch (error) {
    console.error("Error analizando pedidos recientes:", error);
  }
}

analyzeRecentOrders();
