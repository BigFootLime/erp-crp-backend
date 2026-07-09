import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { roles } from "../module/auth/validators/user.validator";

// T1 — module « Temps & Déplacements » : schéma DB + append-only + rôle RH.
// Tests « de base » sans base de données (le comportement runtime append-only est prouvé
// par db/privileged/*.verify.sql sur cerp_test). Ici on garantit : vocabulaire RBAC,
// idempotence/additivité de la migration, et présence du hardening append-only.

const root = process.cwd();
const additive = readFileSync(resolve(root, "db/patches/20260709_hr_temps_deplacements.sql"), "utf8");
const appendOnly = readFileSync(resolve(root, "db/privileged/20260709_hr_time_events_append_only.sql"), "utf8");

const HR_TABLES = [
  "hr_employees", "hr_time_rule_sets", "hr_employment_contracts", "hr_work_schedules",
  "hr_time_clock_devices", "hr_badge_credentials", "hr_time_events", "hr_work_sessions",
  "hr_timesheet_days", "hr_timesheet_weeks", "hr_time_adjustments", "hr_time_anomalies",
  "hr_vehicles", "hr_kilometer_entries", "hr_payroll_export_batches",
];

describe("T1 Temps & Déplacements — vocabulaire RBAC", () => {
  it("ajoute le rôle 'Responsable RH'", () => {
    expect(roles).toContain("Responsable RH");
  });
  it("conserve les rôles existants (compatibilité ascendante)", () => {
    for (const r of [
      "Directeur", "Employee", "Administrateur Systeme et Reseau",
      "Responsable Qualité", "Secretaire", "Responsable Programmation",
    ]) {
      expect(roles).toContain(r);
    }
  });
});

describe("T1 — migration additive idempotente (db/patches)", () => {
  it("crée les 15 tables hr_* en IF NOT EXISTS", () => {
    for (const t of HR_TABLES) {
      expect(additive).toContain(`CREATE TABLE IF NOT EXISTS public.${t} `);
    }
  });
  it("est purement additive (aucun DROP TABLE/COLUMN/TYPE)", () => {
    expect(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i.test(additive)).toBe(false);
  });
  it("garde les enums (DO $$ … IF NOT EXISTS pg_type)", () => {
    expect(additive).toContain("IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_event_type')");
  });
  it("impose reason non vide + interdit l'auto-validation des corrections", () => {
    expect(additive).toContain("hr_time_adjustments_reason_ck");
    expect(additive).toContain("hr_time_adjustments_no_self_approve_ck");
  });
});

describe("T1 — hr_time_events append-only (db/privileged)", () => {
  it("déplace la propriété hors du rôle applicatif", () => {
    expect(appendOnly).toContain("ALTER TABLE public.hr_time_events OWNER TO postgres");
  });
  it("restreint cerp_app à SELECT/INSERT (pas d'UPDATE/DELETE)", () => {
    expect(appendOnly).toContain("GRANT SELECT, INSERT ON public.hr_time_events TO cerp_app");
    expect(appendOnly).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON public.hr_time_events FROM PUBLIC");
  });
  it("pose les 3 triggers de blocage UPDATE/DELETE/TRUNCATE", () => {
    for (const trg of [
      "trg_hr_time_events_no_update",
      "trg_hr_time_events_no_delete",
      "trg_hr_time_events_no_truncate",
    ]) {
      expect(appendOnly).toContain(trg);
    }
  });
});
