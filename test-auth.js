// test-auth.js — verify OAuth + a trivial GraphQL call work.
require("dotenv").config();
const { shopifyGraphQL, SHOP_DOMAIN, API_VERSION } = require("./shopifyAuth");

(async () => {
  console.log("Shop:", SHOP_DOMAIN, "API version:", API_VERSION);
  console.log("Requesting access token + shop info...");
  try {
    const data = await shopifyGraphQL(
      `{ shop { name primaryDomain { host } } }`,
    );
    console.log("✅ Auth OK");
    console.log("Shop name:", data.shop.name);
    console.log("Primary domain:", data.shop.primaryDomain.host);
  } catch (e) {
    console.error("❌ Auth FAILED");
    console.error(e.message);
    process.exit(1);
  }
})();
