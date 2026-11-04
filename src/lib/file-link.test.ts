import { describe, expect, it } from "vitest";
import { pdfFileName, signQbPdfLink, signStoredFileLink, verifyQbPdfLink, verifyStoredFileLink } from "./file-link.js";

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
  const [, , , , kind, qbId] = u.pathname.split("/");
  return { kind: kind!, qbId: qbId!, exp: u.searchParams.get("exp"), name: u.searchParams.get("name"), sig: u.searchParams.get("sig") };
}

describe("signed qb pdf links", () => {
  it("round-trips and carries the file shape the hub renders", () => {
    const f = sign();
    expect(f).toMatchObject({ name: "Invoice 10234 - Acme Judaica.pdf", mime: "application/pdf" });
    expect(f.url.startsWith("https://finance.feldart.com/api/files/qb-pdf/invoice/4512?")).toBe(true);
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

describe("signed stored-file links", () => {
  const FILE = "A".repeat(32);
  const link = () => signStoredFileLink({ baseUrl: "https://f", secret: SECRET, fileId: FILE, name: "Acme, 7105.pdf", mime: "application/pdf", nowSeconds: NOW });
  const parts = (url: string) => {
    const u = new URL(url);
    const fileId = u.pathname.split("/").pop()!;
    return { fileId, exp: u.searchParams.get("exp"), name: u.searchParams.get("name"), sig: u.searchParams.get("sig") };
  };
  it("round-trips", () => {
    const l = link();
    expect(l.url.startsWith(`https://f/api/files/stored/${FILE}?`)).toBe(true);
    expect(verifyStoredFileLink({ secret: [SECRET], ...parts(l.url), nowSeconds: NOW + 1 })).toEqual({ fileId: FILE, name: "Acme, 7105.pdf" });
  });
  it("refuses another file, a renamed download, expiry and a qb-pdf signature", () => {
    const p = parts(link().url);
    const ok = (over: Partial<typeof p>, now = NOW) => verifyStoredFileLink({ secret: SECRET, ...p, ...over, nowSeconds: now }) !== null;
    expect(ok({ fileId: "B".repeat(32) })).toBe(false);
    expect(ok({ name: "Other.pdf" })).toBe(false);
    expect(ok({}, NOW + 901)).toBe(false);
    expect(ok({ fileId: "../etc/passwd" })).toBe(false);
    expect(ok({ sig: new URL(sign().url).searchParams.get("sig") })).toBe(false);
  });
});
