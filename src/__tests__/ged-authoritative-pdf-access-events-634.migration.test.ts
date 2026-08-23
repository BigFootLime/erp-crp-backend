import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const base = "20260823_ged_authoritative_pdf_access_events_634";
const patch = fs.readFileSync(path.join(root, "db", "patches", `${base}.sql`), "utf8");
const support = (kind: "preflight" | "verify" | "rollback") =>
  fs.readFileSync(path.join(root, "db", "patches", "support", `${base}.${kind}.sql`), "utf8");

const legacyEvents = [
  "UPLOAD", "READ", "DOWNLOAD", "SUBMIT", "APPROVE", "REJECT", "PUBLISH", "OBSOLETE", "ARCHIVE", "CHECKOUT", "CHECKIN",
  "HOLD_PLACED", "HOLD_RELEASED", "INTEGRITY_FAILURE", "SCAN_PENDING", "SCAN_CLEAN", "SCAN_INFECTED", "SCAN_FAILED",
  "QUARANTINED", "QUARANTINE_RELEASED", "QUARANTINE_DELETED",
];
const authoritativeEvents = [
  "AUTHORITATIVE_PDF_ARCHIVED", "AUTHORITATIVE_PDF_PREVIEWED", "AUTHORITATIVE_PDF_DOWNLOADED",
  "AUTHORITATIVE_PDF_PRINT_INTENT", "AUTHORITATIVE_PDF_SENT", "CREATION_SNAPSHOT_ARCHIVED",
];

describe("#634 GED authoritative-PDF audit-event migration contract", () => {
  it("is additive over every historical GED/antivirus event and includes every source audit event", () => {
    for (const event of [...legacyEvents, ...authoritativeEvents]) expect(patch).toContain(`'${event}'`);
    expect(authoritativeEvents).toHaveLength(6);
    expect(patch).toContain("GED_AUTHORITATIVE_EVENTS_634_UNKNOWN_EXISTING_EVENT_TYPE");
    expect(patch).toContain("DROP CONSTRAINT IF EXISTS ged_access_events_event_type_check");
  });

  it("ships read-only preflight/verification plus a non-lossy rehearsal-only rollback", () => {
    for (const sql of [support("preflight"), support("verify")]) {
      expect(sql).toContain("BEGIN TRANSACTION READ ONLY");
      for (const event of [...legacyEvents, ...authoritativeEvents]) expect(sql).toContain(`'${event}'`);
    }
    const rollback = support("rollback");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("cerp.migration_rehearsal");
    expect(rollback).toContain("GED_AUTHORITATIVE_EVENTS_634_ROLLBACK_REFUSED_AUTHORITATIVE_EVIDENCE_EXISTS");
    for (const event of legacyEvents) expect(rollback).toContain(`'${event}'`);
    for (const event of authoritativeEvents) expect(rollback).toContain(`'${event}'`);
  });
});
