// webhookRegistration.js
// Idempotent registration of the three webhooks we need.

const { shopifyGraphQL } = require("./shopifyAuth");

const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://youroptimum-loyalty-production.up.railway.app";

const WEBHOOKS = [
  { topic: "SUBSCRIPTION_CONTRACTS_CREATE", path: "/webhooks/sub-created" },
  { topic: "SUBSCRIPTION_CONTRACTS_UPDATE", path: "/webhooks/sub-updated" },
  { topic: "ORDERS_PAID", path: "/webhooks/order-paid" },
];

async function listExisting() {
  const data = await shopifyGraphQL(`
    query {
      webhookSubscriptions(first: 100) {
        edges { node {
          id topic
          endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
        } }
      }
    }
  `);
  return data.webhookSubscriptions.edges.map((e) => e.node);
}

async function createWebhook(topic, callbackUrl) {
  const d = await shopifyGraphQL(
    `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
       webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
         webhookSubscription { id }
         userErrors { field message }
       }
     }`,
    { topic, sub: { callbackUrl, format: "JSON" } },
  );
  const errs = d.webhookSubscriptionCreate.userErrors;
  if (errs.length) throw new Error(`create ${topic}: ${JSON.stringify(errs)}`);
  return d.webhookSubscriptionCreate.webhookSubscription.id;
}

async function registerAllWebhooks() {
  const existing = await listExisting();
  const results = [];
  for (const w of WEBHOOKS) {
    const callbackUrl = `${BASE_URL}${w.path}`;
    const found = existing.find(
      (e) => e.topic === w.topic && e.endpoint?.callbackUrl === callbackUrl,
    );
    if (found) {
      results.push({ topic: w.topic, id: found.id, status: "existing" });
      continue;
    }
    const id = await createWebhook(w.topic, callbackUrl);
    results.push({ topic: w.topic, id, status: "created" });
  }
  return results;
}

module.exports = { registerAllWebhooks };
