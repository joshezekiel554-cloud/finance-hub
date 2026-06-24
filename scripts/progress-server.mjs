// Tiny progress tracker server. Serves a live-refreshing HTML view of
// the markdown progress file. Used during inline plan execution so the
// operator can watch progress without tailing files.
//
// Run: node scripts/progress-server.mjs
// View: http://localhost:3939

import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROGRESS_PATH = path.join(
  ROOT,
  "docs/superpowers/plans/2026-05-26-ai-on-demand-progress.md",
);
const PORT = 3939;

function escape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Tiny markdown → HTML. Handles headings, bullets (incl. checkboxes),
// inline code, code fences, bold, italics, links. Enough for our trackers.
function mdToHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let inList = false;

  function closeList() {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  }
  function inline(s) {
    let t = escape(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    t = t.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank">$1</a>',
    );
    return t;
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("```")) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuf = [];
      } else {
        out.push(
          `<pre><code class="lang-${codeLang}">${escape(codeBuf.join("\n"))}</code></pre>`,
        );
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const chk = line.match(/^- \[( |x|X)\]\s+(.*)$/);
    if (chk) {
      if (!inList) {
        out.push('<ul class="checklist">');
        inList = true;
      }
      const done = chk[1].toLowerCase() === "x";
      out.push(
        `<li class="${done ? "done" : "todo"}"><span class="box">${done ? "✓" : "○"}</span> ${inline(chk[2])}</li>`,
      );
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      out.push("");
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) {
    out.push(
      `<pre><code class="lang-${codeLang}">${escape(codeBuf.join("\n"))}</code></pre>`,
    );
  }
  return out.join("\n");
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI on-demand — Live progress</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 980px; margin: 1.5rem auto; padding: 0 1.5rem 4rem; background: #0d1117; color: #c9d1d9; }
  h1 { border-bottom: 1px solid #30363d; padding-bottom: 0.4em; color: #f0f6fc; font-size: 1.8em; }
  h2 { color: #58a6ff; margin-top: 1.8em; border-bottom: 1px solid #21262d; padding-bottom: 0.2em; font-size: 1.3em; }
  h3 { color: #d29922; margin-top: 1.3em; font-size: 1.1em; }
  h4 { color: #f0f6fc; margin-top: 1em; font-size: 1em; }
  a { color: #58a6ff; }
  ul { padding-left: 1.2rem; }
  ul.checklist { list-style: none; padding-left: 0; }
  ul.checklist li { padding: 3px 0; }
  ul.checklist li.done { color: #7ee787; }
  ul.checklist li.todo { color: #8b949e; }
  .box { display: inline-block; width: 1.3em; text-align: center; font-weight: 700; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 0.88em; color: #ffa657; }
  pre { background: #161b22; padding: 14px; border-radius: 6px; overflow-x: auto; border: 1px solid #21262d; }
  pre code { background: transparent; padding: 0; color: #c9d1d9; font-size: 0.85em; }
  strong { color: #f0f6fc; }
  em { color: #d2a8ff; }
  p { margin: 0.6em 0; }
  .bar { position: sticky; top: 0; z-index: 10; background: #0d1117; padding: 0.6rem 0; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; margin: 0 0 1rem; }
  .status { font-size: 0.85em; padding: 4px 10px; border-radius: 12px; background: #238636; color: white; font-weight: 600; }
  .status.stale { background: #da3633; }
  .status.idle { background: #6e7681; }
  .meta { font-size: 0.8em; color: #8b949e; }
</style>
</head>
<body>
<div class="bar">
  <span class="meta">AI on-demand · live progress</span>
  <span class="status" id="status">connecting…</span>
</div>
<div id="content"><p>Loading…</p></div>
<script>
let lastMtime = 0;
async function refresh() {
  try {
    const r = await fetch('/api/progress?_=' + Date.now());
    if (!r.ok) throw new Error('http ' + r.status);
    const { html, mtime, exists } = await r.json();
    document.getElementById('content').innerHTML = exists
      ? html
      : '<p>Waiting for the implementer to create the progress file…</p>';
    const s = document.getElementById('status');
    if (!exists) {
      s.textContent = 'awaiting start';
      s.className = 'status idle';
    } else {
      const ageS = Math.max(0, Math.floor((Date.now() - mtime) / 1000));
      const ageLabel = ageS < 60 ? ageS + 's ago' : Math.floor(ageS / 60) + 'm ago';
      s.textContent = 'updated ' + ageLabel;
      s.className = ageS < 120 ? 'status' : 'status idle';
    }
  } catch (e) {
    const s = document.getElementById('status');
    s.textContent = 'disconnected';
    s.className = 'status stale';
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(PAGE);
    return;
  }
  if (req.url?.startsWith("/api/progress")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const s = await stat(PROGRESS_PATH);
      const md = await readFile(PROGRESS_PATH, "utf8");
      res.end(
        JSON.stringify({
          exists: true,
          mtime: s.mtimeMs,
          html: mdToHtml(md),
        }),
      );
    } catch {
      res.end(JSON.stringify({ exists: false, mtime: 0, html: "" }));
    }
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`Progress tracker live at http://localhost:${PORT}`);
});
