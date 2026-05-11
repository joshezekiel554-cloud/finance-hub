// Extensiv warehouse export file builder.
//
// Generates a 15-column tab-delimited text file matching the format expected
// by Extensiv (formerly 3PL Central). The format is taken directly from the
// desktop app's excel_generator.py which defines:
//
//   cols[0] = Ref #         (customer + season + "returns")
//   cols[1] = (empty)
//   cols[2] = (empty)
//   cols[3] = Notes
//   cols[4] = SKU
//   cols[5] = Quantity
//   cols[6..14] = (empty)  — warehouse-side fields filled by Extensiv
//
// The file has NO header row — the desktop app's generate_rma_file writes
// only item rows. One row per return item. Columns are separated by \t,
// rows by \n.
//
// Filename convention (this module, not desktop app): safe for all OSes,
// both customer and season names are slugged to lowercase alphanumeric + hyphen.

export type ExtensivExportInput = {
  rma: { rmaNumber: string | null; extensivRef: string | null };
  customer: {
    name: string;
    qbCustomerId: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      zip?: string;
    };
  };
  season: { name: string };
  items: Array<{ sku: string; name: string; quantity: string }>;
};

export type ExtensivExportFile = {
  filename: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NUM_COLUMNS = 15;

/** Slugify a string: lowercase, replace non-alphanumeric runs with "-", trim. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Strip column-breaking whitespace (\t, \r, \n) from a value before it's
 * dropped into a tab-delimited row. The Extensiv warehouse parser splits
 * on \t and \n; an embedded tab in a customer name (sometimes pasted in
 * from QBO with stray whitespace) silently shifts every downstream column
 * by one and the import either fails or misaligns SKU + quantity.
 *
 * Applied defensively to EVERY column value, not just the high-risk ones,
 * so future changes to the row layout remain safe.
 */
function sanitize(v: string): string {
  return v.replace(/[\t\r\n]+/g, " ").trim();
}

/**
 * Build the Extensiv ref string: "{customer} {season} returns"
 * Matches _make_ref() in excel_generator.py.
 */
function buildRef(customerName: string, seasonName: string): string {
  const parts = [customerName];
  if (seasonName) parts.push(seasonName);
  parts.push("returns");
  return parts.join(" ");
}

/**
 * Build a single tab-delimited row with all 15 columns.
 * Matches _build_row() in excel_generator.py.
 *
 * col 0 = ref#
 * col 3 = notes
 * col 4 = sku
 * col 5 = quantity
 * cols 1,2,6..14 = empty
 *
 * Every value is sanitized to strip embedded tabs/newlines that would
 * misalign the warehouse-side parser.
 */
function buildRow(ref: string, notes: string, sku: string, quantity: string): string {
  const cols: string[] = Array(NUM_COLUMNS).fill("");
  cols[0] = sanitize(ref);
  cols[3] = sanitize(notes);
  cols[4] = sanitize(sku);
  cols[5] = sanitize(quantity);
  return cols.join("\t");
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export function buildExtensivExportFile(
  input: ExtensivExportInput,
): ExtensivExportFile {
  const { rma, customer, season, items } = input;

  // Ref is either the stored extensivRef (if already set) or freshly built.
  const ref =
    rma.extensivRef && rma.extensivRef.trim()
      ? rma.extensivRef.trim()
      : buildRef(customer.name, season.name);

  // Notes: customer name (mirrors generate_multi_rma_file in desktop app)
  const notes = `Customer: ${customer.name}`;

  // Build one row per item.
  const rows = items.map((item) =>
    buildRow(ref, notes, item.sku, item.quantity),
  );

  // Filename: {customer_slug}_{season_slug}_returns.txt
  const customerSlug = slugify(customer.name);
  const seasonSlug = slugify(season.name);
  const filename = `${customerSlug}_${seasonSlug}_returns.txt`;

  return {
    filename,
    content: rows.join("\n"),
  };
}
