import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("SOL-30 migration guards", () => {
  const patch = read("db/patches/20260814_identification_labels_sol30.sql");
  const preflight = read("db/patches/support/20260814_identification_labels_sol30.preflight.sql");
  const verify = read("db/patches/support/20260814_identification_labels_sol30.verify.sql");
  const rollback = read("db/patches/support/20260814_identification_labels_sol30.rollback.sql");

  it("stores only a public identifier and a payload digest", () => {
    expect(patch).toContain("public_id uuid NOT NULL UNIQUE");
    expect(patch).toContain("payload_sha256 text NOT NULL");
    expect(patch).not.toMatch(/raw_payload|raw_code|secret|token/i);
  });

  it("enforces one active label and idempotent scan and command identities", () => {
    expect(patch).toContain("identification_labels_active_entity_uq");
    expect(patch).toContain("event_id uuid NOT NULL UNIQUE");
    expect(patch).toContain("CONSTRAINT identification_receipt_uq UNIQUE");
  });

  it("keeps print, scan, command and audit evidence append-only", () => {
    expect(patch.match(/fn_identification_evidence_immutable_sol30/g)?.length).toBeGreaterThanOrEqual(5);
    expect(verify).toContain("immutable evidence triggers are incomplete");
    expect(verify).toContain("immutable audit trigger did not reject an update");
  });

  it("ships a complete preflight, verification and evidence-aware rollback", () => {
    expect(preflight).toContain("missing relation(s)");
    expect(preflight).toContain("gen_random_uuid() is unavailable");
    expect(verify).toContain("duplicate active labels detected");
    expect(rollback).toContain("rollback refused: label or audit evidence exists");
    expect(rollback).toContain("rollback verification failed");
  });
});
