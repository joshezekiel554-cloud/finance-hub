// Artifact tools (spec §3/§9): the agent produces house-styled PDF
// reports and CSV exports from STRUCTURED content. These execute inline
// (no approve gate — artifacts are internal files with no external blast
// radius) and persist to the reports library. Registered category "read"
// because the registry's write category mandates confirmation; the
// side effect is an internal artifact write, audited via agent_reports.

import { z } from "zod";
import type { ToolDefinition } from "../../../integrations/anthropic/tool-registry.js";
import {
  buildCsv,
  renderReportPdf,
  saveAgentReport,
  type ReportContent,
} from "../reports.js";

const reportSchema = z.object({
  title: z.string().min(1).max(256),
  subtitle: z.string().max(256).optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().max(200).optional(),
        text: z.string().max(8000).optional(),
        table: z
          .object({
            columns: z.array(z.string().max(120)).min(1).max(12),
            rows: z.array(z.array(z.string().max(500))).max(500),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(30),
});

const csvSchema = z.object({
  title: z.string().min(1).max(256),
  columns: z.array(z.string().max(120)).min(1).max(40),
  rows: z.array(z.array(z.string().max(2000))).max(5000),
});

export function buildAgentArtifactTools(): ToolDefinition<never>[] {
  return [
    {
      name: "generate_pdf_report",
      description:
        "Generate a house-styled PDF report from structured content (title, sections with optional headings, paragraphs and tables). Saved to the reports library and downloadable by the operator. Use real figures you retrieved with tools.",
      category: "read",
      requiresConfirmation: false,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                heading: { type: "string" },
                text: { type: "string" },
                table: {
                  type: "object",
                  properties: {
                    columns: { type: "array", items: { type: "string" } },
                    rows: {
                      type: "array",
                      items: { type: "array", items: { type: "string" } },
                    },
                  },
                  required: ["columns", "rows"],
                },
              },
            },
          },
        },
        required: ["title", "sections"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const parsed = reportSchema.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid report content" };
        }
        const buffer = await renderReportPdf(parsed.data as ReportContent);
        const saved = await saveAgentReport({
          kind: "pdf",
          title: parsed.data.title,
          conversationId: ctx.conversationId ?? null,
          requestedByUserId: ctx.userId,
          buffer,
        });
        return {
          ok: true,
          output: `PDF report saved (reportId ${saved.id}, "${parsed.data.title}"). Tell the operator it is ready — it appears as a download card in this conversation and in the reports library on the agent page.`,
        };
      },
    },
    {
      name: "export_csv",
      description:
        "Export tabular data as a CSV file (saved to the reports library, downloadable). Use for spreadsheet-style asks.",
      category: "read",
      requiresConfirmation: false,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["title", "columns", "rows"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const parsed = csvSchema.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid csv content" };
        }
        const csv = buildCsv(parsed.data.columns, parsed.data.rows);
        const saved = await saveAgentReport({
          kind: "csv",
          title: parsed.data.title,
          conversationId: ctx.conversationId ?? null,
          requestedByUserId: ctx.userId,
          buffer: Buffer.from(csv, "utf-8"),
        });
        return {
          ok: true,
          output: `CSV export saved (reportId ${saved.id}, "${parsed.data.title}", ${parsed.data.rows.length} rows). It appears as a download card in this conversation and in the reports library.`,
        };
      },
    },
  ];
}
