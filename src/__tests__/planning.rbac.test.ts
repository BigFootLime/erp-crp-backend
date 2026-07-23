import { describe, expect, it } from "vitest";

import {
  roleCanForcePlanningOverlap,
  roleHasPlanningAccess,
} from "../module/planning/domain/planning-rbac";

describe("planning RBAC uses exact normalized roles", () => {
  it.each([
    "Administrateur Systeme et Reseau",
    "Administrateur Système et Réseau",
    "Directeur",
    "Responsable Production",
    "Responsable Programmation",
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
});
