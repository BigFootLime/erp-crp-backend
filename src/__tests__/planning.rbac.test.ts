import { describe, expect, it } from "vitest";

import {
  roleCanForcePlanningOverlap,
  roleHasPlanningAccess,
  roleHasPlanningCapability,
} from "../module/planning/domain/planning-rbac";
import { runWithAccountModuleAccess } from "../module/access-control/context/account-module-access.context";

describe("planning RBAC uses exact normalized roles", () => {
  it.each([
    "Administrateur Systeme et Reseau",
    "Administrateur Système et Réseau",
    "Directeur",
    "Responsable Production",
    "Responsable Programmation",
    "Planning",
    "Planification",
    "Responsable Atelier",
    "Chef Atelier",
    "Operateur Atelier",
    "Atelier",
    "Production",
    "Secretaire",
    "Secrétariat",
  ])("allows the known planning role %s", (role) => {
    expect(roleHasPlanningAccess(role)).toBe(true);
  });

  it.each(["Administratif", "Employee", "Responsable Qualité", "Comptabilite", "", undefined])(
    "denies unrelated role %s",
    (role) => {
      expect(roleHasPlanningAccess(role)).toBe(false);
    }
  );

  it.each([
    "Administrateur Systeme et Reseau",
    "Directeur",
    "Responsable Production",
    "Responsable Atelier",
    "Chef Atelier",
  ])("allows force-overlap only for a decision role: %s", (role) => {
    expect(roleCanForcePlanningOverlap(role)).toBe(true);
  });

  it.each(["Administratif", "Responsable Programmation", "Operateur Atelier", "Atelier", "Secretaire"])(
    "denies force-overlap for %s",
    (role) => {
      expect(roleCanForcePlanningOverlap(role)).toBe(false);
    }
  );

  it("lets an account-level Production grant supersede legacy role fallbacks", () => {
    runWithAccountModuleAccess(
      { userId: 42, moduleKey: "Production" },
      () => {
        expect(roleHasPlanningAccess("Employee")).toBe(true);
        expect(roleCanForcePlanningOverlap("Employee")).toBe(true);
        // Fine-grained SOL-21 capabilities remain role-backed. The request
        // middleware separately recognizes an explicit elevated account grant.
        expect(roleHasPlanningCapability("Employee", "manage_schedule")).toBe(false);
      }
    );
  });

  it("separates operator, supervisor and planner capabilities", () => {
    expect(roleHasPlanningCapability("Operateur Atelier", "read")).toBe(true);
    expect(roleHasPlanningCapability("Operateur Atelier", "manage_preferences")).toBe(true);
    expect(roleHasPlanningCapability("Operateur Atelier", "read_capacity")).toBe(false);
    expect(roleHasPlanningCapability("Operateur Atelier", "manage_schedule")).toBe(false);

    expect(roleHasPlanningCapability("Chef Atelier", "read_capacity")).toBe(true);
    expect(roleHasPlanningCapability("Chef Atelier", "supervise_execution")).toBe(true);
    expect(roleHasPlanningCapability("Chef Atelier", "manage_schedule")).toBe(true);

    expect(roleHasPlanningCapability("Responsable Programmation", "manage_schedule")).toBe(true);
    expect(roleHasPlanningCapability("Responsable Programmation", "supervise_execution")).toBe(false);
  });

});
