import { describe, expect, it } from "vitest";

import { roleHasFinanceCapability } from "../facturation/domain/finance-policy";

describe("SOL-27 accounting export RBAC", () => {
  it("denies anonymous, standard and secretary roles", () => {
    for (const role of [null, "Programmeur", "Secretaire", "Logistique"]) {
      expect(roleHasFinanceCapability(role, "accounting_export_read")).toBe(false);
      expect(roleHasFinanceCapability(role, "accounting_export_execute")).toBe(false);
      expect(roleHasFinanceCapability(role, "accounting_export_admin")).toBe(false);
    }
  });

  it("separates finance execution from mapping administration", () => {
    for (const role of ["Comptabilite", "Comptable"]) {
      expect(roleHasFinanceCapability(role, "accounting_export_read")).toBe(true);
      expect(roleHasFinanceCapability(role, "accounting_export_execute")).toBe(true);
      expect(roleHasFinanceCapability(role, "accounting_export_admin")).toBe(false);
    }
    expect(roleHasFinanceCapability("Directeur", "accounting_export_admin")).toBe(true);
    expect(roleHasFinanceCapability("Administrateur Systeme et Reseau", "accounting_export_admin")).toBe(true);
  });
});
