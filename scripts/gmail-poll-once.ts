// One-shot Gmail backfill. Bypasses BullMQ; calls pollNewEmails() directly
// with a long initialLookbackDays so the first-time population covers
// historical email rather than the worker's default 7-day window.
//
// After this completes, the worker's repeatable gmail-poll job (every
// 15 min) takes over and pulls only deltas via the lastPollAt cursor
// stored in oauth_tokens.meta — so re-running this isn't necessary
// once the worker is up.
import "dotenv/config";
import { pollNewEmails } from "../src/integrations/gmail/poller.js";

const DEFAULT_LOOKBACK_DAYS = 180;
const DEFAULT_MAX_RESULTS = 50000;

async function main() {
  const lookback = Number(
    process.env.LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS,
  );
  const maxResults = Number(
    process.env.MAX_RESULTS ?? DEFAULT_MAX_RESULTS,
  );

  console.log(
    `→ pollNewEmails(initialLookbackDays=${lookback}, maxResults=${maxResults})…`,
  );
  const t0 = Date.now();
  const result = await pollNewEmails({
    initialLookbackDays: lookback,
    maxResults,
  });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log("  fetched:           ", result.fetched);
  console.log("  inserted:          ", result.inserted);
  console.log("  matched:           ", result.matched);
  console.log("  activitiesCreated: ", result.activitiesCreated);
  console.log("  cursorAdvancedTo:  ", result.cursorAdvancedTo);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
