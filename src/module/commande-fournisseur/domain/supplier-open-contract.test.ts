import { test } from "vitest";
import assert from "node:assert/strict";
import {
  assertContractCapacity,
  assertContractWindow,
  supplierOpenContractCommandSchema,
} from "./supplier-open-contract";
test("fractional quantities keep exact three-decimal capacity", () => {
  assert.doesNotThrow(() => assertContractCapacity(0.3, 0.1, 0.2));
  assert.throws(() => assertContractCapacity(0.3, 0.1, 0.201), /quantité/);
});
test("reservations consume the remaining contract envelope", () => {
  assert.doesNotThrow(() => assertContractCapacity(100, 80, 20));
  assert.throws(() => assertContractCapacity(100, 80, 21));
});
test("amendment cannot lower its envelope below commitments", () =>
  assert.throws(() => assertContractCapacity(70, 80, 0)));
test("contract validity and delivery dates are inclusive", () => {
  assert.doesNotThrow(() =>
    assertContractWindow("2026-10-01", "2026-10-31", "2026-10-01", [
      "2026-10-31",
    ]),
  );
  assert.throws(() =>
    assertContractWindow("2026-10-01", "2026-10-31", "2026-11-01", []),
  );
  assert.throws(() =>
    assertContractWindow("2026-10-01", "2026-10-31", "2026-10-01", [
      "2026-11-01",
    ]),
  );
});
test("ambiguous duplicate mappings are refused before writing", () => {
  const key = "11111111-1111-4111-8111-111111111111";
  const result = supplierOpenContractCommandSchema.safeParse({
    action: "ATTACH",
    idempotency_key: key,
    expected_updated_at: "current",
    contract_id: key,
    expected_revision_id: key,
    reason: "appel",
    mappings: [
      { line_id: key, contract_line_id: key },
      { line_id: key, contract_line_id: key },
    ],
  });
  assert.equal(result.success, false);
});
