require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// 1. MOTOR GRAPHQL: Comunicación con Shopify (Versión 2026)
// ---------------------------------------------------------

// Función interna para conseguir la llave temporal de 24h
async function getShopifyAccessToken() {
  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`;

  // Formateamos los datos tal y como pide la documentación de Shopify
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.SHOPIFY_CLIENT_ID);
  params.append("client_secret", process.env.SHOPIFY_CLIENT_SECRET);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const data = await response.json();
    return data.access_token; // Este es nuestro "shpat_..." fresquito
  } catch (error) {
    console.error("❌ Error obteniendo el Access Token:", error);
    return null;
  }
}

// Función principal que hace las peticiones
async function shopifyGraphQL(query, variables = {}) {
  // 1. Conseguimos el token de acceso válido
  const accessToken = await getShopifyAccessToken();
  if (!accessToken) throw new Error("No hay token de acceso");

  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/graphql.json`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken, // Inyectamos el token temporal
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await response.json();
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    return data;
  } catch (error) {
    console.error("❌ Error de GraphQL:", error);
    return null;
  }
}

// ---------------------------------------------------------
// 2. MIDDLEWARE DE SEGURIDAD (HMAC)
// ---------------------------------------------------------
const verifyShopifyWebhook = (req, res, next) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const rawBody = req.body;

  if (!hmacHeader || !rawBody) {
    console.error("🛑 Petición bloqueada: Faltan cabeceras de seguridad.");
    return res.status(401).send("No autorizado");
  }

  const generatedHash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const generatedHashBuffer = Buffer.from(generatedHash);
  const hmacBuffer = Buffer.from(hmacHeader);

  if (
    generatedHashBuffer.length !== hmacBuffer.length ||
    !crypto.timingSafeEqual(generatedHashBuffer, hmacBuffer)
  ) {
    console.error("🛑 Petición bloqueada: La firma HMAC no coincide.");
    return res.status(401).send("Firma no válida");
  }

  try {
    req.body = JSON.parse(rawBody.toString());
    next();
  } catch (error) {
    console.error("Error parseando el JSON del webhook:", error);
    res.status(400).send("Cuerpo de la petición inválido");
  }
};

// ---------------------------------------------------------
// RUTAS DE ESTADO
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Servidor Loyalty de YourOptimum funcionando correctamente 🚀");
});

