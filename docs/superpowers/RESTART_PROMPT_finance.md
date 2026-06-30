# Restart prompt — finance agent (paste into a fresh Claude Code session)

Rejoin the walkie-talkie as `finance` on channel `#all` (radio_join via the walkie-talkie skill), then say hi to @operator and @inbox and continue.

You are the finance-hub agent (C:\Users\user\Documents\finance-hub). Context for where we left off — everything below is LIVE on finance.feldart.com, all deployed MANUALLY over `ssh finance-vps` (the GH-Actions deploy keeps hitting the Hostinger SSH flake: "VPS unreachable on 2222+22"; recipe = `npm run build` local → `tar czf - dist migrations | ssh finance-vps 'tar xzf -'` → `set -a; . ./.env.production; set +a; npm run db:migrate` → `pm2 reload finance-hub`). Memory is current: see [[project_team-activity]].

SHIPPED THIS SESSION (2026-06-29/30, over radio with the Inbox agent):
1. **Team Activity** admin report `/team-activity` (Josh+Shaya only, Hillel excluded) — per-teammate emails/calls/finance-actions/tasks/notes/active-time/clocked-hours, merged finance+inbox. Migration 0054. **Active time is SESSION-based** (15-min bridge, calls count full duration, momentary interactions ping immediately, pre-heartbeat days show "(est.)").
2. **Time Clock** (Hillel timesheet) — merge `25911ce`, migration 0055. Clock-in/out card on his dashboard + "Clocked hours" tile on Team Activity. Allow-list = app_settings `time_clock_user_ids`. ⚠️ CHECK: it should be Hillel-only (`["4cd54aa2-e8d9-49ca-bb71-b5457ec57fd7"]`) — if Josh's id `dev-joshezekiel554-gmail-com` is still in it from testing, that means restore wasn't done; restore to Hillel-only.
3. **Inbox-built (reflect in finance embed free):** email priority (Phase 1) + manual drag-reorder (Phase 2). No finance code needed; verify they show in the embedded board.

OPEN/PENDING when we paused: operator was testing the time-clock card + reorder; cmd-window flashing was being fixed by the operator updating Claude Code (windowsHide). Pick up whatever the operator raises next.

Standing directives: reviews on Opus 4.8; work for perfection not token-saving; spin up agents/teams as needed; constant progress updates + periodic check-ins (don't go silent); confirm before outward/irreversible actions.
