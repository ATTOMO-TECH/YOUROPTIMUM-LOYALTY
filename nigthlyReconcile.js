// nightlyReconcile.js
// Safety-net CRON. Reconciles:
//   (1) every customer with at least one ACTIVE contract (catches new qualifiers)
//   (2) every customer currently carrying a VIP tag (catches orphaned tags)
//   (3) every customer whose most recent contract ended within the
//       re-engagement window (30 days) — they might re-subscribe and we want
//       the reconciliation to act instantly when they do; more importantly,
//       this ensures we don't strand a tag after the window closes.

const { shopifyGraphQL } = require("./shopifyAuth");

const {
  reconcileCustomer,
  VIP_TAGS,
  REENGAGE_WINDOW_DAYS,
} = require("./vipClub");

const DAY_MS = 1000 * 60 * 60 * 24;

async function fetchCustomersWithActiveContracts() {
  const customers = new Set();
  let cursor = null;
  for (let i = 0; i < 250; i++) {
    const data = await shopifyGraphQL(
      `query($after: String) {
         subscriptionContracts(first: 50, after: $after, query: "status:ACTIVE") {
           edges { cursor node { customer { id } } }
           pageInfo { hasNextPage }
         }
       }`,
      { after: cursor },
    );
    const conn = data.subscriptionContracts;
    for (const e of conn.edges) {
      if (e.node.customer?.id) customers.add(e.node.customer.id);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.edges[conn.edges.length - 1].cursor;
  }
  return [...customers];
}

async function fetchVipTaggedCustomers() {
  const customers = new Set();
  for (const tag of VIP_TAGS) {
    let cursor = null;
    for (let i = 0; i < 250; i++) {
      const data = await shopifyGraphQL(
        `query($after: String, $q: String!) {
           customers(first: 50, after: $after, query: $q) {
             edges { cursor node { id } }
             pageInfo { hasNextPage }
           }
         }`,
        { after: cursor, q: `tag:${tag}` },
      );
      const conn = data.customers;
      for (const e of conn.edges) customers.add(e.node.id);
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.edges[conn.edges.length - 1].cursor;
    }
  }
  return [...customers];
}

/**
 * Customers whose most recent (non-active) contract ended within the re-engagement
 * window. We include them so that when they re-subscribe before the window closes,
 * the tag is granted immediately on the first order-paid webhook, not a day later.
 * Also ensures we re-check the day the window closes, in case we need to strip
 * a stale tag (shouldn't happen with event path working, but this is the safety net).
 */
async function fetchCustomersInReengagementWindow() {
  const customers = new Set();
  const cutoffIso = new Date(
    Date.now() - REENGAGE_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  let cursor = null;
  for (let i = 0; i < 250; i++) {
    const data = await shopifyGraphQL(
      `query($after: String, $q: String!) {
         subscriptionContracts(first: 50, after: $after, query: $q) {
           edges { cursor node { customer { id } } }
           pageInfo { hasNextPage }
         }
       }`,
      {
        after: cursor,
        q: `status:CANCELLED OR status:EXPIRED AND updated_at:>=${cutoffIso}`,
      },
    );
    const conn = data.subscriptionContracts;
    for (const e of conn.edges) {
      if (e.node.customer?.id) customers.add(e.node.customer.id);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.edges[conn.edges.length - 1].cursor;
  }
  return [...customers];
}

async function reconcileBatch(customerGids, concurrency = 3) {
  const results = [];
  const errors = [];
  let idx = 0;
  async function worker() {
    while (idx < customerGids.length) {
      const gid = customerGids[idx++];
      try {
        results.push(await reconcileCustomer(gid));
      } catch (e) {
        errors.push({ gid, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, errors };
}

async function runNightlyReconciliation() {
  const started = Date.now();
  console.log("[CRON] starting nightly reconciliation");

  const [active, tagged, recent] = await Promise.all([
    fetchCustomersWithActiveContracts(),
    fetchVipTaggedCustomers(),
    fetchCustomersInReengagementWindow(),
  ]);

  const set = new Set([...active, ...tagged, ...recent]);
  const all = [...set];
  console.log(
    `[CRON] candidates: active=${active.length} tagged=${tagged.length} ` +
      `recent=${recent.length} union=${all.length}`,
  );

  const { results, errors } = await reconcileBatch(all, 3);
  const changed = results.filter((r) => r.added || r.removed.length);
  console.log(
    `[CRON] done in ${Date.now() - started}ms. ` +
      `changed=${changed.length} errors=${errors.length} total=${results.length}`,
  );
  if (errors.length)
    console.error("[CRON] errors sample:", errors.slice(0, 10));
  return { changed, errors, total: results.length };
}

module.exports = {
  runNightlyReconciliation,
  fetchCustomersWithActiveContracts,
  fetchVipTaggedCustomers,
  fetchCustomersInReengagementWindow,
};
