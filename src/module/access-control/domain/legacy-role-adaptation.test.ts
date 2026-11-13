import { describe, expect, it } from "vitest";

import { hasLegacyRoleFragment } from "./legacy-role-adaptation";

describe("hasLegacyRoleFragment", () => {
  it("preserves the historical trim, case-folding and substring semantics", () => {
    expect(hasLegacyRoleFragment("  Responsable Production  ", ["production", "atelier"])).toBe(true);
    expect(hasLegacyRoleFragment("Administrateur Système", ["admin", "administrateur"])).toBe(true);
    expect(hasLegacyRoleFragment("Responsable Qualité", ["qualit", "quality", "qse"])).toBe(true);
    expect(hasLegacyRoleFragment("Quality Manager", ["qualit", "quality", "qse"])).toBe(true);
    expect(hasLegacyRoleFragment("QSE", ["qualit", "quality", "qse"])).toBe(true);
  });

  it("does not grant an absent or unrelated historical role", () => {
    expect(hasLegacyRoleFragment(undefined, ["admin"])).toBe(false);
    expect(hasLegacyRoleFragment("Employé", ["production", "atelier", "secretaire", "secretariat"])).toBe(false);
    expect(hasLegacyRoleFragment("Logistique", ["qualit", "quality", "qse"])).toBe(false);
  });
});
