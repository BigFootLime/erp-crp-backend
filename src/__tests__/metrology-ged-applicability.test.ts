import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { CLOSED_SEED, resolveClosedSeedApplicability } = require("../../scripts/migrations/metrology-ged-applicability.js") as {
  CLOSED_SEED: string;
  resolveClosedSeedApplicability: (
    client: { query: ReturnType<typeof vi.fn> },
    patches: Array<{ filename: string; sha256: string }>,
    applied: Map<string, { sha256: string }>,
  ) => Promise<Map<string, { status: string; reason: string }>>;
};

const names = [
  CLOSED_SEED,
  "20261027_metrology_ged_entity_type_1780_compat.sql",
  "20261014_finance_ged_profile_1268.sql",
  "20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql",
  "20261027_metrology_scan_documents_1780.sql",
];
const patches = names.map((filename, index) => ({ filename, sha256: `hash-${index}` }));
const exactState = {
  closed_guard_present: false,
  entity_catalog_present: true,
  class_catalog_present: true,
  equipment_catalog_present: true,
  entity_value_exact: true,
  class_value_exact: true,
};

function ledger(overrides: Record<string, string> = {}) {
  return new Map(patches
    .filter((patch) => patch.filename !== CLOSED_SEED)
    .map((patch) => [patch.filename, { sha256: overrides[patch.filename] ?? patch.sha256 }]));
}

function client(state = exactState) {
  return { query: vi.fn().mockResolvedValue({ rows: [state] }) };
}

describe("metrology GED closed seed applicability", () => {
  it("reports the closed seed as non-applicable only for the exact Finance compatibility profile", async () => {
    const db = client();
    await expect(resolveClosedSeedApplicability(db, patches, ledger())).resolves.toEqual(new Map([[CLOSED_SEED, {
      status: "not-applicable-finance-profile",
      reason: "FINANCE_PROFILE_COMPAT_SUPERSEDES_CLOSED_SEED",
    }]]));
  });

  it("keeps the closed seed pending while the compatibility seed is absent", async () => {
    const applied = ledger();
    applied.delete("20261027_metrology_ged_entity_type_1780_compat.sql");
    const db = client();
    await expect(resolveClosedSeedApplicability(db, patches, applied)).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });

  it("keeps the closed seed pending while the scan postcondition is not yet recorded", async () => {
    const applied = ledger();
    applied.delete("20261027_metrology_scan_documents_1780.sql");
    const db = client();
    await expect(resolveClosedSeedApplicability(db, patches, applied)).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });

  it("keeps the closed seed applicable when the closed GED guard is present", async () => {
    await expect(resolveClosedSeedApplicability(client({ ...exactState, closed_guard_present: true }), patches, ledger()))
      .resolves.toEqual(new Map());
  });

  it("preserves a genuinely applied closed seed without resolving the profile", async () => {
    const applied = ledger();
    applied.set(CLOSED_SEED, { sha256: patches[0].sha256 });
    const db = client();
    await expect(resolveClosedSeedApplicability(db, patches, applied)).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fails closed when a required compatibility ledger checksum differs", async () => {
    await expect(resolveClosedSeedApplicability(client(), patches, ledger({
      "20261027_metrology_ged_entity_type_1780_compat.sql": "tampered",
    }))).rejects.toThrow(/absent outside the exact Finance compatibility profile/);
  });

  it.each(["entity_value_exact", "class_value_exact"])("fails closed when %s is altered", async (field) => {
    await expect(resolveClosedSeedApplicability(client({ ...exactState, [field]: false }), patches, ledger()))
      .rejects.toThrow(/absent outside the exact Finance compatibility profile/);
  });
});