// ---------------------------------------------------------
// 3. OREJA 1: Entradas y Pagos (/webhooks/order-paid)
// ---------------------------------------------------------
app.post(
  "/webhooks/order-paid",
  express.raw({ type: "application/json" }),
  verifyShopifyWebhook,
  async (req, res) => {
    // 1. Responder a Shopify INMEDIATAMENTE (Obligatorio)
    res.status(200).send("Webhook recibido");

    try {
      const orderData = req.body;
      const customerEmail = orderData.email || orderData.contact_email;
      const customerId =
        orderData.customer?.admin_graphql_api_id ||
        `gid://shopify/Customer/${orderData.customer?.id}`;

      console.log(
        `\n📦 Analizando pedido #${orderData.order_number} de ${customerEmail}...`,
      );

      // 2. FILTRO DE ADUANAS: ¿Es un pedido de suscripción de Subify?
      if (orderData.source_name !== "subscription_contract_checkout_one") {
        console.log("❌ Rechazado: Es un pedido normal, no de suscripción.");
        return;
      }

      // 3. IDENTIFICAR EL PLAN (Modo Cazatalentos: Variante + Nombre + Selling Plan)
      const lineItem = orderData.line_items[0] || {};
      const variantTitle = lineItem.variant_title || "";
      const productName = lineItem.name || "";
      const sellingPlanName =
        lineItem.selling_plan_allocation?.selling_plan?.name || "";

      // Unimos todo en un solo texto en minúsculas para que no se nos escape nada
      const fullPlanText =
        `${variantTitle} ${productName} ${sellingPlanName}`.toLowerCase();

      let tagToAssign = null;
      let threshold = 0;

      if (
        fullPlanText.includes("semestral") ||
        fullPlanText.includes("anual") ||
        fullPlanText.includes("12 meses") ||
        fullPlanText.includes("half-yearly")
      ) {
        tagToAssign = "Club-Semestral-Anual";
        threshold = 1;
        console.log(
          "✅ Detectado: Semestral/Anual. Necesita 1 ciclo (Acceso directo).",
        );
      } else if (
        fullPlanText.includes("trimestral") ||
        fullPlanText.includes("quarterly")
      ) {
        tagToAssign = "Club-Mensual-Trimestral";
        threshold = 2;
        console.log("✅ Detectado: Trimestral. Necesita 2 ciclos.");
      } else if (
        fullPlanText.includes("mensual") ||
        fullPlanText.includes("monthly") ||
        fullPlanText.includes("suscripción")
      ) {
        tagToAssign = "Club-Mensual-Trimestral";
        threshold = 3;
        console.log("✅ Detectado: Mensual o Legacy. Necesita 3 ciclos.");
      } else {
        console.log(
          `⚠️ No se pudo identificar la frecuencia VIP en: ${fullPlanText}`,
        );
        return;
      }

      // 4. EL CONTADOR DE CICLOS (Consulta a Shopify)
      const countQuery = `
        query {
          customer(id: "${customerId}") {
            orders(first: 50, query: "source_name:subscription_contract_checkout_one") {
              totalCount
            }
          }
        }
      `;

      const countResult = await shopifyGraphQL(countQuery);
      const totalSubOrders =
        countResult?.data?.customer?.orders?.totalCount || 0;

      console.log(
        `⏳ El cliente lleva ${totalSubOrders} pedidos recurrentes. Necesita ${threshold}.`,
      );

      // 5. INYECTAR ETIQUETA SI CUMPLE LOS REQUISITOS
      if (totalSubOrders >= threshold) {
        const addTagMutation = `
          mutation addTags($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { 
              userErrors { message } 
            }
          }
        `;
        await shopifyGraphQL(addTagMutation, {
          id: customerId,
          tags: [tagToAssign],
        });
        console.log(`🎉 ¡ÉXITO! Etiqueta [${tagToAssign}] añadida al cliente.`);
      } else {
        console.log(`🔒 Aún no cumple los requisitos para entrar al club.`);
      }
    } catch (error) {
      console.error("❌ Error procesando la lógica del pedido:", error);
    }
  },
);

// ---------------------------------------------------------
// 4. OREJA 2: Cancelaciones (/webhooks/sub-cancelled)
// ---------------------------------------------------------
app.post(
  "/webhooks/sub-cancelled",
  express.raw({ type: "application/json" }),
  verifyShopifyWebhook,
  async (req, res) => {
    res.status(200).send("Webhook recibido");

    try {
      const contract = req.body;

      // Shopify envía el webhook cuando un contrato de suscripción se actualiza.
      // Verificamos si el nuevo estado es CANCELLED
      if (contract.status === "CANCELLED") {
        const customerId =
          contract.customer?.admin_graphql_api_id ||
          `gid://shopify/Customer/${contract.customer_id}`;

        console.log(
          `\n💔 Suscripción cancelada para el cliente ID: ${customerId}. Retirando etiquetas...`,
        );

        // Mutación para borrar cualquier rastro VIP
        const removeTagMutation = `
          mutation removeTags($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) { 
              userErrors { message } 
            }
          }
        `;
        await shopifyGraphQL(removeTagMutation, {
          id: customerId,
          tags: ["Club-Mensual-Trimestral", "Club-Semestral-Anual"],
        });

        console.log("✅ Etiquetas VIP retiradas correctamente tras la baja.");
      }
    } catch (error) {
      console.error("❌ Error procesando la cancelación:", error);
    }
  },
);

// ---------------------------------------------------------
// RUTA TEMPORAL PARA CREAR EL WEBHOOK OCULTO
// ---------------------------------------------------------
app.get("/crear-webhook", async (req, res) => {
  const mutation = `
    mutation {
      webhookSubscriptionCreate(
        topic: SUBSCRIPTION_CONTRACTS_UPDATE,
        webhookSubscription: {
          callbackUrl: "https://${req.get("host")}/webhooks/sub-cancelled",
          format: JSON
        }
      ) {
        userErrors { field message }
        webhookSubscription { id }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation);
  res.json({
    mensaje: "Petición de creación enviada a Shopify",
    respuesta: result,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Loyalty escuchando en el puerto ${PORT}`);
});
