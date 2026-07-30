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
// Filename convention (this module, not desktop app), operator-specified
// 2026-07-30:
//
//   "{Store name} Returns - {Seasonal|Non Seasonal|Damage} - {MM-DD-YY}.txt"
//
// The store name keeps its real capitalisation and spacing (it is what the
// warehouse reads); only characters a filesystem rejects are stripped. The
// date is the US format the warehouse expects, taken on the operator's own
// day rather than the server's, so a file generated late in the UK evening
// doesn't land on the previous date.

export type ExtensivExportInput = {
  rma: {
    rmaNumber: string | null;
    extensivRef: string | null;
    returnType?: RmaReturnTypeLike;
  };
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
  /** When the file was generated. Defaults to now; injectable for tests. */
  generatedAt?: Date;
  /** IANA zone the filename date is read in. Defaults to the team's own day. */
  timeZone?: string;
};

// Mirrors RMA_RETURN_TYPES in db/schema/returns.ts. Kept structural rather
// than imported so this builder stays a pure, schema-free module.
export type RmaReturnTypeLike = "damage" | "seasonal" | "non_seasonal";

export type ExtensivExportFile = {
  filename: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NUM_COLUMNS = 15;

const DEFAULT_FILENAME_TIME_ZONE = "Europe/London";

/**
 * Strip only what a filesystem rejects — Windows bans \ / : * ? " < > | and
 * control characters — then collapse whitespace. Capitalisation and spacing
 * survive, because the warehouse reads the store name off the filename.
 */
export function sanitizeFilenamePart(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Seasonal" / "Non Seasonal" / "Damage" for the filename. */
export function returnTypeLabel(type: RmaReturnTypeLike | undefined): string {
  if (type === "non_seasonal") return "Non Seasonal";
  if (type === "damage") return "Damage";
  return "Seasonal";
}

/**
 * US-format date for the filename: MM-DD-YY. Read in `timeZone` so the date
 * matches the day the operator is actually having, not the server's UTC day.
 */
export function formatUsFilenameDate(
  d: Date,
  timeZone: string = DEFAULT_FILENAME_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}-${get("day")}-${get("year")}`;
}

/**
 * "{Store name} Returns - {Seasonal|Non Seasonal|Damage} - {MM-DD-YY}.txt"
 */
export function buildExtensivFilename(input: {
  customerName: string;
  returnType: RmaReturnTypeLike | undefined;
  generatedAt: Date;
  timeZone?: string;
}): string {
  return `${buildExtensivRef(input)}.txt`;
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
 * Build the Extensiv ref string (column A), operator-specified 2026-07-30:
 *
 *   "{Store name} Returns - {Seasonal|Non Seasonal|Damage} - {MM-DD-YY}"
 *
 * Same string as the filename, minus the extension — the warehouse reads the
 * two together. Superseded the old "{customer} {season} returns" form
 * (_make_ref() in the desktop app's excel_generator.py).
 *
 * IMPORTANT: rma-service.ts stores this on the RMA when the export is first
 * generated, and inbound Extensiv receipts are matched back by exact string
 * equality on that stored value. Both writers must therefore produce the
 * identical string, which is why they share this one function — and why the
 * date is passed in rather than read from the clock here, so a re-download
 * can reproduce a ref byte-for-byte.
 */
export function buildExtensivRef(input: {
  customerName: string;
  returnType: RmaReturnTypeLike | undefined;
  generatedAt: Date;
  timeZone?: string;
}): string {
  const store = sanitizeFilenamePart(input.customerName) || "Customer";
  const label = returnTypeLabel(input.returnType);
  const date = formatUsFilenameDate(input.generatedAt, input.timeZone);
  return `${store} Returns - ${label} - ${date}`;
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
  const { rma, customer, items } = input;
  const generatedAt = input.generatedAt ?? new Date();

  // The STORED ref wins whenever it exists. Re-downloading an RMA that went
  // to the warehouse under the old "{customer} {season} returns" form must
  // still emit that ref, or the receipt Extensiv echoes back stops matching.
  const ref =
    rma.extensivRef && rma.extensivRef.trim()
      ? rma.extensivRef.trim()
      : buildExtensivRef({
          customerName: customer.name,
          returnType: rma.returnType,
          generatedAt,
          timeZone: input.timeZone,
        });

  // Notes: customer name (mirrors generate_multi_rma_file in desktop app)
  const notes = `Customer: ${customer.name}`;

  // Build one row per item.
  const rows = items.map((item) =>
    buildRow(ref, notes, item.sku, item.quantity),
  );

  const filename = buildExtensivFilename({
    customerName: customer.name,
    returnType: rma.returnType,
    generatedAt,
    timeZone: input.timeZone,
  });

  return {
    filename,
    content: rows.join("\n"),
  };
}
