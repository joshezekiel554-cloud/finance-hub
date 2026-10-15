import { describe, expect, it } from "vitest";
import { filenameFromContentDisposition } from "./content-disposition";

describe("filenameFromContentDisposition", () => {
  it("prefers the UTF-8 filename* form", () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="Caf_ Judaica, 12.pdf"; filename*=UTF-8''Caf%C3%A9%20Judaica%2C%2012.pdf`,
        "x.pdf",
      ),
    ).toBe("Café Judaica, 12.pdf");
  });

  it("falls back to the quoted filename", () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="Acme, 7.pdf"`,
        "x.pdf",
      ),
    ).toBe("Acme, 7.pdf");
  });

  it("falls back to the plain form when filename* is malformed", () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="Acme, 7.pdf"; filename*=UTF-8''%E0%A4%A`,
        "x.pdf",
      ),
    ).toBe("Acme, 7.pdf");
  });

  it("returns the fallback with no header", () => {
    expect(filenameFromContentDisposition(null, "x.pdf")).toBe("x.pdf");
    expect(filenameFromContentDisposition("inline", "x.pdf")).toBe("x.pdf");
  });
});
