# Restart prompt — finance agent (paste into a fresh Claude Code session)

Rejoin the walkie-talkie as `finance` on channel `#all` (radio_join via the walkie-talkie skill;
if the name is a stuck ghost from the prior session, join as `finance-hub`), then say hi to
@operator and @inbox and continue. You're the finance-hub agent (`C:\Users\user\Documents\finance-hub`).
Everything is LIVE on finance.feldart.com, deployed MANUALLY over `ssh finance-vps` (GH-Actions
deploy keeps hitting the Hostinger SSH flake on 2222+22). Read MEMORY.md first, then the two topic
files below. `npx vitest run` (bare `npm test` = watch mode); never blanket-kill node.

**Why we restarted: the flashing cmd/console windows on Windows.** Full diagnosis + the fix is in
memory `reference_windows-hook-flash-fix`. Summary: I added `"windowsHide": true` to all active
plugin hooks (claude-mem 13.6.1 / context-mode 1.0.111 / superpowers 5.1.0) — memory FULLY kept,
zero hooks disabled. NOTE: the copy I added to `~/.claude/settings.json` (user SessionStart hook)
got reverted by a linter/user afterward — re-check + re-add windowsHide there if it helps.
**This restart is the real test.** FIRST THING after rejoining: ask @operator whether the flashing
is gone / better / same.
  - If STILL flashing → likely cause is claude-mem's bash hooks spawning a login shell
    (`$SHELL -lc 'echo $PATH'`) + node/ls/sed GRANDCHILDREN that pop their own consoles outside
    windowsHide's reach. Next memory-preserving step (YOU drive the shared ~/.claude file; inbox
    stays hands-off): surgically trim that per-hook `$SHELL -lc` (cache PATH once). Inbox has a
    stdio-preserving no-window shim staged as a fallback and already removed a stray `electron`
    autostart Run-key (a separate login-time flash source).
  - These plugin-hooks.json edits are NON-DURABLE — a plugin auto-update wipes them; re-apply.

**Then: the audit.** Operator asked both agents (finance + inbox) for a thorough UI/UX + FUNCTIONAL
audit + a prioritized findings list to decide what to tackle. My 5-way finance fan-out actually
COMPLETED (all slices) despite the restart — findings saved at
`docs/superpowers/audit-2026-07-01-findings.md` with a "Cross-slice HEADLINE items" section.
Operator wanted to re-run fresh after restart, so: either re-run the 5-slice fan-out (dashboard /
customers+detail / orders+holds+statements+chase / AI-agent+autopilot+compose /
settings+team-activity+shell) OR review the saved doc — then share the ranked list with @operator
and let them pick. **Headline worth flagging regardless: a HIGH-sev bug — operator `manualHold`s
are silently auto-released on the next orders-sync** (`src/modules/orders/hold-alerts.ts:99-111`,
`holdReasonStillApplies` has no `case "manual"` → hits `default:false` → `releaseResolvedHolds`
clears it).

**Also shipped this session (operator-verify pending):** Team Activity now lets inbox-only
teammates (no finance login, e.g. **Samual** `samualkai@googlemail.com`) be report subjects —
commit `36526e7`, deployed, 1118 tests green. See memory `project_team-activity`. Inbox needed
nothing (the existing `/api/svc/members` already returns him).

Nothing else urgent — pick up whatever @operator raises next.
