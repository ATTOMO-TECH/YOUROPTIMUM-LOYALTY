// dry-run.js — reports what nightly reconciliation WOULD do, without touching tags.
// Usage:  node dry-run.js
require("dotenv").config();
const { shopifyGraphQL } = require("./shopifyAuth");
const {
  decideTag,
  getSubscriptionOrdersForCustomer,
  VIP_TAGS,
} = require("./vipClub");
const {
  fetchCustomersWithActiveContracts,
  fetchVipTaggedCustomers,
  fetchCustomersInReengagementWindow,
} = require("./nigthlyReconcile");

async function getCustomerTags(gid) {
  const d = await shopifyGraphQL(
    `query($id: ID!) { customer(id: $id) { id tags } }`,
    { id: gid },
  );
  return d.customer?.tags || [];
}

(async () => {
  console.log("Collecting candidate customers...");
  const [active, tagged, recent] = await Promise.all([
    fetchCustomersWithActiveContracts(),
    fetchVipTaggedCustomers(),
    fetchCustomersInReengagementWindow(),
  ]);
  const all = [...new Set([...active, ...tagged, ...recent])];
  console.log(
    `Active: ${active.length}, tagged: ${tagged.length}, recent: ${recent.length}, union: ${all.length}\n`,
  );

  const wouldAdd = [];
  const wouldRemove = [];
  const wouldKeep = [];
  const errors = [];

  for (const gid of all) {
    try {
      const [contracts, currentTags] = await Promise.all([
        getSubscriptionOrdersForCustomer(gid),
        getCustomerTags(gid),
      ]);
      const desired = decideTag(contracts);
      const currentVip = currentTags.filter((t) => VIP_TAGS.includes(t));

      const toRemove = currentVip.filter((t) => t !== desired);
      const toAdd = desired && !currentVip.includes(desired) ? desired : null;

      if (toAdd) wouldAdd.push({ gid, tag: toAdd, currentVip });
      if (toRemove.length) wouldRemove.push({ gid, tags: toRemove, desired });
      if (!toAdd && !toRemove.length && desired)
        wouldKeep.push({ gid, tag: desired });
    } catch (e) {
      errors.push({ gid, error: e.message });
    }
  }

  console.log("--- DRY RUN REPORT ---");
  console.log(`Would ADD tags: ${wouldAdd.length}`);
  wouldAdd.slice(0, 20).forEach((x) => console.log(`  + ${x.gid} → ${x.tag}`));
  if (wouldAdd.length > 20)
    console.log(`  ... and ${wouldAdd.length - 20} more`);

  console.log(`\nWould REMOVE tags: ${wouldRemove.length}`);
  wouldRemove
    .slice(0, 20)
    .forEach((x) =>
      console.log(
        `  - ${x.gid}: remove ${x.tags.join(", ")} (desired: ${x.desired || "none"})`,
      ),
    );
  if (wouldRemove.length > 20)
    console.log(`  ... and ${wouldRemove.length - 20} more`);

  console.log(`\nAlready correct: ${wouldKeep.length}`);
  console.log(`\nErrors: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log(`  ! ${e.gid}: ${e.error}`));

  console.log("\nNo changes applied.");
})();
