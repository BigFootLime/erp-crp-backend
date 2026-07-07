import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// CA-SEC-03 (ISO/IEC 27001:2022 A.8.15) — erp_audit_logs is APPEND-ONLY.
//
// The database enforces this: ownership is off the app role, cerp_app has INSERT/SELECT
// only, and an append-only trigger blocks UPDATE/DELETE/TRUNCATE
// (db/privileged/20260707_erp_audit_logs_append_only.sql).
//
// This test is the CODE-LEVEL regression guard: no application SQL may UPDATE, DELETE or
// TRUNCATE erp_audit_logs — such a statement would fail at runtime against the hardened DB
// and is therefore forbidden. If you must purge logs (retention), do it as a DBA/superuser,
// never from the application.

const SRC_DIR = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// UPDATE / DELETE / TRUNCATE targeting erp_audit_logs, within a single SQL statement
// (the [^;] boundary keeps the match inside one statement / template literal).
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: "UPDATE erp_audit_logs", re: /update\s+[^;]*\berp_audit_logs\b/is },
  { label: "DELETE FROM erp_audit_logs", re: /delete\s+from\s+[^;]*\berp_audit_logs\b/is },
  { label: "TRUNCATE erp_audit_logs", re: /truncate\s+[^;]*\berp_audit_logs\b/is },
];

describe("CA-SEC-03 — erp_audit_logs is append-only at the code level", () => {
  const files = collectSourceFiles(SRC_DIR);

  it("has application source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no UPDATE / DELETE / TRUNCATE against erp_audit_logs", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(file, "utf8");
      for (const { label, re } of FORBIDDEN) {
        if (re.test(sql)) {
          offenders.push(`${path.relative(SRC_DIR, file)} :: ${label}`);
        }
      }
    }
    expect(
      offenders,
      `erp_audit_logs is append-only (CA-SEC-03) — no app code may mutate it. Offenders:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
