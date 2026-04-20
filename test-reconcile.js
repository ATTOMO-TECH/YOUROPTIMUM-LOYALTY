// test-reconcile.js — reconcile one customer by numeric ID.
// Usage:  node test-reconcile.js 1234567890
require("dotenv").config();
const {
  reconcileCustomer,
  getAllContractsForCustomer,
  decideTag,
} = require("./vipClub");

(async () => {
  const numericId = process.argv[2];
  if (!numericId) {
    console.error("Usage: node test-reconcile.js <customer_numeric_id>");
    process.exit(1);
  }
  const gid = `gid://shopify/Customer/${numericId}`;
  console.log("Reconciling", gid);

  try {
    const contracts = await getAllContractsForCustomer(gid);
    console.log(`\nFound ${contracts.length} contract(s):`);
    for (const c of contracts) {
      const ageDays = Math.floor(
        (Date.now() - new Date(c.createdAt).getTime()) / 86400000,
      );
      console.log(`  - ${c.id}`);
      console.log(`    status: ${c.status}, age: ${ageDays}d`);
      console.log(
        `    billing: ${c.billingPolicy.interval}:${c.billingPolicy.intervalCount}`,
      );
      console.log(`    createdAt: ${c.createdAt}, updatedAt: ${c.updatedAt}`);
    }

    const desired = decideTag(contracts);
    console.log(`\nDesired tag: ${desired || "(none)"}`);

    console.log("\nApplying reconciliation...");
    const result = await reconcileCustomer(gid);
    console.log("Result:", result);
    console.log("\n✅ Done");
  } catch (e) {
    console.error("❌ FAILED");
    console.error(e.message);
    process.exit(1);
  }
})();
