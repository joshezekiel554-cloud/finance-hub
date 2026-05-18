import sanitizeHtml from "sanitize-html";

const SIGNATURE_SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "br", "div", "em", "font", "hr", "i", "img",
    "p", "small", "span", "strong",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "u",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel", "style"],
    img: ["src", "alt", "width", "height", "style"],
    table: ["width", "cellpadding", "cellspacing", "border", "style", "align"],
    td: ["width", "valign", "align", "colspan", "rowspan", "style"],
    th: ["width", "valign", "align", "colspan", "rowspan", "style"],
    tr: ["style", "valign"],
    font: ["color", "face", "size"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: {
    img: ["http", "https", "cid", "data"],
  },
  allowedStyles: {
    "*": {
      color: [/^.+$/],
      "background-color": [/^.+$/],
      background: [/^.+$/],
      "font-family": [/^.+$/],
      "font-size": [/^\d+(\.\d+)?(px|em|rem|pt|%)$/],
      "font-weight": [/^.+$/],
      "font-style": [/^.+$/],
      "letter-spacing": [/^.+$/],
      "line-height": [/^.+$/],
      "text-align": [/^(left|right|center|justify)$/],
      "text-decoration": [/^.+$/],
      "text-transform": [/^.+$/],
      "white-space": [/^.+$/],
      opacity: [/^.+$/],

      padding: [/^.+$/],
      "padding-top": [/^.+$/],
      "padding-right": [/^.+$/],
      "padding-bottom": [/^.+$/],
      "padding-left": [/^.+$/],

      margin: [/^.+$/],
      "margin-top": [/^.+$/],
      "margin-right": [/^.+$/],
      "margin-bottom": [/^.+$/],
      "margin-left": [/^.+$/],

      border: [/^.+$/],
      "border-top": [/^.+$/],
      "border-right": [/^.+$/],
      "border-bottom": [/^.+$/],
      "border-left": [/^.+$/],
      "border-width": [/^.+$/],
      "border-style": [/^.+$/],
      "border-color": [/^.+$/],
      "border-radius": [/^.+$/],

      width: [/^.+$/],
      height: [/^.+$/],
      "min-width": [/^.+$/],
      "max-width": [/^.+$/],
      "vertical-align": [/^.+$/],
      display: [/^(block|inline|inline-block|table-cell|none)$/],
    },
  },
};

export const MAX_SIGNATURE_BYTES = 32 * 1024;

export function sanitizeSignatureHtml(input: string): string {
  return sanitizeHtml(input, SIGNATURE_SANITIZE_OPTS);
}
