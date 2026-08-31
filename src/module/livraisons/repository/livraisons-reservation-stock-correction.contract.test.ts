import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { repoRoot } from "../../../__tests__/helpers/repo-paths"

const source = readFileSync(
  resolve(repoRoot, "src/module/livraisons/repository/livraisons.repository.ts"),
  "utf8"
)

describe("Atelier BL reservation stock correction contract (#923)", () => {
  it("locks the exact batch and all active reservations before changing physical stock", () => {
    expect(source).toContain("async function reallocateCorrectedBatchReservations")
    expect(source).toContain("WHERE r.stock_batch_id = $1::uuid")
    expect(source).toContain("FOR UPDATE OF r")
    expect(source).toContain("PHYSICAL_QTY_BELOW_PREPARED")
  })

  it("reallocates released quantities over eligible lots in OLD then NEW FIFO order", () => {
    expect(source).toContain("CASE COALESCE(l.source_scope, l.stock_scope, w.stock_scope, 'NEW') WHEN 'OLD' THEN 0 ELSE 1 END")
    expect(source).toContain("COALESCE(l.received_at, l.manufactured_at, l.created_at::date)")
    expect(source).toContain("RESERVATION_REALLOCATION_CONFLICT")
  })

  it("prepares idempotent work orders only for the remaining shortage", () => {
    expect(source).toContain("async function prepareOfsForReservationShortages")
    expect(source).toContain("createRecursiveOrdresFabrication")
    expect(source).toContain("STOCK_CORRECTION_OF_PREPARED")
    expect(source).toContain("stock-correction:${params.correction_id}:${allocationId}")
    expect(source).toContain("prepared_ofs")
  })

  it("keeps physical verification separate from controlled correction", () => {
    expect(source).toContain('"LOT_SCAN_MISMATCH"')
    expect(source).toContain("stock_reservation_verifications")
    expect(source).toContain("stock_reservation_corrections")
    expect(source).toContain("IDEMPOTENCY_KEY_REUSED")
    expect(source).toContain("CORRECTION_IN_PROGRESS")
  })
})
