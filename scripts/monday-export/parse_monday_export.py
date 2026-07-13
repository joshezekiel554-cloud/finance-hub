#!/usr/bin/env python3
"""Parse the monday.com account export into a normalized import feed
for the unified tasks engine (inbox), plus a human-review mapping doc.

Scope (operator ruling 2026-07-13): import ONLY Esti / Shaya / Shmuel
boards, exclude Done items ("starting fresh"), exclude USA Stores and
Joshua Tasks entirely. Raw export stays as the archive.

Usage:
    python parse_monday_export.py <export_dir> <out_dir>

Outputs:
    <out_dir>/import-feed.json     — normalized feed (schema radioed to inbox-4)
    <out_dir>/mapping-review.md    — operator eyeball doc: every kept/skipped item
"""

import json
import os
import re
import sys
from datetime import datetime, date

import openpyxl

# ---------------------------------------------------------------- config

# monday user -> platform user key (inbox TeamMember resolution is the
# importer's job; we pass stable keys + emails).
USER_MAP = {
    "Shaya Grunfeld": {"key": "shaya", "email": "info@feldartcollection.co.uk"},
    "Esti Grunfeld": {"key": "esti", "email": "customprints@feldartcollection.co.uk"},
    "Samual Kessel": {"key": "samual", "email": "samualkai@gmail.com"},
    "Joshua Ezekiel": {"key": "josh", "email": "admin@feldartcollection.co.uk"},
    # comment authors with no platform account -> imported as attributed text
    "Avi Liebermann": {"key": None, "email": "sales@feldartcollection.co.uk"},
    "Racheli Jacobs": {"key": None, "email": "racheli@feldart.com"},
}

DONE_STATUSES = {"done"}  # lowercased compare; operator: starting fresh

# monday status -> inbox TaskStatus enum (prisma/schema.prisma:778,
# confirmed by inbox-4 over radio 2026-07-13). Feed ships final enum values.
STATUS_MAP = {
    "": "TODO",
    "done": "DONE",
    "working on it": "IN_PROGRESS",
    "in progress": "IN_PROGRESS",
    "not started": "TODO",
    "waiting for other party": "WAITING",
    "wating for other party": "WAITING",
    "priority": "TODO",  # + priority flag, see PRIORITY_STATUSES
    "invoice sent": "WAITING",  # PENDING operator ruling O1: live-or-skip
}
PRIORITY_STATUSES = {"priority"}

# board_file -> parse plan
BOARDS = [
    {
        "file": "1311601108_Esti Tasks.xlsx",
        "updates": "1311601108_esti-tasks_updates.xlsx",
        "boardId": "1311601108",
        "owner": "esti",
        "title": "Esti",
        "status_col": "Status",
        "person_col": "Person",
        "date_col": "Date",
        "groups": {  # monday group -> {board: main|<sub key>} (None = skip group)
            "Diagrams for Quotes": "main",
            "Group Title": "main",
            "New Products": "main",
        },
        "custom_cols": {},  # nothing populated beyond core fields
    },
    {
        "file": "1311601935_Shaya Tasks.xlsx",
        "updates": "1311601935_shaya-tasks_updates.xlsx",
        "boardId": "1311601935",
        "owner": "shaya",
        "title": "Shaya",
        "status_col": "Status",
        "person_col": "Person",
        "date_col": None,
        "groups": {
            "Group Title": "main",
            "Invoices": "invoices",
            "Website Invoices to refund": "invoices",  # folded; flag in review doc
        },
        "sub_boards": {"invoices": "Invoices"},
        "custom_cols": {
            "Payment Status": {"id": "payment_status", "type": "dropdown"},
        },
    },
    {
        "file": "18409849807_Shmuel Tasks.xlsx",
        "updates": "18409849807_shmuel-tasks_updates.xlsx",
        "boardId": "18409849807",
        "owner": "samual",
        "title": "Samual",
        "status_col": "Progress",  # 'Status' col exists but is 0% populated
        "person_col": "Assignees",
        "date_col": "Due Date",
        "groups": {
            "Active": "main",
            "Linkedin": "linkedin",
        },
        "sub_boards": {"linkedin": "LinkedIn"},
        "custom_cols": {
            "Category": {"id": "category", "type": "dropdown"},
            "Priority": {"id": "priority", "type": "dropdown"},
            "Effort (hours)": {"id": "effort_hours", "type": "text"},
        },
    },
]

