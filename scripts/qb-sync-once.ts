// One-shot QB sync runner. Bypasses BullMQ; runs syncCustomers + syncInvoices
// + syncPayments + syncCreditMemos in order against the local DB. Used to
// bootstrap data for week 6 CRM work and to validate the QB token refresh
// fix (f30526e) at scale.
import "dotenv/config";
import { QboClient } from "../src/integrations/qb/client.js";
import {
  syncCustomers,
  syncInvoices,
  syncPayments,
  syncCreditMemos,
} from "../src/integrations/qb/sync.js";

async function main() {
  const t0 = Date.now();
  const client = new QboClient();

  console.log("→ syncCustomers…");
  const customers = await syncCustomers(client);
  console.log("  ", customers);

  console.log("→ syncInvoices…");
  const invoices = await syncInvoices(client);
  console.log("  ", invoices);

  console.log("→ syncPayments…");
  const payments = await syncPayments(client);
  console.log("  ", payments);

  console.log("→ syncCreditMemos…");
  const creditMemos = await syncCreditMemos(client);
  console.log("  ", creditMemos);

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
