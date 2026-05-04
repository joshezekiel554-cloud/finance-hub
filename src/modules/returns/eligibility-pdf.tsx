// Eligibility Report PDF generator.
//
// Renders a branded PDF that shows the customer's seasonal return eligibility
// breakdown — whether a proposed RMA passes or exceeds the threshold. Used
// for denial emails and override-approval records.
//
// Uses @react-pdf/renderer, mirroring the pattern in statements/pdf.tsx.
// Returns a Buffer; the caller saves to Drive or attaches to email.

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import * as React from "react";
import type { RmaItemClassification } from "../../db/schema/returns.js";
import type { EligibilityBreakdown } from "./eligibility.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EligibilityPdfInput = {
  rma: { id: string; rmaNumber: string | null };
  customer: { name: string };
  season: { name: string };
  breakdown: EligibilityBreakdown;
  items: Array<{
    sku: string;
    name: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    classification: RmaItemClassification;
    priorSeasonId?: string | null;
  }>;
};

// ---------------------------------------------------------------------------
// Colors (matching the statement PDF palette)
// ---------------------------------------------------------------------------

const COLOR_TITLE = "#5B9BD5";
const COLOR_TEXT = "#1F2937";
const COLOR_LABEL = "#6B7280";
const COLOR_BORDER = "#E5E7EB";
const COLOR_TABLE_HEADER_BG = "#5B9BD5";
const COLOR_TABLE_HEADER_TEXT = "#FFFFFF";
const COLOR_ROW_ALT = "#F8F8F8";
const COLOR_PASS = "#16A34A";
const COLOR_FAIL = "#DC2626";
const COLOR_WARNING_BG = "#FEF9C3";
const COLOR_INFO_BG = "#F0F9FF";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: COLOR_TEXT,
    paddingTop: 36,
    paddingBottom: 64,
    paddingHorizontal: 36,
  },
  title: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    color: COLOR_TITLE,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: COLOR_LABEL,
    marginBottom: 16,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  metaBlock: {
    flexDirection: "column",
    flex: 1,
  },
  metaLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: COLOR_LABEL,
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  metaValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
  },
  // Summary verdict box
  verdictBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderRadius: 3,
    padding: 10,
    marginBottom: 16,
    flexDirection: "column",
  },
  verdictHeader: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  verdictPass: {
    color: COLOR_PASS,
  },
  verdictFail: {
    color: COLOR_FAIL,
  },
  verdictRow: {
    flexDirection: "row",
    marginBottom: 3,
  },
  verdictLabel: {
    fontSize: 9,
    color: COLOR_LABEL,
    width: "55%",
  },
  verdictValue: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    flex: 1,
    textAlign: "right",
  },
  // Section header
  sectionHeader: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: COLOR_TITLE,
    marginTop: 14,
    marginBottom: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR_BORDER,
    paddingBottom: 3,
  },
  // Table
  tableHeader: {
    flexDirection: "row",
    backgroundColor: COLOR_TABLE_HEADER_BG,
    color: COLOR_TABLE_HEADER_TEXT,
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    paddingVertical: 5,
    paddingHorizontal: 4,
    letterSpacing: 0.2,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR_BORDER,
    minHeight: 16,
  },
  tableRowAlt: {
    backgroundColor: COLOR_ROW_ALT,
  },
  cell: {
    fontSize: 8.5,
    paddingHorizontal: 2,
  },
  cellRight: {
    fontSize: 8.5,
    paddingHorizontal: 2,
    textAlign: "right",
  },
  cellHeader: {
    fontSize: 8,
    paddingHorizontal: 2,
    color: COLOR_TABLE_HEADER_TEXT,
  },
  cellHeaderRight: {
    fontSize: 8,
    paddingHorizontal: 2,
    color: COLOR_TABLE_HEADER_TEXT,
    textAlign: "right",
  },
  // Prior season warning band
  warningRow: {
    backgroundColor: COLOR_WARNING_BG,
  },
  warningTag: {
    fontSize: 7,
    color: "#92400E",
    fontFamily: "Helvetica-Bold",
  },
  // Non-seasonal info band
  infoRow: {
    backgroundColor: COLOR_INFO_BG,
  },
  infoNote: {
    fontSize: 8,
    color: COLOR_LABEL,
    fontStyle: "italic",
    marginTop: 4,
  },
  // Math footer
  mathFooter: {
    marginTop: 16,
    padding: 10,
    backgroundColor: COLOR_ROW_ALT,
    borderWidth: 0.5,
    borderColor: COLOR_BORDER,
    borderRadius: 2,
  },
  mathFooterTitle: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  mathFooterText: {
    fontSize: 9,
    lineHeight: 1.5,
  },
  pageNumber: {
    position: "absolute",
    fontSize: 8,
    bottom: 24,
    left: 36,
    right: 36,
    textAlign: "center",
    color: COLOR_LABEL,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function fmtMoney(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function fmtPct(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return n.toFixed(2) + "%";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VerdictBox({
  breakdown,
}: {
  breakdown: EligibilityBreakdown;
}): React.ReactElement {
  const pass = breakdown.passesThreshold;
  return (
    <View style={styles.verdictBox}>
      <Text
        style={[
          styles.verdictHeader,
          pass ? styles.verdictPass : styles.verdictFail,
        ]}
      >
        {pass ? "ELIGIBLE — WITHIN THRESHOLD" : "OVER THRESHOLD — APPROVAL REQUIRED"}
      </Text>
      {[
        {
          label: "Customer seasonal purchases:",
          value: fmtMoney(breakdown.customerSeasonalPurchases),
        },
        {
          label: "Already returned this season:",
          value: fmtMoney(breakdown.alreadyReturnedThisSeason),
        },
        {
          label: "Proposed (counting toward threshold):",
          value: fmtMoney(breakdown.proposedSubtotalCountingTowardThreshold),
        },
        {
          label: "Total returns this season:",
          value: fmtMoney(breakdown.totalReturnsThisSeason),
        },
        {
          label: "Cumulative return %:",
          value: fmtPct(breakdown.cumulativeReturnPct),
        },
        {
          label: "Threshold:",
          value: fmtPct(breakdown.thresholdPct),
        },
      ].map((r, i) => (
        <View key={`vr-${i}`} style={styles.verdictRow}>
          <Text style={styles.verdictLabel}>{r.label}</Text>
          <Text
            style={[
              styles.verdictValue,
              i === 5 && !pass ? styles.verdictFail : {},
            ]}
          >
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PurchasesTable({
  perInvoice,
}: {
  perInvoice: EligibilityBreakdown["perInvoice"];
}): React.ReactElement {
  if (perInvoice.length === 0) {
    return (
      <Text style={styles.infoNote}>No seasonal purchases found on file.</Text>
    );
  }
  return (
    <View>
      <View style={styles.tableHeader}>
        <Text style={[styles.cellHeader, { width: "30%" }]}>INVOICE #</Text>
        <Text style={[styles.cellHeader, { width: "35%" }]}>DATE</Text>
        <Text style={[styles.cellHeaderRight, { width: "35%" }]}>
          SEASONAL AMOUNT
        </Text>
      </View>
      {perInvoice.map((row, i) => (
        <View
          key={`pi-${i}`}
          style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}
          wrap={false}
        >
          <Text style={[styles.cell, { width: "30%" }]}>
            {row.invoiceDocNumber}
          </Text>
          <Text style={[styles.cell, { width: "35%" }]}>
            {row.invoiceDate}
          </Text>
          <Text style={[styles.cellRight, { width: "35%" }]}>
            {fmtMoney(row.amount)}
          </Text>
        </View>
      ))}
    </View>
  );
}

type ItemRow = EligibilityPdfInput["items"][number];

function ItemsTable({
  items,
  title,
  note,
  rowStyle,
}: {
  items: ItemRow[];
  title: string;
  note?: string;
  rowStyle?: object;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <View>
      <Text style={styles.sectionHeader}>{title}</Text>
      {note ? <Text style={styles.infoNote}>{note}</Text> : null}
      <View style={styles.tableHeader}>
        <Text style={[styles.cellHeader, { width: "15%" }]}>SKU</Text>
        <Text style={[styles.cellHeader, { width: "38%" }]}>DESCRIPTION</Text>
        <Text style={[styles.cellHeaderRight, { width: "10%" }]}>QTY</Text>
        <Text style={[styles.cellHeaderRight, { width: "15%" }]}>UNIT</Text>
        <Text style={[styles.cellHeaderRight, { width: "22%" }]}>TOTAL</Text>
      </View>
      {items.map((item, i) => (
        <View
          key={`it-${i}`}
          style={[
            styles.tableRow,
            i % 2 === 1 ? styles.tableRowAlt : {},
            rowStyle ?? {},
          ]}
          wrap={false}
        >
          <Text style={[styles.cell, { width: "15%" }]}>{item.sku}</Text>
          <View style={[{ width: "38%", paddingHorizontal: 2 }]}>
            <Text style={styles.cell}>{item.name}</Text>
            {item.classification === "seasonal_prior" ? (
              <Text style={styles.warningTag}>PRIOR SEASON</Text>
            ) : null}
          </View>
          <Text style={[styles.cellRight, { width: "10%" }]}>
            {item.quantity}
          </Text>
          <Text style={[styles.cellRight, { width: "15%" }]}>
            {fmtMoney(item.unitPrice)}
          </Text>
          <Text style={[styles.cellRight, { width: "22%" }]}>
            {fmtMoney(item.lineTotal)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function MathFooter({
  breakdown,
}: {
  breakdown: EligibilityBreakdown;
}): React.ReactElement {
  const pctDisplay = fmtPct(breakdown.cumulativeReturnPct);
  const threshDisplay = fmtPct(breakdown.thresholdPct);
  const math = `(${fmtMoney(breakdown.alreadyReturnedThisSeason)} already returned + ${fmtMoney(breakdown.proposedSubtotalCountingTowardThreshold)} proposed) / ${fmtMoney(breakdown.customerSeasonalPurchases)} seasonal purchases = ${pctDisplay} vs ${threshDisplay} threshold`;
  return (
    <View style={styles.mathFooter}>
      <Text style={styles.mathFooterTitle}>Eligibility Calculation</Text>
      <Text style={styles.mathFooterText}>{math}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Document component
// ---------------------------------------------------------------------------

function EligibilityDocument({
  input,
  generatedAt,
}: {
  input: EligibilityPdfInput;
  generatedAt: Date;
}): React.ReactElement {
  const { rma, customer, season, breakdown, items } = input;
  const rmaLabel = rma.rmaNumber ?? "Draft";

  const currentItems = items.filter((i) => i.classification === "seasonal_current");
  const priorItems = items.filter((i) => i.classification === "seasonal_prior");
  const nonSeasonalItems = items.filter(
    (i) => i.classification === "non_seasonal" || i.classification === "damage",
  );

  return (
    <Document
      title={`Eligibility Report — RMA ${rmaLabel}`}
      author="Finance Hub"
      creator="Finance Hub 2.0"
    >
      <Page size="A4" style={styles.page} wrap>
        {/* Header */}
        <Text style={styles.title}>Eligibility Report — RMA {rmaLabel}</Text>
        <Text style={styles.subtitle}>Generated {fmtDate(generatedAt)}</Text>

        {/* Meta row */}
        <View style={styles.metaRow}>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>CUSTOMER</Text>
            <Text style={styles.metaValue}>{customer.name}</Text>
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>SEASON</Text>
            <Text style={styles.metaValue}>{season.name}</Text>
          </View>
        </View>

        {/* Verdict box */}
        <VerdictBox breakdown={breakdown} />

        {/* Table 1: Purchases */}
        <Text style={styles.sectionHeader}>
          Customer Seasonal Purchases This Season
        </Text>
        <PurchasesTable perInvoice={breakdown.perInvoice} />

        {/* Table 2: Current-season proposed returns */}
        <ItemsTable
          items={currentItems}
          title="Proposed Returns — Current Season"
        />

        {/* Table 3: Prior-season items (only if any) */}
        <ItemsTable
          items={priorItems}
          title="Proposed Returns — Prior Season Items"
          note="Prior-season items count toward the cumulative return threshold."
          rowStyle={styles.warningRow}
        />

        {/* Table 4: Non-seasonal items (informational only) */}
        <ItemsTable
          items={nonSeasonalItems}
          title="Non-Seasonal / Damage Items (Informational)"
          note="These items are excluded from the seasonal return threshold calculation."
          rowStyle={styles.infoRow}
        />

        {/* Math footer */}
        <MathFooter breakdown={breakdown} />

        <Text
          style={styles.pageNumber}
          render={({ pageNumber, totalPages }) =>
            totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : ""
          }
          fixed
        />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function generateEligibilityPdf(
  input: EligibilityPdfInput,
): Promise<Buffer> {
  const generatedAt = new Date();
  const buffer = await renderToBuffer(
    <EligibilityDocument input={input} generatedAt={generatedAt} />,
  );
  return buffer;
}
