import { test } from "vitest";
import assert from "node:assert/strict";
import {
  reviewDate,
  reviewNextDate,
  supplierReviewCommand,
} from "./supplier-periodic-review";
test("rejects impossible calendar dates", () => {
  assert.equal(reviewDate.safeParse("2026-02-30").success, false);
  assert.equal(reviewDate.safeParse("2028-02-29").success, true);
});
test("clamps cadence to end of month", () => {
  assert.equal(reviewNextDate("2026-01-31", 1), "2026-02-28");
  assert.equal(reviewNextDate("2028-01-31", 1), "2028-02-29");
});
test("keeps yearly leap cadence", () =>
  assert.equal(reviewNextDate("2028-02-29", 12), "2029-02-28"));
const evaluation = {
  action: "EVALUATE",
  idempotency_key: "10000000-0000-4000-8000-000000000001",
  scope_id: "10000000-0000-4000-8000-000000000002",
  expected_policy_id: "10000000-0000-4000-8000-000000000003",
  version_id: "10000000-0000-4000-8000-000000000004",
  period_from: "2026-01-01",
  period_to: "2026-06-30",
  evaluated_on: "2026-07-01",
  next_due: "2027-07-01",
  outcome: "SATISFACTORY",
  quality_score: null,
  delivery_score: null,
  responsiveness_score: null,
  observations: "Méthode renseignée",
  actions: "Suivi annuel",
  supersedes_id: null,
  correction_reason: null,
};
test("allows an evidenced evaluation without fabricated scores", () =>
  assert.equal(supplierReviewCommand.safeParse(evaluation).success, true));
test("rejects chronology and correction without reason", () => {
  assert.equal(
    supplierReviewCommand.safeParse({
      ...evaluation,
      evaluated_on: "2026-06-01",
    }).success,
    false,
  );
  assert.equal(
    supplierReviewCommand.safeParse({
      ...evaluation,
      supersedes_id: evaluation.scope_id,
    }).success,
    false,
  );
});
