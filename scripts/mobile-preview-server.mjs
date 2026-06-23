// Standalone preview server for the mobile redesign.
// Three pages (Today / Customers / Customer detail), each with multiple
// states accessible via toggle chips. Option A direction throughout.
//
// Run:  node scripts/mobile-preview-server.mjs
// View: http://localhost:3940

import http from "node:http";

const PORT = 3940;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Finance Hub — mobile preview</title>
<style>
  :root {
    color-scheme: dark;
    --bg: oklch(0.18 0.005 60);
    --surface: oklch(0.22 0.006 60);
    --elevated: oklch(0.26 0.007 60);
    --strong: oklch(0.30 0.008 60);
    --border: oklch(0.32 0.008 60);
    --primary: oklch(0.96 0.005 60);
    --secondary: oklch(0.74 0.01 60);
    --muted: oklch(0.58 0.01 60);
    --accent: oklch(0.70 0.16 55);
    --accent-soft: oklch(0.70 0.16 55 / 0.12);
    --success: oklch(0.72 0.13 145);
    --success-soft: oklch(0.72 0.13 145 / 0.14);
    --warning: oklch(0.78 0.14 80);
    --warning-soft: oklch(0.78 0.14 80 / 0.14);
    --danger: oklch(0.65 0.18 25);
    --danger-soft: oklch(0.65 0.18 25 / 0.14);
    --info: oklch(0.70 0.12 230);
    --info-soft: oklch(0.70 0.12 230 / 0.14);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--bg); color: var(--primary); }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 1.8rem 1.5rem 6rem; }

  /* Page header */
  header.page { max-width: 880px; margin: 0 auto 1.4rem; }
  header.page h1 { font-size: 1.5rem; letter-spacing: -0.01em; margin-bottom: 0.3rem; }
  header.page p { color: var(--secondary); max-width: 65ch; font-size: 0.86rem; }

  /* Top tabs */
  .top-tabs {
    max-width: 880px;
    margin: 0 auto 1.4rem;
    display: flex;
    gap: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 4px;
    border-radius: 10px;
  }
  .top-tabs button {
    flex: 1;
    background: transparent;
    border: 0;
    color: var(--secondary);
    font: inherit;
    font-size: 0.86rem;
    padding: 8px 12px;
    border-radius: 7px;
    cursor: pointer;
  }
  .top-tabs button.on {
    background: var(--elevated);
    color: var(--primary);
    font-weight: 500;
  }

  /* State chips */
  .state-row {
    max-width: 880px;
    margin: 0 auto 1.2rem;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
  }
  .state-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--secondary);
    font: inherit;
    font-size: 0.78rem;
    padding: 6px 12px;
    border-radius: 999px;
    cursor: pointer;
  }
  .state-btn.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  /* Phone frame */
  .stage { display: flex; flex-direction: column; align-items: center; gap: 1.5rem; }
  .phone {
    width: 390px;
    height: 780px;
    border: 1px solid var(--border);
    border-radius: 42px;
    padding: 10px;
    background: oklch(0.13 0.004 60);
    box-shadow: 0 30px 60px -20px oklch(0 0 0 / 0.55);
    position: relative;
    flex-shrink: 0;
  }
  .phone::before {
    content: '';
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    width: 120px;
    height: 26px;
    background: oklch(0.10 0.003 60);
    border-radius: 14px;
    z-index: 2;
  }
  .screen {
    width: 100%;
    height: 100%;
    background: var(--bg);
    border-radius: 32px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .status-bar {
    height: 38px;
    padding: 8px 22px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.74rem;
    color: var(--secondary);
    flex-shrink: 0;
  }
  .status-bar .time { font-weight: 600; color: var(--primary); }
  .status-bar .icons { display: flex; gap: 4px; opacity: 0.7; }

  /* App top bar */
  .top {
    padding: 8px 14px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .top .title { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
  .top .right { display: flex; gap: 0.4rem; align-items: center; }
  .icon-btn {
    width: 36px; height: 36px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--secondary);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 1rem;
    flex-shrink: 0;
  }
  .live-pill {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 4px 9px;
    border-radius: 999px;
    background: var(--danger-soft);
    color: var(--danger);
    border: 1px solid oklch(0.65 0.18 25 / 0.4);
  }
  .back-icon {
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--primary);
    font-size: 1.4rem;
    margin-left: -10px;
  }

  /* Filter chip row */
  .filter-row {
    padding: 10px 14px 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    scrollbar-width: none;
  }
  .filter-row::-webkit-scrollbar { display: none; }
  .chip {
    font-size: 0.8rem;
    padding: 6px 13px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .chip.active {
    background: var(--elevated);
    color: var(--primary);
    border-color: var(--strong);
    font-weight: 500;
  }
  .chip .count { color: var(--muted); margin-left: 4px; font-variant-numeric: tabular-nums; }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px 110px;
  }
  .body.no-bottombar { padding-bottom: 14px; }

  /* Summary cards */
  .summary {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-bottom: 14px;
  }
  .summary .row { display: flex; align-items: center; gap: 10px; font-size: 0.84rem; }
  .summary .row .ico { width: 22px; text-align: center; font-size: 1rem; }
  .summary .row.warn .ico { color: var(--warning); }
  .summary .row.ok .ico { color: var(--success); }
  .summary .row.info .ico { color: var(--info); }
  .summary .row .num { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--primary); margin-right: 2px; }
  .summary .row .lbl { color: var(--secondary); }

  /* Generic compact row card */
  .row-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .row-card.selected { background: var(--accent-soft); border-color: var(--accent); }
  .row-card .top-line { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .row-card .name { font-size: 0.88rem; font-weight: 600; color: var(--primary); }
  .row-card .total { font-size: 0.88rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .row-card .meta { font-size: 0.76rem; color: var(--muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 0.71rem; font-weight: 500;
    padding: 3px 9px; border-radius: 999px;
    background: var(--elevated);
    color: var(--secondary);
  }
  .pill.ready { background: var(--info-soft); color: var(--info); }
  .pill.warn { background: var(--warning-soft); color: var(--warning); }
  .pill.danger { background: var(--danger-soft); color: var(--danger); }
  .pill.success { background: var(--success-soft); color: var(--success); }
  .pill.dot::before { content: '●'; font-size: 0.6em; }

  /* Sticky bottom action bar */
  .actionbar {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    background: oklch(0.13 0.004 60 / 0.96);
    backdrop-filter: blur(10px);
    display: flex;
    gap: 8px;
  }
  .btn {
    flex: 1;
    height: 48px;
    border-radius: 11px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--primary);
    font: inherit;
    font-size: 0.94rem;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: oklch(0.16 0.005 60); }
  .btn.ghost { background: transparent; color: var(--secondary); }
  .btn.danger-ghost { background: transparent; color: var(--danger); border-color: oklch(0.65 0.18 25 / 0.3); }

  /* Back bar with content */
  .back-bar {
    padding: 6px 8px 10px;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }
  .back-bar .titles { flex: 1; min-width: 0; }
  .back-bar .ttl { font-size: 0.94rem; font-weight: 600; color: var(--primary); }
  .back-bar .sub { font-size: 0.72rem; color: var(--muted); margin-top: 1px; }

  /* Panels (detail page sections) */
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 10px;
  }
  .panel-title { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }

  .kv { display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.84rem; gap: 12px; }
  .kv:not(:last-child) { border-bottom: 1px dashed var(--border); }
  .kv .k { color: var(--secondary); flex-shrink: 0; }
  .kv .v { color: var(--primary); font-variant-numeric: tabular-nums; text-align: right; min-width: 0; }

  /* Line item rows */
  .line {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    padding: 10px 0;
    font-size: 0.84rem;
  }
  .line:not(:last-child) { border-bottom: 1px dashed var(--border); }
  .line .sku-col { min-width: 0; }
  .line .sku { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem; color: var(--primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line .act { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
  .line .act.warning { color: var(--warning); }
  .line .qty-col { display: flex; align-items: center; }
  .line .qty-col input {
    width: 56px; height: 36px;
    text-align: center;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--primary);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .line .qty-col input.price-input { width: 76px; text-align: right; }
  .line.needs { background: var(--warning-soft); border-radius: 6px; margin: 0 -6px; padding-left: 6px; padding-right: 6px; }
  .line.dim { opacity: 0.55; }

  .add-line {
    margin-top: 10px;
    padding: 11px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    text-align: center;
    color: var(--secondary);
    font-size: 0.84rem;
  }

  /* Disclosure rows */
  .disc {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: 8px;
    font-size: 0.88rem;
    gap: 10px;
    cursor: pointer;
  }
  .disc .left { color: var(--primary); display: flex; align-items: center; gap: 8px; min-width: 0; }
  .disc .left .lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .disc .right { color: var(--muted); font-size: 0.78rem; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

  .total-row {
    margin-top: 8px;
    padding: 12px 0;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.96rem;
    font-weight: 600;
  }
  .total-row .v { font-variant-numeric: tabular-nums; font-size: 1.2rem; }

  /* Result banner */
  .result-banner {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px;
    border-radius: 10px;
    font-size: 0.84rem;
    margin-bottom: 10px;
  }
  .result-banner.success { background: var(--success-soft); color: var(--success); border: 1px solid oklch(0.72 0.13 145 / 0.3); }
  .result-banner.error { background: var(--danger-soft); color: var(--danger); border: 1px solid oklch(0.65 0.18 25 / 0.3); }
  .result-banner .ico { font-size: 1.05rem; line-height: 1; padding-top: 1px; }
  .result-banner .ttl { font-weight: 600; color: var(--primary); }
  .result-banner .sub { color: var(--secondary); margin-top: 1px; font-size: 0.78rem; }

  /* Form fields */
  .field { margin-bottom: 14px; }
  .field-label { display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; }
  .field-input {
    width: 100%;
    height: 44px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--primary);
    font: inherit;
    font-size: 0.92rem;
    padding: 0 12px;
    -webkit-appearance: none;
  }
  textarea.field-input { height: auto; padding: 12px; min-height: 80px; resize: none; }
  .field-help { font-size: 0.72rem; color: var(--muted); margin-top: 5px; }
  .field-hint { font-size: 0.72rem; color: var(--secondary); margin-top: 5px; }
  .field-chip-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 5px; }
  .field-chip { font-size: 0.72rem; padding: 4px 9px; border-radius: 999px; background: var(--elevated); color: var(--secondary); border: 1px solid var(--border); }
  .field-chip .x { color: var(--muted); margin-left: 3px; }
  .row-add { display: inline-flex; align-items: center; gap: 4px; font-size: 0.78rem; color: var(--accent); margin-top: 7px; padding: 4px 0; }

  /* Skeleton */
  @keyframes pulse { 50% { opacity: 0.55; } }
  .skel { background: var(--surface); border-radius: 8px; animation: pulse 1.8s ease-in-out infinite; }

  /* Empty state */
  .empty {
    text-align: center;
    padding: 60px 20px;
    color: var(--secondary);
  }
  .empty .glyph { font-size: 2.5rem; opacity: 0.7; margin-bottom: 12px; }
  .empty .ttl { color: var(--primary); font-size: 0.96rem; font-weight: 600; margin-bottom: 4px; }
  .empty .sub { font-size: 0.82rem; max-width: 24ch; margin: 0 auto; line-height: 1.5; }

  /* Customer detail header strip */
  .strip-row {
    padding: 10px 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }

  /* KPI grid */
  .kpi-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 11px 12px;
  }
  .kpi .v { font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--primary); letter-spacing: -0.01em; }
  .kpi .k { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
  .kpi.danger .v { color: var(--danger); }
  .kpi.warning .v { color: var(--warning); }

  /* AI card */
  .ai-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 12px;
  }
  .ai-card .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .ai-card .head .title { font-size: 0.78rem; font-weight: 600; color: var(--primary); display: flex; align-items: center; gap: 6px; }
  .ai-card .head .title svg { color: var(--accent); }
  .ai-card .meta { font-size: 0.7rem; color: var(--muted); display: flex; align-items: center; gap: 5px; }
  .ai-card .body-text { font-size: 0.84rem; color: var(--secondary); line-height: 1.55; margin-bottom: 11px; }
  .ai-card .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .ai-card .ai-action {
    font-size: 0.78rem;
    padding: 7px 11px;
    border-radius: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--primary);
  }

  /* Tab strip */
  .tabstrip {
    padding: 8px 14px 10px;
    display: flex;
    gap: 5px;
    overflow-x: auto;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    scrollbar-width: none;
  }
  .tabstrip::-webkit-scrollbar { display: none; }
  .tab {
    font-size: 0.82rem;
    padding: 7px 11px;
    color: var(--secondary);
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    margin-bottom: -10px;
    padding-bottom: 11px;
  }
  .tab.active { color: var(--primary); border-color: var(--accent); font-weight: 500; }
  .tab .count { color: var(--muted); margin-left: 4px; font-variant-numeric: tabular-nums; }

  /* Email row */
  .email-row {
    display: flex;
    gap: 10px;
    padding: 12px;
    border-bottom: 1px solid var(--border);
    align-items: flex-start;
  }
  .email-row .icon-col {
    width: 28px; height: 28px;
    border-radius: 7px;
    background: var(--elevated);
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    font-size: 0.9rem;
  }
  .email-row .icon-col.in { color: var(--info); }
  .email-row .icon-col.out { color: var(--success); }
  .email-row .body { min-width: 0; flex: 1; padding: 0; }
  .email-row .from-line { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .email-row .from { font-size: 0.86rem; font-weight: 500; color: var(--primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .email-row .time { font-size: 0.72rem; color: var(--muted); flex-shrink: 0; }
  .email-row .subj { font-size: 0.82rem; color: var(--secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .email-row .preview { font-size: 0.76rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; }
  .email-row.unactioned { background: oklch(0.78 0.14 80 / 0.04); }
  .email-row.unactioned .from::after { content: '●'; color: var(--warning); font-size: 0.55em; margin-left: 5px; vertical-align: middle; }

  /* Section header */
  .section-h {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 12px 0 8px;
    padding: 0 2px;
  }

  /* Search input */
  .search-bar {
    padding: 8px 14px 0;
    flex-shrink: 0;
  }
  .search {
    width: 100%;
    height: 40px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--primary);
    font: inherit;
    padding: 0 14px 0 38px;
    font-size: 0.9rem;
  }
  .search-wrap { position: relative; }
  .search-wrap::before {
    content: '🔍';
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.9rem;
    opacity: 0.6;
  }

  /* Bottom selection bar (bulk edit) */
  .bulkbar {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    background: oklch(0.13 0.004 60 / 0.96);
    backdrop-filter: blur(10px);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bulkbar .count { font-size: 0.82rem; color: var(--secondary); text-align: center; }
  .bulkbar .row { display: flex; gap: 8px; }

  /* Verdict block */
  .verdict {
    max-width: 420px;
    font-size: 0.82rem;
    color: var(--secondary);
    line-height: 1.55;
    margin-top: 4px;
  }
  .verdict .item { display: flex; gap: 9px; align-items: flex-start; padding: 4px 0; }
  .verdict .pro::before { content: '+'; color: var(--success); font-weight: 700; flex-shrink: 0; width: 16px; }
  .verdict .con::before { content: '−'; color: var(--danger); font-weight: 700; flex-shrink: 0; width: 16px; }
  .verdict .nb::before { content: 'i'; color: var(--info); font-weight: 700; flex-shrink: 0; width: 16px; font-style: italic; }

  /* Checkbox */
  .checkbox {
    width: 22px; height: 22px;
    border-radius: 6px;
    border: 1.5px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
    margin-top: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .checkbox.on { background: var(--accent); border-color: var(--accent); color: oklch(0.16 0.005 60); font-weight: 700; }

  .hide { display: none !important; }
</style>
</head>
<body>

<header class="page">
  <h1>Finance Hub — mobile preview</h1>
  <p>Phone-first redesign for the three primary pages. Open in a desktop browser; the iPhone-14-sized frame approximates a real 390px viewport. Switch pages with the top tabs, switch states with the chips underneath.</p>
</header>

<div class="top-tabs" id="page-tabs">
  <button data-page="today" class="on">Today</button>
  <button data-page="customers">Customers</button>
  <button data-page="customer-detail">Customer detail</button>
</div>

<div class="state-row" id="state-row"></div>

<div class="stage">
  <div class="phone">
    <div class="screen" id="screen-host"></div>
  </div>
  <div class="verdict" id="verdict"></div>
</div>

<!-- =============================================================
     SCREEN DEFINITIONS  (page → state → markup)
     ============================================================= -->

<template id="today-list">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="top">
    <span class="title">Today</span>
    <div class="right">
      <span class="live-pill">LIVE</span>
      <span class="icon-btn">⟲</span>
    </div>
  </div>
  <div class="filter-row">
    <span class="chip active">Open<span class="count">12</span></span>
    <span class="chip">Unparseable<span class="count">3</span></span>
    <span class="chip">Sent<span class="count">4</span></span>
    <span class="chip">Dismissed<span class="count">8</span></span>
    <span class="chip">Phone calls<span class="count">2</span></span>
  </div>
  <div class="body">
    <div class="summary">
      <div class="row warn"><span class="ico">⚠</span><span><span class="num">12</span><span class="lbl">awaiting invoice</span></span></div>
      <div class="row ok"><span class="ico">✓</span><span><span class="num">4</span><span class="lbl">sent in last 7 days</span></span></div>
      <div class="row info"><span class="ico">📦</span><span><span class="num">3</span><span class="lbl">returns to review</span></span></div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">PO-1029 → Acme Trade Ltd</span><span class="total">£812.40</span></div>
      <div class="meta"><span class="pill dot ready">Ready</span><span>#34187 · UPS</span></div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">PO-1031 → Brown &amp; Sons</span><span class="total">£1,290.00</span></div>
      <div class="meta"><span class="pill dot warn">1 needs price</span><span>#34192 · FedEx</span></div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">PO-1034 → Vintage Imports</span><span class="total">£447.50</span></div>
      <div class="meta"><span class="pill dot ready">Ready</span><span>#34198 · DHL</span></div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">PO-1038 → Hillside Antiques</span><span class="total">£998.00</span></div>
      <div class="meta"><span class="pill dot ready">Ready</span><span>#34201 · UPS</span></div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">PO-1042 → Cellar Door &amp; Co</span><span class="total">£263.10</span></div>
      <div class="meta"><span class="pill dot ready">Ready</span><span>#34209 · UPS</span></div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">PO-1045 → North &amp; Linn</span><span class="total">£3,140.00</span></div>
      <div class="meta"><span class="pill dot ready">Ready</span><span>#34215 · DHL</span></div>
    </div>
  </div>
</template>

<template id="today-detail">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">PO-1031 → Brown &amp; Sons</div>
      <div class="sub">QB invoice #34192 · £1,290.00 · FedEx</div>
    </div>
    <span class="icon-btn">⋯</span>
  </div>
  <div class="body">
    <div class="panel">
      <div class="panel-title">Shipment</div>
      <div class="kv"><span class="k">Tracking</span><span class="v">1Z9A7B…9182</span></div>
      <div class="kv"><span class="k">Carrier</span><span class="v">FedEx</span></div>
      <div class="kv"><span class="k">Ship date</span><span class="v">26 May 2026</span></div>
    </div>
    <div class="panel">
      <div class="panel-title">Line items · 5</div>
      <div class="line"><div class="sku-col"><div class="sku">VTG-OAK-CAB</div><div class="act">keep</div></div><div class="qty-col"><input value="2"></div></div>
      <div class="line"><div class="sku-col"><div class="sku">VTG-ELM-DRESS</div><div class="act">qty change 3 → 4</div></div><div class="qty-col"><input value="4"></div></div>
      <div class="line dim"><div class="sku-col"><div class="sku">VTG-PINE-BENCH</div><div class="act">not shipped</div></div><div class="qty-col">—</div></div>
      <div class="line needs"><div class="sku-col"><div class="sku">VTG-WAL-SIDE</div><div class="act warning">add · price needed</div></div><div class="qty-col"><input placeholder="£" class="price-input"></div></div>
      <div class="line"><div class="sku-col"><div class="sku">VTG-CHE-CHEST</div><div class="act">keep</div></div><div class="qty-col"><input value="1"></div></div>
      <div class="add-line">+ Add a line</div>
    </div>
    <div class="disc">
      <span class="left"><span>📧</span><span class="lbl">Email recipients</span></span>
      <span class="right">accounts@brown… ›</span>
    </div>
    <div class="disc">
      <span class="left"><span>📋</span><span class="lbl">Invoice details</span></span>
      <span class="right">Net 30 · today ›</span>
    </div>
    <div class="total-row"><span>Total</span><span class="v">£1,290.00</span></div>
  </div>
  <div class="actionbar">
    <button class="btn ghost">Dismiss</button>
    <button class="btn primary">Send to QBO →</button>
  </div>
</template>

<template id="today-email">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">Email recipients</div>
      <div class="sub">#34192 · Brown &amp; Sons</div>
    </div>
  </div>
  <div class="body no-bottombar">
    <div class="field">
      <label class="field-label">To</label>
      <input class="field-input" value="accounts@brown-sons.co.uk">
      <div class="field-help">Default from QBO invoice. Editing here doesn't change the customer's record.</div>
    </div>
    <div class="field">
      <label class="field-label">Cc</label>
      <input class="field-input" placeholder="comma-separated">
      <div class="field-chip-row">
        <span class="field-chip">+ Reply-all from thread</span>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Bcc</label>
      <input class="field-input" value="accounts@feldart.com">
      <div class="field-hint">Defaults to accounts@feldart.com (app setting). Empty string disables.</div>
    </div>
  </div>
  <div class="actionbar">
    <button class="btn ghost">Cancel</button>
    <button class="btn primary">Save</button>
  </div>
</template>

<template id="today-invoice">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">Invoice details</div>
      <div class="sub">#34192 · Brown &amp; Sons</div>
    </div>
  </div>
  <div class="body no-bottombar">
    <div class="field">
      <label class="field-label">Terms</label>
      <select class="field-input">
        <option>Net 30 (30d)</option>
        <option>Net 14 (14d)</option>
        <option>Net 7 (7d)</option>
        <option>Due on receipt</option>
        <option>(keep existing)</option>
      </select>
      <div class="field-hint">Current on invoice: Net 30</div>
    </div>
    <div class="field">
      <label class="field-label">Discount %</label>
      <input class="field-input" value="0" inputmode="decimal">
    </div>
    <div class="field">
      <label class="field-label">Customer memo</label>
      <textarea class="field-input" rows="3" placeholder="Renders on invoice + statement."></textarea>
    </div>
    <div class="field">
      <label class="field-label">DocNumber suffix</label>
      <input class="field-input" placeholder="-SP">
      <div class="field-hint">e.g. -SP for special offer.</div>
    </div>
    <div class="field">
      <label class="field-label">Issue date</label>
      <input type="date" class="field-input" value="2026-05-27">
    </div>
    <div class="disc">
      <span class="left"><span>↗</span><span class="lbl">Preview in QBO</span></span>
      <span class="right">opens new tab</span>
    </div>
  </div>
  <div class="actionbar">
    <button class="btn ghost">Cancel</button>
    <button class="btn primary">Save</button>
  </div>
</template>

<template id="today-sent">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">PO-1031 → Brown &amp; Sons</div>
      <div class="sub">QB invoice #34192 · £1,290.00</div>
    </div>
  </div>
  <div class="body">
    <div class="result-banner success">
      <span class="ico">✓</span>
      <div>
        <div class="ttl">Sent to accounts@brown-sons.co.uk</div>
        <div class="sub">14:23 · UPS shipment metadata written to QBO</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">What happened</div>
      <div class="kv"><span class="k">QBO sync token</span><span class="v">advanced</span></div>
      <div class="kv"><span class="k">Lines applied</span><span class="v">3 keep · 1 qty · 1 add</span></div>
      <div class="kv"><span class="k">Email status</span><span class="v">EmailSent</span></div>
    </div>
    <div class="disc"><span class="left"><span>↗</span><span class="lbl">Open invoice in QBO</span></span><span class="right">›</span></div>
    <div class="disc"><span class="left"><span>📧</span><span class="lbl">Open sent email in Gmail</span></span><span class="right">›</span></div>
  </div>
  <div class="actionbar">
    <button class="btn primary">Done</button>
  </div>
</template>

<template id="today-loading">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="top">
    <span class="title">Today</span>
    <div class="right"><span class="live-pill">LIVE</span><span class="icon-btn">⟲</span></div>
  </div>
  <div class="filter-row">
    <span class="chip skel" style="width: 70px; height: 28px;"></span>
    <span class="chip skel" style="width: 90px; height: 28px;"></span>
    <span class="chip skel" style="width: 70px; height: 28px;"></span>
  </div>
  <div class="body">
    <div class="summary">
      <div class="skel" style="height: 18px; width: 70%;"></div>
      <div class="skel" style="height: 18px; width: 55%;"></div>
      <div class="skel" style="height: 18px; width: 65%;"></div>
    </div>
    <div class="row-card">
      <div class="skel" style="height: 18px; width: 70%; margin-bottom: 8px;"></div>
      <div class="skel" style="height: 14px; width: 45%;"></div>
    </div>
    <div class="row-card">
      <div class="skel" style="height: 18px; width: 65%; margin-bottom: 8px;"></div>
      <div class="skel" style="height: 14px; width: 50%;"></div>
    </div>
    <div class="row-card">
      <div class="skel" style="height: 18px; width: 80%; margin-bottom: 8px;"></div>
      <div class="skel" style="height: 14px; width: 40%;"></div>
    </div>
  </div>
</template>

<template id="today-empty">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="top">
    <span class="title">Today</span>
    <div class="right"><span class="live-pill">LIVE</span><span class="icon-btn">⟲</span></div>
  </div>
  <div class="filter-row">
    <span class="chip active">Open<span class="count">0</span></span>
    <span class="chip">Sent<span class="count">4</span></span>
    <span class="chip">Dismissed<span class="count">8</span></span>
  </div>
  <div class="body">
    <div class="summary">
      <div class="row ok"><span class="ico">✓</span><span><span class="num">4</span><span class="lbl">sent in last 7 days</span></span></div>
      <div class="row info"><span class="ico">📦</span><span><span class="num">0</span><span class="lbl">returns to review</span></span></div>
    </div>
    <div class="empty">
      <div class="glyph">📭</div>
      <div class="ttl">Inbox zero for today</div>
      <div class="sub">No shipment notifications waiting on invoice. Pull down to refresh.</div>
    </div>
  </div>
</template>

<!-- =============================================================
     CUSTOMERS
     ============================================================= -->

<template id="customers-list">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="top">
    <span class="title">Customers</span>
    <div class="right">
      <span class="icon-btn">⊕</span>
      <span class="icon-btn">⋯</span>
    </div>
  </div>
  <div class="search-bar"><div class="search-wrap"><input class="search" placeholder="Search by name, email, phone"></div></div>
  <div class="filter-row" style="margin-top: 10px;">
    <span class="chip active">All<span class="count">128</span></span>
    <span class="chip">B2B<span class="count">86</span></span>
    <span class="chip">B2C<span class="count">42</span></span>
    <span class="chip">Hold<span class="count">9</span></span>
    <span class="chip">Uncategorized<span class="count">7</span></span>
  </div>
  <div class="body">
    <div class="row-card">
      <div class="top-line"><span class="name">Acme Trade Ltd</span><span class="total">£1,290</span></div>
      <div class="meta">
        <span class="pill dot warn">Hold</span>
        <span class="pill">B2B</span>
        <span>2 overdue · last contact 4d</span>
      </div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">Brown &amp; Sons Inc</span><span class="total">£812</span></div>
      <div class="meta">
        <span class="pill">B2B</span>
        <span>0 overdue · last contact 2d</span>
      </div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">Cellar Door &amp; Co</span><span class="total">£263</span></div>
      <div class="meta">
        <span class="pill dot danger">CRITICAL · 47d</span>
        <span class="pill">B2B</span>
      </div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">Hillside Antiques</span><span class="total">£998</span></div>
      <div class="meta">
        <span class="pill">B2B</span>
        <span>0 overdue · last contact 8d</span>
      </div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">North &amp; Linn</span><span class="total">£3,140</span></div>
      <div class="meta">
        <span class="pill dot warn">HIGH · 22d</span>
        <span class="pill">B2B</span>
        <span>🤖 off</span>
      </div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">Vintage Imports</span><span class="total">£447</span></div>
      <div class="meta">
        <span class="pill">B2B</span>
        <span>0 overdue · last contact 1d</span>
      </div>
    </div>
    <div class="row-card">
      <div class="top-line"><span class="name">Riverbend Bistro</span><span class="total">£186</span></div>
      <div class="meta"><span class="pill">B2C</span><span>0 overdue</span></div>
    </div>
  </div>
</template>

<template id="customers-bulk">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="top">
    <span class="title">3 selected</span>
    <div class="right">
      <span class="icon-btn" style="background: var(--accent-soft); color: var(--accent); border-color: var(--accent);">✓</span>
      <span class="icon-btn">✕</span>
    </div>
  </div>
  <div class="filter-row">
    <span class="chip active">All<span class="count">128</span></span>
    <span class="chip">B2B<span class="count">86</span></span>
    <span class="chip">B2C<span class="count">42</span></span>
    <span class="chip">Hold<span class="count">9</span></span>
  </div>
  <div class="body">
    <div class="row-card selected">
      <div style="display: flex; gap: 10px; align-items: flex-start;">
        <span class="checkbox on">✓</span>
        <div style="flex: 1; min-width: 0;">
          <div class="top-line"><span class="name">Acme Trade Ltd</span><span class="total">£1,290</span></div>
          <div class="meta"><span class="pill dot warn">Hold</span><span class="pill">B2B</span></div>
        </div>
      </div>
    </div>
    <div class="row-card">
      <div style="display: flex; gap: 10px; align-items: flex-start;">
        <span class="checkbox"></span>
        <div style="flex: 1; min-width: 0;">
          <div class="top-line"><span class="name">Brown &amp; Sons Inc</span><span class="total">£812</span></div>
          <div class="meta"><span class="pill">B2B</span></div>
        </div>
      </div>
    </div>
    <div class="row-card selected">
      <div style="display: flex; gap: 10px; align-items: flex-start;">
        <span class="checkbox on">✓</span>
        <div style="flex: 1; min-width: 0;">
          <div class="top-line"><span class="name">Cellar Door &amp; Co</span><span class="total">£263</span></div>
          <div class="meta"><span class="pill dot danger">CRITICAL · 47d</span><span class="pill">B2B</span></div>
        </div>
      </div>
    </div>
    <div class="row-card">
      <div style="display: flex; gap: 10px; align-items: flex-start;">
        <span class="checkbox"></span>
        <div style="flex: 1; min-width: 0;">
          <div class="top-line"><span class="name">Hillside Antiques</span><span class="total">£998</span></div>
          <div class="meta"><span class="pill">B2B</span></div>
        </div>
      </div>
    </div>
    <div class="row-card selected">
      <div style="display: flex; gap: 10px; align-items: flex-start;">
        <span class="checkbox on">✓</span>
        <div style="flex: 1; min-width: 0;">
          <div class="top-line"><span class="name">North &amp; Linn</span><span class="total">£3,140</span></div>
          <div class="meta"><span class="pill dot warn">HIGH · 22d</span><span class="pill">B2B</span></div>
        </div>
      </div>
    </div>
  </div>
  <div class="bulkbar">
    <div class="count"><b style="color: var(--primary);">3</b> customers selected</div>
    <div class="row">
      <button class="btn">🤖 Off</button>
      <button class="btn">🤖 On</button>
      <button class="btn primary">Tag…</button>
    </div>
  </div>
</template>

<template id="customers-empty">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="top">
    <span class="title">Customers</span>
    <div class="right"><span class="icon-btn">⊕</span></div>
  </div>
  <div class="search-bar"><div class="search-wrap"><input class="search" value="brown smiths" placeholder="Search"></div></div>
  <div class="body">
    <div class="empty">
      <div class="glyph">🔍</div>
      <div class="ttl">No matches</div>
      <div class="sub">Try a different name or email. Or add a new customer with the + icon.</div>
    </div>
  </div>
</template>

<!-- =============================================================
     CUSTOMER DETAIL
     ============================================================= -->

<template id="cd-overview">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">Acme Trade Ltd</div>
      <div class="sub">accounts@acme-trade.co.uk · +44 …</div>
    </div>
    <span class="icon-btn">⟲</span>
  </div>
  <div class="strip-row">
    <span class="pill dot warn">Hold</span>
    <span class="pill">🤖 ON</span>
    <span class="pill">B2B</span>
    <span class="pill">Net 30</span>
  </div>
  <div class="body">
    <div class="ai-card">
      <div class="head">
        <span class="title"><span style="color: var(--accent);">✦</span> AI summary &amp; action plan</span>
        <span class="meta">3h ago · ⟲</span>
      </div>
      <div class="body-text">Acme is on hold since 2 May and £1,290 overdue across INV-1234 (47d) and INV-1244 (12d). Last contact was a chase email 4 days ago — no reply. Sarah at Acme confirmed in March they pay via BACS on the 28th of each month.</div>
      <div class="actions">
        <span class="ai-action">Send chase L3 (INV-1234)</span>
        <span class="ai-action">Send statement</span>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><div class="v">£1,290</div><div class="k">Open balance</div></div>
      <div class="kpi danger"><div class="v">£812</div><div class="k">Overdue</div></div>
      <div class="kpi"><div class="v">£0</div><div class="k">Unapplied credit</div></div>
      <div class="kpi warning"><div class="v">47d</div><div class="k">Days since payment</div></div>
    </div>
    <div class="tabstrip" style="margin: 0 -14px;">
      <span class="tab active">Activity<span class="count">23</span></span>
      <span class="tab">Emails<span class="count">9</span></span>
      <span class="tab">Invoices<span class="count">12</span></span>
      <span class="tab">Orders</span>
      <span class="tab">Tasks<span class="count">2</span></span>
      <span class="tab">Notes</span>
      <span class="tab">Returns</span>
    </div>
    <div class="section-h">Recent activity</div>
    <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden;">
      <div class="email-row"><div class="icon-col out">↗</div><div class="body"><div class="from-line"><span class="from">us → accounts@acme-trade…</span><span class="time">4d</span></div><div class="subj">Chase L2 — INV-1234 overdue</div></div></div>
      <div class="email-row unactioned"><div class="icon-col in">↙</div><div class="body"><div class="from-line"><span class="from">Sarah at Acme</span><span class="time">6d</span></div><div class="subj">Re: invoice INV-1234</div><div class="preview">"We'll have payment over to you by Friday…"</div></div></div>
      <div class="email-row"><div class="icon-col" style="background: var(--accent-soft); color: var(--accent);">$</div><div class="body"><div class="from-line"><span class="from">Payment received</span><span class="time">10d</span></div><div class="subj">£480.00 applied to INV-1217</div></div></div>
    </div>
  </div>
</template>

<template id="cd-emails">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">Acme Trade Ltd</div>
      <div class="sub">Emails · 9 in thread history</div>
    </div>
  </div>
  <div class="tabstrip">
    <span class="tab">Activity<span class="count">23</span></span>
    <span class="tab active">Emails<span class="count">9</span></span>
    <span class="tab">Invoices<span class="count">12</span></span>
    <span class="tab">Tasks<span class="count">2</span></span>
  </div>
  <div class="filter-row">
    <span class="chip active">Open<span class="count">2</span></span>
    <span class="chip">Actioned<span class="count">7</span></span>
    <span class="chip">All</span>
    <span class="chip">Inbound</span>
    <span class="chip">Outbound</span>
  </div>
  <div class="body" style="padding: 0;">
    <div class="email-row unactioned">
      <div class="icon-col in">↙</div>
      <div class="body">
        <div class="from-line"><span class="from">Sarah at Acme</span><span class="time">2h</span></div>
        <div class="subj">Re: invoice query</div>
        <div class="preview">"Got it, but the total is wrong on INV-1234 — we agreed £812 not £998…"</div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <span class="pill" style="background: var(--accent-soft); color: var(--accent);">✦ Draft reply</span>
          <span class="pill">Mark actioned</span>
        </div>
      </div>
    </div>
    <div class="email-row unactioned">
      <div class="icon-col in">↙</div>
      <div class="body">
        <div class="from-line"><span class="from">accounts@acme-trade.co.uk</span><span class="time">1d</span></div>
        <div class="subj">Out of office</div>
        <div class="preview">"I'm out until Monday — please contact Sarah at sarah@…"</div>
      </div>
    </div>
    <div class="email-row">
      <div class="icon-col out">↗</div>
      <div class="body">
        <div class="from-line"><span class="from">accounts@feldart.com</span><span class="time">4d</span></div>
        <div class="subj">Chase L2 — INV-1234 overdue</div>
        <div class="preview">"This is a reminder that invoice INV-1234 for £812.40 is now 47 days overdue…"</div>
      </div>
    </div>
    <div class="email-row">
      <div class="icon-col out">↗</div>
      <div class="body">
        <div class="from-line"><span class="from">accounts@feldart.com</span><span class="time">8d</span></div>
        <div class="subj">Chase L1 — friendly reminder</div>
        <div class="preview">"Just a quick note that invoice INV-1234 is now overdue…"</div>
      </div>
    </div>
    <div class="email-row">
      <div class="icon-col in">↙</div>
      <div class="body">
        <div class="from-line"><span class="from">Sarah at Acme</span><span class="time">10d</span></div>
        <div class="subj">Re: invoice INV-1234</div>
        <div class="preview">"Apologies for the delay — we'll have payment over by Friday."</div>
      </div>
    </div>
  </div>
</template>

<template id="cd-draft">
  <div class="status-bar"><span class="time">14:22</span><span class="icons">5G • 78%</span></div>
  <div class="back-bar">
    <span class="back-icon">‹</span>
    <div class="titles">
      <div class="ttl">Reply with AI</div>
      <div class="sub">Re: invoice query · Sarah at Acme</div>
    </div>
  </div>
  <div class="body no-bottombar">
    <div style="background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 12px; padding: 12px; margin-bottom: 14px;">
      <div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:8px;display:flex;align-items:center;gap:6px;">✦ AI draft</div>
      <textarea class="field-input" rows="2" style="background: var(--bg);" placeholder="Notes for AI (optional) — leave blank for a clean draft. e.g. 'apologise for the mix-up and offer a corrected invoice'"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:8px;">
        <button class="btn primary" style="height: 38px; flex: 0 0 auto; padding: 0 16px;">✦ Generate</button>
      </div>
    </div>

    <div class="field">
      <label class="field-label">From</label>
      <select class="field-input"><option>accounts@feldart.com</option><option>sales@feldart.com</option></select>
    </div>
    <div class="field">
      <label class="field-label">To</label>
      <input class="field-input" value="sarah@acme-trade.co.uk">
    </div>
    <div class="field">
      <label class="field-label">Subject</label>
      <input class="field-input" value="Re: invoice query">
    </div>
    <div class="field">
      <label class="field-label">Body</label>
      <textarea class="field-input" rows="6" placeholder="Write your message…">Hi Sarah,

Apologies for the mix-up on INV-1234 — you're right, the agreed total was £812.40. I've corrected the invoice and reattached it below.

Let me know if there's anything else.</textarea>
    </div>
  </div>
  <div class="actionbar">
    <button class="btn ghost">📎</button>
    <button class="btn primary">Send →</button>
  </div>
</template>

<script>
  // --------------------------------------------------------------
  // Page + state config
  // --------------------------------------------------------------
  const PAGES = {
    today: {
      label: 'Today',
      states: [
        { key: 'list', label: 'List', tpl: 'today-list' },
        { key: 'detail', label: 'Detail (tap a row)', tpl: 'today-detail' },
        { key: 'email', label: 'Email recipients', tpl: 'today-email' },
        { key: 'invoice', label: 'Invoice details', tpl: 'today-invoice' },
        { key: 'sent', label: 'Sent success', tpl: 'today-sent' },
        { key: 'loading', label: 'Loading', tpl: 'today-loading' },
        { key: 'empty', label: 'Empty', tpl: 'today-empty' },
      ],
      verdict: [
        { kind: 'pro', text: 'Familiar email-app mental model — list → detail.' },
        { kind: 'pro', text: 'Reconcile editor gets the full screen on the detail page; price-needed lines highlight inline.' },
        { kind: 'pro', text: 'Primary action ("Send to QBO") always in thumb zone via sticky bottom bar.' },
        { kind: 'pro', text: 'Disclosure rows hide low-frequency fields (Email recipients, Invoice details) behind a tap.' },
        { kind: 'con', text: 'One nav hop per shipment when processing the queue — fine for a few, slower for 20+.' },
        { kind: 'nb', text: 'Send-success state replaces the action bar with a single Done — clear stopping point before going back to the list.' },
      ],
    },
    customers: {
      label: 'Customers',
      states: [
        { key: 'list', label: 'List', tpl: 'customers-list' },
        { key: 'bulk', label: 'Bulk edit', tpl: 'customers-bulk' },
        { key: 'empty', label: 'Empty search', tpl: 'customers-empty' },
      ],
      verdict: [
        { kind: 'pro', text: 'Search at the top, chip filters below — thumb reaches them first.' },
        { kind: 'pro', text: 'Each row shows the at-a-glance state (overdue tier pill, hold, autopilot off) without expansion.' },
        { kind: 'pro', text: 'Bulk-edit slides in a footer bar with the three most common bulk actions (autopilot on/off, tag).' },
        { kind: 'con', text: 'No customer-type counter ribbon — the desktop "All / B2B / B2C" counts fit but stat tiles don\\'t.' },
      ],
    },
    'customer-detail': {
      label: 'Customer detail',
      states: [
        { key: 'overview', label: 'Overview', tpl: 'cd-overview' },
        { key: 'emails', label: 'Emails tab', tpl: 'cd-emails' },
        { key: 'draft', label: 'Draft reply', tpl: 'cd-draft' },
      ],
      verdict: [
        { kind: 'pro', text: 'AI summary card is the first thing operators see — answers "what should I do for this customer" without scrolling.' },
        { kind: 'pro', text: 'KPI grid is two columns of four — fits in one viewport, no horizontal scroll.' },
        { kind: 'pro', text: 'Tab strip scrolls horizontally; the desktop "all 7 tabs visible" goal isn\\'t worth fighting for on a phone.' },
        { kind: 'pro', text: 'Email rows merge into the inline AI draft flow — Draft reply opens a full-screen composer with the AI panel pre-filled.' },
        { kind: 'con', text: 'Status strip + AI card + KPIs is a lot of vertical real estate above the tabs — might compress AI card to collapsed-by-default for power users.' },
      ],
    },
  };

  let currentPage = 'today';
  let currentState = 'list';

  function render() {
    const cfg = PAGES[currentPage];

    // state row
    const stateRow = document.getElementById('state-row');
    stateRow.innerHTML = '';
    for (const s of cfg.states) {
      const btn = document.createElement('button');
      btn.className = 'state-btn' + (s.key === currentState ? ' on' : '');
      btn.textContent = s.label;
      btn.addEventListener('click', () => {
        currentState = s.key;
        render();
      });
      stateRow.appendChild(btn);
    }

    // screen
    const host = document.getElementById('screen-host');
    const state = cfg.states.find((s) => s.key === currentState) || cfg.states[0];
    const tpl = document.getElementById(state.tpl);
    host.innerHTML = '';
    host.appendChild(tpl.content.cloneNode(true));

    // verdict
    const verdict = document.getElementById('verdict');
    verdict.innerHTML = '';
    for (const v of cfg.verdict) {
      const div = document.createElement('div');
      div.className = 'item ' + v.kind;
      div.textContent = v.text;
      verdict.appendChild(div);
    }

    // top tabs
    for (const btn of document.querySelectorAll('#page-tabs button')) {
      btn.classList.toggle('on', btn.dataset.page === currentPage);
    }
  }

  document.getElementById('page-tabs').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLButtonElement)) return;
    if (!t.dataset.page) return;
    currentPage = t.dataset.page;
    const firstState = PAGES[currentPage].states[0].key;
    currentState = firstState;
    render();
  });

  render();
</script>

</body>
</html>`;

const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(HTML);
});

// Re-bind on the same port — kill any prior instance from this session.
server.on("error", (err) => {
  if ((err).code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use. Stop the prior instance first.`);
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mobile preview: http://localhost:${PORT}`);
});
