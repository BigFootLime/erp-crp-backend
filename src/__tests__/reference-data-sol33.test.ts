import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertReferenceEffectiveDateAllowed,
  assertReferenceSnapshotFresh,
  changedFields,
  referenceDataCapabilitiesFor,
  referencePayloadHash,
} from "../module/reference-data/domain/reference-data-policy";
import {
  createReferenceChangeSetSchema,
  referencePreviewSchema,
} from "../module/reference-data/validators/reference-data.validators";

const futureDate = "2099-01-01";

describe("SOL-33 reference-data policy", () => {
  it("keeps hashes deterministic and distinguishes a missing value from zero", () => {
    expect(referencePayloadHash({ b: 2, a: { y: 0 } })).toBe(referencePayloadHash({ a: { y: 0 }, b: 2 }));
    expect(changedFields({ amount: null }, { amount: 0 })).toEqual(["amount"]);
  });

  it("refuses silent retroactivity and stale optimistic snapshots", () => {
    expect(() => assertReferenceEffectiveDateAllowed("2026-08-14", "2026-08-15")).toThrowError(
      expect.objectContaining({ code: "RETROACTIVE_REFERENCE_CHANGE_FORBIDDEN", status: 422 })
    );
    expect(() => assertReferenceSnapshotFresh("a".repeat(64), "b".repeat(64))).toThrowError(
      expect.objectContaining({ code: "REFERENCE_SNAPSHOT_STALE", status: 409 })
    );
  });

  it("separates proposal and approval capabilities", () => {
    expect(referenceDataCapabilitiesFor("Méthodes")).toMatchObject({ view: true, propose: true, approve: false, apply: false });
    expect(referenceDataCapabilitiesFor("Administrateur")).toMatchObject({ view: true, propose: true, approve: true, apply: true });
    expect(referenceDataCapabilitiesFor("Opérateur atelier")).toEqual({
      view: false, export: false, propose: false, import: false, approve: false, apply: false,
    });
  });
});

describe("SOL-33 numerical and dependency validation", () => {
  const base = {
    effective_from: futureDate,
    effective_to: null,
    reason: "Révision annuelle documentée",
    source: "Décision de gestion validée",
    reliability: "DECLARED" as const,
  };

  it("accepts an explicit zero material cost but rejects a zero conversion factor", () => {
    expect(referencePreviewSchema.safeParse({ ...base, changes: [{
      dataset_code: "MATERIAL_COSTS", record_key: "00000000-0000-4000-8000-000000000001",
      value: { unit_price: 0, currency: "EUR" },
    }] }).success).toBe(true);
    expect(referencePreviewSchema.safeParse({ ...base, changes: [{
      dataset_code: "UNIT_CONVERSIONS", record_key: "00000000-0000-4000-8000-000000000001",
      value: { purchase_unit: "kg", stock_unit: "u", factor: 0 },
    }] }).success).toBe(false);
    expect(referencePreviewSchema.safeParse({ ...base, changes: [{
      dataset_code: "UNIT_CONVERSIONS", record_key: "00000000-0000-4000-8000-000000000001",
      value: { purchase_unit: "kg", stock_unit: "KG", factor: 2 },
    }] }).success).toBe(false);
  });

  it("rejects overlapping duplicate entries in one import and incoherent calendars", () => {
    const same = {
      dataset_code: "SUPPLIER_LEAD_TIMES" as const,
      record_key: "00000000-0000-4000-8000-000000000001",
      value: { lead_time_days: 10 },
    };
    expect(createReferenceChangeSetSchema.safeParse({ ...base, idempotency_key: "sol33-test-1", changes: [same, same] }).success).toBe(false);
    expect(referencePreviewSchema.safeParse({ ...base, changes: [{
      dataset_code: "PRODUCTION_CALENDARS", record_key: "CAL-TEST",
      value: { code: "CAL-TEST", label: "Atelier", timezone: "Europe/Paris", working_days: [1, 1], day_start: "17:00", day_end: "08:00", active: true },
    }] }).success).toBe(false);
  });
});

describe("SOL-33 migration history and concurrency guards", () => {
  const patch = fs.readFileSync(path.resolve("db/patches/20260815_reference_data_center_sol33.sql"), "utf8");

  it("creates immutable decision/version evidence and a four-eyes database constraint", () => {
    expect(patch).toContain("reference_data_versions_guard");
    expect(patch).toContain("reference_data_decisions_append_only");
    expect(patch).toContain("approved_by <> proposed_by");
    expect(patch).toContain("pg_advisory_xact_lock");
  });

  it("ships explicit preflight, verification and guarded rollback", () => {
    for (const suffix of ["preflight", "verify", "rollback"]) {
      expect(fs.existsSync(path.resolve(`db/patches/support/20260815_reference_data_center_sol33.${suffix}.sql`))).toBe(true);
    }
    const rollback = fs.readFileSync(path.resolve("db/patches/support/20260815_reference_data_center_sol33.rollback.sql"), "utf8");
    expect(rollback).toContain("rollback refused");
  });
});
