// Regression test: customer paymentTerms stays out of the QB sync's
// UPDATE set. Backstory: the 30-minute sync used to overwrite
// customers.paymentTerms with QBO's SalesTermRef.name on every update,
// which silently wiped operator-managed terms (and the Monday
// backfill) every half-hour because most customers in QBO don't have
// SalesTermRef set. The fix was to drop paymentTerms from the UPDATE
// set + audit override, making the field locally authoritative.
//
// This test asserts that invariant against the source file directly —
// a string scan rather than a runtime test because the surrounding
// function is heavily DB-coupled. If anyone re-adds paymentTerms to
// the UPDATE set object, this fails fast.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "sync.ts"), "utf8");

// Fields that finance-hub is authoritative on. The QB sync should
// neither write them on UPDATE nor claim transitions for them in the
// audit-after block. Re-adding any of these to either spot resurrects
// the silent-wipe class of bug.
const LOCAL_AUTHORITATIVE_FIELDS = [
  "paymentTerms",
  "primaryEmail",
  "billingEmails",
];

describe("syncCustomers UPDATE invariants", () => {
  it("the .set({…}) block on the drift-update path excludes locally-authoritative fields", () => {
    // Locate the *drift* UPDATE — the one with displayName + several
    // address fields. The other update() in this file is the noop
    // lastSyncedAt-only bump (no .set call worth scanning), so this
    // anchor is unique.
    const startMarker = ".update(customers)\n    .set({\n      displayName";
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    // Read until the closing }) of the .set object.
    const closeIdx = source.indexOf("})", startIdx);
    expect(closeIdx).toBeGreaterThan(startIdx);
    const block = source.slice(startIdx, closeIdx);
    for (const field of LOCAL_AUTHORITATIVE_FIELDS) {
      expect(block, `field "${field}" leaked into the UPDATE set`).not.toMatch(
        new RegExp(`\\b${field}\\b`),
      );
    }
  });

  it("the audit-after override block excludes locally-authoritative fields", () => {
    // The audit insert's `after` field spreads serializableCustomer
    // (which DOES include the fields above — that's the source of
    // truth for the BEFORE snapshot) and overrides specific keys.
    // The override block must NOT mention those fields, otherwise
    // the audit would claim a transition the UPDATE never performed.
    const startMarker = "after: {\n      ...serializableCustomer(before),";
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    const closeIdx = source.indexOf("},\n  });", startIdx);
    expect(closeIdx).toBeGreaterThan(startIdx);
    const block = source.slice(startIdx, closeIdx);
    for (const field of LOCAL_AUTHORITATIVE_FIELDS) {
      expect(
        block,
        `field "${field}:" leaked into the audit-after override`,
      ).not.toMatch(new RegExp(`\\b${field}:`));
    }
  });
});
