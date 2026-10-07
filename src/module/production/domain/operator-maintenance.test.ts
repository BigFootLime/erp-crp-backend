import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maintenanceCommand,
  maintenanceManager,
  validateMaintenanceResults,
} from "./operator-maintenance";
const uuid = "10000000-0000-4000-8000-000000000001";
const result = {
  id: "oil",
  completed: true as const,
  conform: true,
  note: null,
};
test("All configured controls must be performed once", () => {
  assert.throws(() =>
    validateMaintenanceResults(
      [
        { id: "oil", label: "Huile" },
        { id: "guard", label: "Protecteur" },
      ],
      [result],
    ),
  );
  assert.throws(() =>
    validateMaintenanceResults(
      [{ id: "oil", label: "Huile" }],
      [result, result],
    ),
  );
  assert.throws(() => validateMaintenanceResults([], [result]));
});
test("A nonconformity blocks only when the plan requires a stop", () => {
  const controls = [
    { id: "oil", label: "Huile" },
    { id: "paint", label: "Peinture", blocks_machine: false },
  ];
  const r = [
    { ...result, conform: false, note: "Fuite réelle" },
    { ...result, id: "paint", conform: false, note: "Usure peinture" },
  ];
  assert.deepEqual(
    validateMaintenanceResults(controls, r).map((v) => v.id),
    ["oil"],
  );
});
test("Untaken controls and unexplained anomalies are rejected before writes", () => {
  const payload = {
    action: "COMPLETE",
    idempotency_key: uuid,
    plan_id: uuid,
    expected_version: 1,
    document_id: uuid,
    counter_value: null,
    notes: "Contrôles réalisés",
    results: [{ ...result, completed: false }],
  };
  assert.equal(maintenanceCommand.safeParse(payload).success, false);
  assert.equal(
    maintenanceCommand.safeParse({
      ...payload,
      results: [{ ...result, conform: false }],
    }).success,
    false,
  );
});
test("An authorization cannot expire before its validity starts", () => {
  assert.equal(
    maintenanceCommand.safeParse({
      action: "AUTHORIZE",
      idempotency_key: uuid,
      plan_id: uuid,
      user_id: 1,
      enabled: true,
      valid_from: "2026-10-08",
      valid_to: "2026-10-07",
      reason: "Formation interne",
      document_id: uuid,
    }).success,
    false,
  );
});
test("Explicit maintenance management roles include secondary roles without fuzzy escalation", () => {
  assert.equal(
    maintenanceManager(["Opérateur", "Responsable maintenance"]),
    true,
  );
  assert.equal(maintenanceManager(["Administrateur Système et Réseau"]), true);
  assert.equal(
    maintenanceManager(["Assistant responsable maintenance", "Opérateur"]),
    false,
  );
});
