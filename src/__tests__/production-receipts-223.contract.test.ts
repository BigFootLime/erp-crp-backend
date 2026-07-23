import { describe, expect, it } from "vitest";

import { roleHasOfCapability } from "../module/production/domain/of-rbac";
import { ofReceiptBodySchema } from "../module/production/validators/production.validators";

const base = {
  qty_ok: 4,
  qty_scrap: 0,
  qty_rework: 0,
  location_id: "88888888-8888-8888-8888-888888888888",
  lot_mode: "NEW" as const,
  quality_status: "LIBERE" as const,
  expected_of_updated_at: "2026-07-23T10:00:00.000+02:00",
};

describe("#223 production receipt contract", () => {
  it("normalizes optional scrap and rework quantities", () => {
    const parsed = ofReceiptBodySchema.parse({
      qty_ok: 4,
      location_id: base.location_id,
      lot_mode: "NEW",
      quality_status: "LIBERE",
      expected_of_updated_at: base.expected_of_updated_at,
    });
    expect(parsed).toMatchObject({ qty_scrap: 0, qty_rework: 0 });
  });

  it.each(["QUARANTAINE", "BLOQUE"] as const)("requires a quality reason for %s", (quality_status) => {
    const parsed = ofReceiptBodySchema.safeParse({ ...base, quality_status });
    expect(parsed.success).toBe(false);
  });

  it.each(["LIBERE", "QUARANTAINE", "BLOQUE"] as const)("accepts the governed quality state %s", (quality_status) => {
    const parsed = ofReceiptBodySchema.safeParse({
      ...base,
      quality_status,
      quality_reason: quality_status === "LIBERE" ? null : "Decision qualite documentee",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires an existing lot id in EXISTING mode", () => {
    expect(ofReceiptBodySchema.safeParse({ ...base, lot_mode: "EXISTING" }).success).toBe(false);
  });

  it("rejects an existing lot id in NEW mode", () => {
    expect(
      ofReceiptBodySchema.safeParse({ ...base, lot_id: "11111111-1111-1111-1111-111111111111" }).success
    ).toBe(false);
  });

  it("rejects zero good quantity and negative quality quantities", () => {
    expect(ofReceiptBodySchema.safeParse({ ...base, qty_ok: 0 }).success).toBe(false);
    expect(ofReceiptBodySchema.safeParse({ ...base, qty_scrap: -1 }).success).toBe(false);
    expect(ofReceiptBodySchema.safeParse({ ...base, qty_rework: -1 }).success).toBe(false);
  });
});

describe("#223 quality decision RBAC", () => {
  it.each(["Administrateur", "Directeur industriel", "Responsable Production", "Responsable Qualite"])(
    "allows governed release for %s",
    (role) => {
      expect(roleHasOfCapability(role, "quality_decision")).toBe(true);
    }
  );

  it.each(["Operateur Atelier", "Logistique", "Comptabilite", "Employe"])(
    "keeps direct release denied for %s",
    (role) => {
      expect(roleHasOfCapability(role, "quality_decision")).toBe(false);
    }
  );

  it("allows quality to receive and decide, while workshop can only receive", () => {
    expect(roleHasOfCapability("Responsable Qualite", "receipt")).toBe(true);
    expect(roleHasOfCapability("Responsable Qualite", "quality_decision")).toBe(true);
    expect(roleHasOfCapability("Operateur Atelier", "receipt")).toBe(true);
    expect(roleHasOfCapability("Operateur Atelier", "quality_decision")).toBe(false);
  });
});
