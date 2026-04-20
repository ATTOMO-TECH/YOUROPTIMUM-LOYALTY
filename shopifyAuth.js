// shopifyAuth.js
// Uses a pre-acquired offline (non-expiring) access token from env var.
// The token is obtained once via /install OAuth flow (see oauthInstall.js).
require("dotenv").config();

const SHOP = (process.env.SHOPIFY_SHOP || "")
  .replace(/\.myshopify\.com$/i, "")
  .trim();
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

if (!SHOP) {
  throw new Error("Missing SHOPIFY_SHOP env var");
}

const SHOP_DOMAIN = `${SHOP}.myshopify.com`;

console.log(
  `ShopifyAuth: shop=${SHOP_DOMAIN} api_version=${API_VERSION} ` +
    `access_token=${ACCESS_TOKEN ? "yes" : "NO (run /install first)"}`,
);

/**
 * GraphQL call against Shopify Admin API using the offline access token.
 */
async function shopifyGraphQL(query, variables = {}) {
  if (!ACCESS_TOKEN) {
    throw new Error(
      "SHOPIFY_ACCESS_TOKEN is not set. Visit /install to obtain one, or check Railway env vars.",
    );
  }

  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const raw = await res.text();

  if (res.status === 401) {
    throw new Error(
      "Shopify returned 401 Unauthorized. The access token is invalid or was revoked " +
        "(app uninstalled?). Re-run /install to acquire a new token.",
    );
  }
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON GraphQL response: ${raw.slice(0, 400)}`);
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

module.exports = { SHOP_DOMAIN, API_VERSION, shopifyGraphQL };
