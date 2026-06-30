// check-contracts.js — Diagnóstico de acceso a Subscription Contracts
require("dotenv").config();
const { shopifyGraphQL } = require("./shopifyAuth");

(async () => {
  // 1. ¿Qué scopes tiene REALMENTE el token actual?
  try {
    const scopeData = await shopifyGraphQL(`
      query { currentAppInstallation { accessScopes { handle } } }
    `);
    const handles = (scopeData.currentAppInstallation?.accessScopes || []).map(
      (s) => s.handle,
    );
    console.log("\n🔑 SCOPES CONCEDIDOS AL TOKEN ACTUAL:");
    console.log("   " + handles.join(", "));
    const hasContractScope = handles.some((h) =>
      h.includes("subscription_contracts"),
    );
    console.log(
      hasContractScope
        ? "   ✅ El token TIENE scope de subscription contracts."
        : "   ❌ El token NO tiene scope de subscription contracts.",
    );
  } catch (e) {
    console.log("⚠️  No se pudieron leer los scopes:", e.message);
  }

  // 2. ¿Podemos leer contratos de verdad? (incluidos los de Subify)
  try {
    const data = await shopifyGraphQL(`
      query {
        subscriptionContracts(first: 5) {
          nodes {
            id
            status
            createdAt
            app { title }
            customer { displayName email }
          }
        }
      }
    `);
    const nodes = data.subscriptionContracts?.nodes || [];
    console.log(`\n📄 CONTRATOS DEVUELTOS: ${nodes.length}`);
    nodes.forEach((c) => {
      console.log(
        `   - ${c.status} | App: ${c.app?.title || "?"} | ${c.customer?.displayName || "?"} (${c.customer?.email || "?"})`,
      );
    });
    if (nodes.length) {
      console.log("\n✅ ¡ACCESO A CONTRATOS CONFIRMADO!");
    } else {
      console.log(
        "\n⚠️  Query OK pero 0 contratos (o no hay, o el scope no devuelve los de otra app).",
      );
    }
  } catch (e) {
    console.log("\n❌ ERROR al leer contratos:", e.message);
  }
})();
