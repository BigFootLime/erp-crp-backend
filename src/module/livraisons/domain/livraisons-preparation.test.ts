import { describe, expect, it } from "vitest"

import {
  deriveLivraisonPreparationState,
  matchesLivraisonPickScanCode,
} from "./livraisons-preparation"

describe("livraisons preparation", () => {
  it("accepts the lot, short trace and canonical QR codes", () => {
    const expected = {
      lot_code: "LOT-042",
      stock_trace_code: "123456",
      qr_payload: "CERP-STOCK:123456",
    }
    expect(matchesLivraisonPickScanCode(" lot-042 ", expected)).toBe(true)
    expect(matchesLivraisonPickScanCode("123456", expected)).toBe(true)
    expect(matchesLivraisonPickScanCode("CERP-STOCK:123456", expected)).toBe(true)
    expect(matchesLivraisonPickScanCode("LOT-999", expected)).toBe(false)
  })

  it("derives an explicit operator state", () => {
    expect(deriveLivraisonPreparationState({ status: "DRAFT", total: 2, confirmed: 0 })).toBe("NOT_READY")
    expect(deriveLivraisonPreparationState({ status: "READY", total: 2, confirmed: 0 })).toBe("TO_PREPARE")
    expect(deriveLivraisonPreparationState({ status: "READY", total: 2, confirmed: 1 })).toBe("IN_PROGRESS")
    expect(deriveLivraisonPreparationState({ status: "READY", total: 2, confirmed: 2 })).toBe("COMPLETE")
    expect(deriveLivraisonPreparationState({ status: "READY", total: 0, confirmed: 0 })).toBe("BLOCKED")
  })
})