DROPDOWN_COLORS = ["blue", "green", "amber", "purple", "rose", "cyan", "slate"]

# ---------------------------------------------------------------- parsing

def load_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    return rows


def parse_board_items(path):
    """Yield (group_title, header, row) for each item row."""
    rows = load_rows(path)
    header, cur, pending = None, None, None
    for r in rows[1:]:
        vals = [c for c in r if c is not None and str(c).strip() != ""]
        if not vals:
            continue
        if r[0] == "Name":
            header, cur, pending = r, (pending or "??"), None
            continue
        if len(vals) == 1 and not any(r[1:]):
            pending = str(r[0])
            continue
        if header is not None:
            yield cur, header, r


def cell(header, row, col):
    for i, c in enumerate(header):
        if c == col:
            v = row[i] if len(row) > i else None
            if v is None:
                return ""
            return str(v).strip() if not isinstance(v, (datetime, date)) else v
    return ""


def iso_date(v):
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str) and v.strip():
        m = re.match(r"(\d{4}-\d{2}-\d{2})", v.strip())
        if m:
            return m.group(1)
    return None


def parse_updates(path):
    """Return {item_id_str: [update, ...]} plus name-keyed fallback index."""
    rows = load_rows(path)
    hdr = rows[1]
    idx = {c: i for i, c in enumerate(hdr) if c}
    by_id, by_name = {}, {}
    for r in rows[2:]:
        if not any(r):
            continue
        def g(col):
            i = idx.get(col)
            v = r[i] if i is not None and len(r) > i else None
            return str(v).strip() if v is not None else ""
        upd = {
            "author": g("User"),
            "createdAt": parse_update_ts(g("Created At")),
            "body": g("Update Content"),
            "assetIds": [a.strip() for a in g("Asset IDs").split(",") if a.strip()],
            "postId": g("Post ID"),
            "parentPostId": g("Parent Post ID") or None,
        }
        by_id.setdefault(g("Item ID"), []).append(upd)
        by_name.setdefault(g("Item Name"), []).append(upd)
    return by_id, by_name


def parse_update_ts(s):
    # e.g. "14/August/2024  03:06:42 PM"
    s = re.sub(r"\s+", " ", s).strip()
    for fmt in ("%d/%B/%Y %I:%M:%S %p", "%d/%b/%Y %I:%M:%S %p"):
        try:
            return datetime.strptime(s, fmt).isoformat()
        except ValueError:
            pass
    return s or None


def index_assets(export_dir):
    """assets/ files are '<assetId>_<filename>'. Return {assetId: relpath}."""
    out = {}
    adir = os.path.join(export_dir, "assets")
    for name in os.listdir(adir):
        m = re.match(r"(\d+)_", name)
        if m:
            out[m.group(1)] = os.path.join("assets", name)
    return out


def map_person(raw):
    """'A, B' -> ([keys], [unmatched names])"""
    keys, unmatched = [], []
    for name in [p.strip() for p in str(raw).split(",") if p.strip()]:
        u = USER_MAP.get(name)
        if u and u["key"]:
            keys.append(u["key"])
        else:
            unmatched.append(name)
    return keys, unmatched


# ---------------------------------------------------------------- main

