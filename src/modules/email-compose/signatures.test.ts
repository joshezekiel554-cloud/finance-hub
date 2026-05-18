import { describe, expect, it } from "vitest";
import { composeSignatureHtml, sanitizeSignatureHtml } from "./signatures";

describe("sanitizeSignatureHtml", () => {
  it("strips <script> tags", () => {
    const input = `<div>hi</div><script>alert(1)</script>`;
    expect(sanitizeSignatureHtml(input)).toBe(`<div>hi</div>`);
  });

  it("strips on* attributes", () => {
    const input = `<a href="https://x.com" onclick="alert(1)">x</a>`;
    expect(sanitizeSignatureHtml(input)).toBe(
      `<a href="https://x.com">x</a>`,
    );
  });

  it("preserves data: URLs inside <img src> but not <a href>", () => {
    const img = `<img src="data:image/png;base64,iVBORw0KGgo=" alt="x" />`;
    expect(sanitizeSignatureHtml(img)).toContain(`src="data:image/png;base64,`);

    const link = `<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">x</a>`;
    expect(sanitizeSignatureHtml(link)).not.toContain("data:");
  });

  it("preserves mailto: and tel: links", () => {
    expect(sanitizeSignatureHtml(`<a href="mailto:x@y.com">x</a>`)).toBe(
      `<a href="mailto:x@y.com">x</a>`,
    );
    expect(sanitizeSignatureHtml(`<a href="tel:+441234567890">call</a>`)).toBe(
      `<a href="tel:+441234567890">call</a>`,
    );
  });

  it("preserves inline color style", () => {
    const input = `<span style="color: red">x</span>`;
    expect(sanitizeSignatureHtml(input)).toContain(`color:red`);
  });

  it("preserves table layout with border-right inline style", () => {
    const input = `<table><tr><td style="border-right: 1px solid #ccc">A</td><td>B</td></tr></table>`;
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain(`<table>`);
    expect(out).toContain(`border-right:1px solid #ccc`);
  });

  it("strips <style> blocks but keeps adjacent inline styles", () => {
    const input = `<style>.x{color:red}</style><div style="color:blue">x</div>`;
    const out = sanitizeSignatureHtml(input);
    expect(out).not.toContain("<style>");
    expect(out).toContain(`color:blue`);
  });

  it("strips javascript: in href", () => {
    expect(
      sanitizeSignatureHtml(`<a href="javascript:alert(1)">x</a>`),
    ).not.toContain("javascript:");
  });

  it("preserves min-width and opacity (used by real signatures)", () => {
    const input = `<div style="min-width: 100px; opacity: 0.8">x</div>`;
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain("min-width:100px");
    expect(out).toContain("opacity:0.8");
  });
});

describe("composeSignatureHtml", () => {
  const body = `<p>Hello</p>`;
  const userSig = `<div>Best, Josh</div>`;
  const aliasSig = `<div>Feldart Ltd</div>`;

  it("returns body alone when no signatures", () => {
    expect(composeSignatureHtml(body, null, null)).toBe(body);
  });

  it("appends user sig with spacer", () => {
    expect(composeSignatureHtml(body, userSig, null)).toBe(
      `${body}<br><br>${userSig}`,
    );
  });

  it("appends alias sig with spacer", () => {
    expect(composeSignatureHtml(body, null, aliasSig)).toBe(
      `${body}<br><br>${aliasSig}`,
    );
  });

  it("appends both with user before alias", () => {
    expect(composeSignatureHtml(body, userSig, aliasSig)).toBe(
      `${body}<br><br>${userSig}<br><br>${aliasSig}`,
    );
  });

  it("treats empty-string sig as no sig (sanitizer can return empty)", () => {
    expect(composeSignatureHtml(body, "", aliasSig)).toBe(
      `${body}<br><br>${aliasSig}`,
    );
  });
});
