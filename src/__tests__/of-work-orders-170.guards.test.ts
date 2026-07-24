// #170 — gardes de migration et automates OF.
// Même approche que codification-vsm-guards.test.ts : le SQL du patch est la
// vérité vérifiable sans base réelle ; les automates sont testés en pur.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import {
  OF_STATUTS,
  OF_STATUT_TRANSITIONS,
  canTransitionOfStatut,
  canTransitionOfOperationStatus,
  isOfPrelaunch,
  ofOperationsAllowReorder,
  ofStatutAllowsExecution,
  ofStatutAllowsReceipt,
} from "../module/production/domain/of-status";
import { capabilityForOfTransition, roleHasOfCapability } from "../module/production/domain/of-rbac";

const patchPath = path.resolve(__dirname, "..", "..", "db", "patches", "20260722_of_work_orders_170.sql");
const rollbackPath = path.resolve(__dirname, "..", "..", "db", "patches", "support", "20260722_of_work_orders_170.rollback.sql");
const verifyPath = path.resolve(__dirname, "..", "..", "db", "patches", "support", "20260722_of_work_orders_170.verify.sql");

describe("#170 migration guards (SQL as verifiable truth)", () => {
  const patch = fs.readFileSync(patchPath, "utf8");

  it("is additive and idempotent (IF NOT EXISTS everywhere, no destructive statement)", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.of_output_lots");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS idempotency_key");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS source_hash");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS result");
    expect(patch).not.toMatch(/\bDROP TABLE\b/i);
    expect(patch).not.toMatch(/\bDELETE FROM public\./i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("enforces one batch per idempotency key", () => {
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS of_generation_batches_idempotency_uq");
    expect(patch).toMatch(/idempotency_key\s*\)\s*\n?\s*WHERE idempotency_key IS NOT NULL/);
  });

  it("protects published snapshots and batches against UPDATE/DELETE", () => {
    expect(patch).toContain("trg_prevent_of_structure_snapshot_mutation");
    expect(patch).toContain("BEFORE UPDATE OR DELETE ON public.of_structure_snapshot");
    expect(patch).toContain("trg_protect_of_generation_batch");
    expect(patch).toContain("BEFORE UPDATE OR DELETE ON public.of_generation_batches");
    expect(patch).toContain("trg_prevent_of_numero_mutation");
  });

  it("keeps preflight prerequisites for the #55/#141 ecosystem", () => {
    expect(patch).toContain("to_regclass('public.of_generation_batches')");
    expect(patch).toContain("to_regclass('public.of_technical_snapshots')");
    expect(patch).toContain("fn_next_issued_code_value");
  });

  it("ships a conservative rollback that refuses to destroy business rows", () => {
    const rollback = fs.readFileSync(rollbackPath, "utf8");
    expect(rollback).toContain("rollback refused: business rows exist");
    expect(rollback).toContain("DROP TRIGGER IF EXISTS trg_protect_of_generation_batch");
  });

  it("ships a verify script probing the immutability triggers", () => {
    const verify = fs.readFileSync(verifyPath, "utf8");
    expect(verify).toContain("trg_prevent_of_structure_snapshot_mutation");
    expect(verify).toContain("verify FAILED");
  });
});

describe("#170 OF status machine", () => {
  it("declares every statut exactly once with its transitions", () => {
    expect(Object.keys(OF_STATUT_TRANSITIONS).sort()).toEqual([...OF_STATUTS].sort());
  });

  it("accepts the nominal life-cycle", () => {
    expect(canTransitionOfStatut("BROUILLON", "PLANIFIE")).toBe(true);
    expect(canTransitionOfStatut("PLANIFIE", "EN_COURS")).toBe(true);
    expect(canTransitionOfStatut("EN_COURS", "EN_PAUSE")).toBe(true);
    expect(canTransitionOfStatut("EN_PAUSE", "EN_COURS")).toBe(true);
    expect(canTransitionOfStatut("EN_COURS", "TERMINE")).toBe(true);
    expect(canTransitionOfStatut("TERMINE", "CLOTURE")).toBe(true);
  });

  it("keeps CLOTURE and ANNULE terminal", () => {
    for (const to of OF_STATUTS) {
      if (to !== "CLOTURE") expect(canTransitionOfStatut("CLOTURE", to)).toBe(false);
      if (to !== "ANNULE") expect(canTransitionOfStatut("ANNULE", to)).toBe(false);
    }
  });

  it("refuses shortcuts (BROUILLON -> TERMINE/CLOTURE)", () => {
    expect(canTransitionOfStatut("BROUILLON", "TERMINE")).toBe(false);
    expect(canTransitionOfStatut("BROUILLON", "CLOTURE")).toBe(false);
  });

  it("scopes prelaunch / execution / receipt statuses coherently", () => {
    expect(isOfPrelaunch("BROUILLON")).toBe(true);
    expect(isOfPrelaunch("EN_COURS")).toBe(false);
    expect(ofStatutAllowsExecution("EN_PAUSE")).toBe(true);
    expect(ofStatutAllowsExecution("ANNULE")).toBe(false);
    expect(ofStatutAllowsReceipt("TERMINE")).toBe(true);
    expect(ofStatutAllowsReceipt("BROUILLON")).toBe(false);
    expect(ofStatutAllowsReceipt("CLOTURE")).toBe(false);
  });
});

describe("#170 operation status machine", () => {
  it("accepts the nominal path and the controlled reopen", () => {
    expect(canTransitionOfOperationStatus("TODO", "READY")).toBe(true);
    expect(canTransitionOfOperationStatus("READY", "RUNNING")).toBe(true);
    expect(canTransitionOfOperationStatus("RUNNING", "DONE")).toBe(true);
    expect(canTransitionOfOperationStatus("DONE", "READY")).toBe(true);
    expect(canTransitionOfOperationStatus("DONE", "RUNNING")).toBe(false);
    expect(canTransitionOfOperationStatus("BLOCKED", "READY")).toBe(true);
  });

  it("only allows reorder while nothing has started", () => {
    expect(ofOperationsAllowReorder(["TODO", "READY"])).toBe(true);
    expect(ofOperationsAllowReorder(["TODO", "RUNNING"])).toBe(false);
    expect(ofOperationsAllowReorder(["DONE"])).toBe(false);
  });
});

describe("#170 OF RBAC capabilities", () => {
  it("denies by default (empty/unknown roles)", () => {
    expect(roleHasOfCapability("", "read")).toBe(false);
    expect(roleHasOfCapability(null, "generate")).toBe(false);
    expect(roleHasOfCapability("Employe", "operate")).toBe(false);
  });

  it("maps transition targets to distinct capabilities", () => {
    expect(capabilityForOfTransition("EN_COURS", "ANNULE")).toBe("cancel");
    expect(capabilityForOfTransition("TERMINE", "CLOTURE")).toBe("archive");
    expect(capabilityForOfTransition("BROUILLON", "EN_COURS")).toBe("launch");
    expect(capabilityForOfTransition("PLANIFIE", "BROUILLON")).toBe("edit_prelaunch");
  });

  it("keeps archive/cancel above operator roles", () => {
    expect(roleHasOfCapability("Operateur Atelier", "operate")).toBe(true);
    expect(roleHasOfCapability("Operateur Atelier", "cancel")).toBe(false);
    expect(roleHasOfCapability("Operateur Atelier", "archive")).toBe(false);
    expect(roleHasOfCapability("Responsable Production", "cancel")).toBe(true);
    expect(roleHasOfCapability("Directeur General", "archive")).toBe(true);
  });
});