def main(export_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    assets = index_assets(export_dir)

    feed = {
        "generatedFrom": os.path.basename(export_dir),
        "scope": "esti+shaya+shmuel, done-excluded (operator 2026-07-13)",
        "users": [
            {"key": u["key"], "mondayName": name, "email": u["email"]}
            for name, u in USER_MAP.items() if u["key"]
        ],
        "boards": [],
    }
    review = []
    review.append("# Monday migration — mapping review\n")
    review.append("Scope: **Esti, Shaya, Shmuel(→Samual)** boards only. "
                  "Done items excluded (starting fresh). Joshua Tasks + USA Stores "
                  "left in the raw export archive, importable later.\n")
    review.append("## Status mapping (monday label → TaskStatus enum)\n")
    review.append("| monday status | imports as |")
    review.append("|---|---|")
    for label, enum in STATUS_MAP.items():
        if label == "done":
            continue  # done rows are skipped entirely, not imported
        review.append(f"| {label or '(blank)'} | {enum} |")
    review.append("| *(anything else)* | TODO |")
    review.append("\n'Priority' status additionally sets priority=high. "
                  "'Invoice sent' → WAITING is **pending operator ruling O1** "
                  "(alternative: skip those 34 rows like Done).\n")

    totals = {"kept": 0, "skipped_done": 0, "comments": 0, "attachments": 0}

    for plan in BOARDS:
        bpath = os.path.join(export_dir, "boards", plan["file"])
        upath = os.path.join(export_dir, "updates", plan["updates"])
        upd_by_id, upd_by_name = parse_updates(upath)

        # collect dropdown option values as we go
        option_values = {cid["id"]: [] for cid in plan["custom_cols"].values()}

        board = {
            "key": plan["boardId"] + ":main",
            "mondayBoardId": plan["boardId"],
            "ownerKey": plan["owner"],
            "title": plan["title"],
            "isMain": True,
            "columns": [],
            "tasks": [],
        }
        subs = {
            skey: {
                "key": plan["boardId"] + ":" + skey,
                "mondayBoardId": plan["boardId"],
                "ownerKey": plan["owner"],
                "title": stitle,
                "isMain": False,
                "columns": [],
                "tasks": [],
            }
            for skey, stitle in plan.get("sub_boards", {}).items()
        }

        review.append(f"\n## {plan['title']} (from `{plan['file']}`)\n")
        review.append("| # | task | group → board | status → suggested | assignees | due | custom | comments |")
        review.append("|---|------|----------------|--------------------|-----------|-----|--------|----------|")
        skipped = []

        n = 0
        for group, header, row in parse_board_items(bpath):
            name = cell(header, row, "Name")
            if not name:
                continue
            status_raw = str(cell(header, row, plan["status_col"]) or "")
            status_l = status_raw.lower()
            target = plan["groups"].get(group, "main")
            if status_l in DONE_STATUSES:
                totals["skipped_done"] += 1
                skipped.append(f"{name} ({group}, {status_raw})")
                continue

            item_id = str(cell(header, row, "Item ID (auto generated)") or "")
            due = iso_date(cell(header, row, plan["date_col"])) if plan["date_col"] else None
            assignees, unmatched = ([], [])
            if plan["person_col"]:
                assignees, unmatched = map_person(cell(header, row, plan["person_col"]))
            if not assignees:
                assignees = [plan["owner"]]  # board owner is default assignee

            colvals = {}
            for col, spec in plan["custom_cols"].items():
                v = str(cell(header, row, col) or "")
                if v:
                    colvals[spec["id"]] = v
                    if spec["type"] == "dropdown" and v not in option_values[spec["id"]]:
                        option_values[spec["id"]].append(v)

            # comments: by item id, else by name (Shmuel board has no id col)
            ups = upd_by_id.get(item_id) if item_id else None
            if not ups:
                ups = upd_by_name.get(name, [])
            comments = []
            attachments = []
            for u in ups:
                paths = [assets[a] for a in u["assetIds"] if a in assets]
                comments.append({
                    "authorName": u["author"],
                    "authorEmail": (USER_MAP.get(u["author"]) or {}).get("email"),
                    "createdAt": u["createdAt"],
                    "body": u["body"],
                    "assetPaths": paths,
                    "postId": u["postId"],
                    "parentPostId": u["parentPostId"],
                })
                attachments.extend(paths)
            totals["comments"] += len(comments)
            totals["attachments"] += len(attachments)

            suggested = STATUS_MAP.get(status_l, "TODO")
            task = {
                "mondayItemId": item_id or None,
                "title": name,
                "mondayGroup": group,
                "mondayStatus": status_raw or None,
                "status": suggested,
                "priority": "high" if status_l in PRIORITY_STATUSES else None,
                "dueDate": due,
                "assigneeKeys": assignees,
                "unmatchedAssignees": unmatched,
                "columnValues": colvals,
                "comments": comments,
            }
            (board if target == "main" else subs[target])["tasks"].append(task)
            totals["kept"] += 1
            n += 1
            dest = board["title"] if target == "main" else subs[target]["title"]
            cv = ", ".join(f"{k}={v}" for k, v in colvals.items())
            review.append(
                f"| {n} | {name[:60]} | {group} → {dest} | "
                f"{status_raw or '—'} → {suggested} | {', '.join(assignees)} | "
                f"{due or '—'} | {cv or '—'} | {len(comments)} |")

        if skipped:
            review.append(f"\n**Skipped as Done ({len(skipped)}):** " + "; ".join(skipped) + "\n")

        # finalize dropdown columns with harvested options
        for col, spec in plan["custom_cols"].items():
            coldef = {"id": spec["id"], "label": col, "type": spec["type"]}
            if spec["type"] == "dropdown":
                coldef["options"] = [
                    {"id": re.sub(r"[^a-z0-9]+", "_", v.lower()).strip("_"),
                     "label": v,
                     "color": DROPDOWN_COLORS[i % len(DROPDOWN_COLORS)]}
                    for i, v in enumerate(option_values[spec["id"]])
                ]
            # column belongs to whichever boards carry values; simplest: all
            board["columns"].append(coldef)
            for s in subs.values():
                s["columns"].append(coldef)

        # option ids replace raw labels in task columnValues (option-ID discipline)
        for b in [board, *subs.values()]:
            for t in b["tasks"]:
                for cid, raw in list(t["columnValues"].items()):
                    coldef = next((c for c in b["columns"] if c["id"] == cid), None)
                    if coldef and coldef["type"] == "dropdown":
                        opt = next((o for o in coldef["options"] if o["label"] == raw), None)
                        if opt:
                            t["columnValues"][cid] = opt["id"]

        feed["boards"].append(board)
        feed["boards"].extend(subs.values())

    review.append("\n## Totals\n")
    review.append(f"- kept: **{totals['kept']}** tasks")
    review.append(f"- skipped (Done): {totals['skipped_done']}")
    review.append(f"- comments carried: {totals['comments']}")
    review.append(f"- attachment files referenced: {totals['attachments']}")
    review.append("\n## Flags for operator\n")
    review.append("- Shaya 'Invoice sent' ×34 imported as LIVE (status → waiting) — pending your ruling; one-line change to skip instead.")
    review.append("- 'Website Invoices to refund' (2 tasks) folded into the Invoices sub-board.")
    review.append("- Shmuel board has no Item ID column — comments matched by task name. Verified: every update on a KEPT task matched; the 3 that didn't match sit on Done-skipped tasks and drop with them.")
    review.append("- Comment authors without a platform user (Avi, Racheli) keep their name as attributed text on the comment.")
    review.append("- Shaya 'Payment Status' has only ever held the value 'Paid' (33×) — dropdown ships with that one option; add Unpaid/Partial in the board UI when needed.")
    review.append("- One Shmuel task has combined Category 'Logistics, Information' (monday multi-select) — imported as its own option; re-tag by hand after import if preferred.")

    with open(os.path.join(out_dir, "import-feed.json"), "w", encoding="utf-8") as fh:
        json.dump(feed, fh, indent=2, ensure_ascii=False)
    with open(os.path.join(out_dir, "mapping-review.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(review) + "\n")

    print(f"kept={totals['kept']} skipped_done={totals['skipped_done']} "
          f"comments={totals['comments']} attachments={totals['attachments']}")
    print("wrote:", os.path.join(out_dir, "import-feed.json"))
    print("wrote:", os.path.join(out_dir, "mapping-review.md"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
