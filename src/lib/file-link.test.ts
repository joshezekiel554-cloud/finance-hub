import { describe, expect, it } from "vitest";
import { pdfFileName, signQbPdfLink, verifyQbPdfLink } from "./file-link.js";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000;

function sign(over: Partial<Parameters<typeof signQbPdfLink>[0]> = {}) {
  return signQbPdfLink({
    baseUrl: "https://finance.feldart.com",
    secret: SECRET,
    kind: "invoice",
    qbId: "4512",
    name: "Invoice 10234 - Acme Judaica.pdf",
    nowSeconds: NOW,
    ...over,
  });
}

function parts(url: string) {
  const u = new URL(url);
  const [, , , , , kind, qbId] = u.pathname.split("/");
  return { kind: kind!, qbId: qbId!, exp: u.searchParams.get("exp"), name: u.searchParams.get("name"), sig: u.searchParams.get("sig") };
}

describe("signed qb pdf links", () => {
  it("round-trips and carries the file shape the hub renders", () => {
    const f = sign();
    expect(f).toMatchObject({ name: "Invoice 10234 - Acme Judaica.pdf", mime: "application/pdf" });
    expect(f.url.startsWith("https://finance.feldart.com/api/ext/files/qb-pdf/invoice/4512?")).toBe(true);
    expect(f.expiresAt).toBe(new Date((NOW + 900) * 1000).toISOString());
    expect(verifyQbPdfLink({ secret: SECRET, ...parts(f.url), nowSeconds: NOW + 60 })).toEqual({
      kind: "invoice",
      qbId: "4512",
      name: "Invoice 10234 - Acme Judaica.pdf",
    });
  });

  it("refuses expired, tampered, wrong-secret and malformed links", () => {
    const p = parts(sign().url);
    const ok = (over: Partial<typeof p>, nowSeconds = NOW, secret: string | null = SECRET) =>
      verifyQbPdfLink({ secret: secret ?? undefined, ...p, ...over, nowSeconds }) !== null;
    expect(ok({}, NOW + 901)).toBe(false); // expired
    expect(ok({ qbId: "4513" })).toBe(false); // another document
    expect(ok({ kind: "creditmemo" })).toBe(false);
    expect(ok({ name: "Other.pdf" })).toBe(false);
    expect(ok({ exp: String(NOW + 99_999) })).toBe(false); // extended expiry
    expect(ok({}, NOW, "x".repeat(40))).toBe(false);
    expect(ok({}, NOW, null)).toBe(false); // finance not configured
    expect(ok({ kind: "salesreceipt" })).toBe(false);
    expect(ok({ qbId: "../1" })).toBe(false);
    expect(ok({ sig: null })).toBe(false);
  });

  it("makes OS-safe download names", () => {
    expect(pdfFileName('Invoice 1/2 - "A:B" <C>')).toBe("Invoice 12 - AB C.pdf");
    expect(pdfFileName("   ")).toBe("document.pdf");
  });
});
