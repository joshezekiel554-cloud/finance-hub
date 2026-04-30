// Thin Monday.com GraphQL client. Used (for now) only by the one-off
// terms backfill route — after that runs, the operator manages terms
// inside this app and Monday is no longer queried. Keeping the client
// small enough that we don't need a query builder.
//
// Auth: Monday personal access token in env.MONDAY_API_TOKEN (a JWT
// passed verbatim in the Authorization header — no Bearer prefix).
// Rate limits: Monday's complexity-based limit is ~5M points / minute,
// generous enough that a single 140-row sync never approaches it.

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "monday.client" });

const API_URL = "https://api.monday.com/v2";
const API_VERSION = "2024-10";

export class MondayError extends Error {
  constructor(
    message: string,
    public readonly errors?: unknown,
  ) {
    super(message);
    this.name = "MondayError";
  }
}

async function gql<T>(query: string): Promise<T> {
  if (!env.MONDAY_API_TOKEN) {
    throw new MondayError("MONDAY_API_TOKEN not configured");
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.MONDAY_API_TOKEN,
      "API-Version": API_VERSION,
    },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    log.error({ errors: json.errors }, "monday graphql error");
    throw new MondayError("Monday API error", json.errors);
  }
  if (!json.data) {
    throw new MondayError("Monday API returned no data");
  }
  return json.data;
}

// Column-id constants from the live USA Stores Information board.
// Hardcoded because (a) this is a one-off sync, and (b) Monday's column
// ids are stable per-board so an env var would just hide the wiring.
export const TERMS_COLUMN_ID = "text_mks2mxzg";
export const EMAIL_COLUMN_ID = "text_mky1mar9";

export type MondayStoreRow = {
  id: string;
  name: string;
  termsRaw: string | null;
  emailRaw: string | null;
};

type ItemsPageResponse = {
  boards: Array<{
    items_page: {
      cursor: string | null;
      items: Array<{
        id: string;
        name: string;
        column_values: Array<{ id: string; text: string | null }>;
      }>;
    };
  }>;
};

type NextItemsPageResponse = {
  next_items_page: {
    cursor: string | null;
    items: Array<{
      id: string;
      name: string;
      column_values: Array<{ id: string; text: string | null }>;
    }>;
  };
};

// Fetches every row on the board with just the columns we care about.
// items_page caps at 500 / call; the board has ~140 rows so one page
// usually covers it, but we paginate via the cursor for safety.
export async function fetchTermsBoardRows(
  boardId: string,
): Promise<MondayStoreRow[]> {
  const out: MondayStoreRow[] = [];

  // Asking only for the two columns we need keeps the response small.
  // Monday's GraphQL doesn't fail when an id is unknown — it just
  // returns null text — so a typo'd id manifests as silently-empty
  // rather than a 500.
  const colIds = [TERMS_COLUMN_ID, EMAIL_COLUMN_ID]
    .map((id) => `"${id}"`)
    .join(", ");

  let firstPage: ItemsPageResponse;
  try {
    firstPage = await gql<ItemsPageResponse>(`{
      boards(ids: ${boardId}) {
        items_page(limit: 500) {
          cursor
          items {
            id
            name
            column_values(ids: [${colIds}]) { id text }
          }
        }
      }
    }`);
  } catch (err) {
    log.error({ err, boardId }, "fetch initial items_page failed");
    throw err;
  }

  const board = firstPage.boards[0];
  if (!board) throw new MondayError(`board ${boardId} not found`);

  for (const item of board.items_page.items) out.push(toRow(item));

  let cursor = board.items_page.cursor;
  while (cursor) {
    const next: NextItemsPageResponse = await gql(`{
      next_items_page(limit: 500, cursor: "${cursor}") {
        cursor
        items {
          id
          name
          column_values(ids: [${colIds}]) { id text }
        }
      }
    }`);
    for (const item of next.next_items_page.items) out.push(toRow(item));
    cursor = next.next_items_page.cursor;
  }

  log.info({ boardId, rowCount: out.length }, "monday board fetched");
  return out;
}

function toRow(item: {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null }>;
}): MondayStoreRow {
  const byId = new Map<string, string | null>(
    item.column_values.map((c) => [c.id, c.text]),
  );
  return {
    id: item.id,
    name: item.name,
    termsRaw: byId.get(TERMS_COLUMN_ID) ?? null,
    emailRaw: byId.get(EMAIL_COLUMN_ID) ?? null,
  };
}
