import { describe, expect, it } from "vitest"
import { deliveryContractBoundary, type DeliveryContractOrder } from "./delivery-contract-boundary"

const order = (id: string, contract: string | null = null): DeliveryContractOrder => ({
  commande_id: id, client_id: "CLI-001", contract_id: contract, order_type: "FERME",
})
const inspect = (orders: DeliveryContractOrder[], hasUnboundLines = false) =>
  deliveryContractBoundary({ clientId: "CLI-001", orders, hasUnboundLines })

describe("multi-order delivery contract boundary (#1030)", () => {
  it("combines ordinary orders and calls of the same recorded contract", () => {
    expect(inspect([order("100"), order("200")]).blocker).toBeNull()
    expect(inspect([order("100", "CONTRACT-A"), order("200", "contract-a")]).blocker).toBeNull()
  })
  it("refuses different contracts and contract/non-contract mixtures", () => {
    expect(inspect([order("100", "contract-a"), order("200", "contract-b")]).blocker?.code)
      .toBe("MIXED_DELIVERY_CONTRACT")
    expect(inspect([order("100", "contract-a"), order("200")]).blocker?.code)
      .toBe("MIXED_DELIVERY_CONTRACT")
  })
  it("does not infer a common contract for separate historical CADRE orders", () => {
    const historical = { ...order("100"), order_type: "CADRE" }
    expect(inspect([historical, { ...historical }]).blocker).toBeNull()
    expect(inspect([historical, { ...historical, commande_id: "200" }]).blocker?.code)
      .toBe("MIXED_DELIVERY_CONTRACT")
    expect(inspect([historical, order("200")]).blocker?.code).toBe("MIXED_DELIVERY_CONTRACT")
  })
  it("cannot hide a manual unbound line inside a contract delivery", () => {
    expect(inspect([order("100", "contract-a")], true).blocker?.code)
      .toBe("DELIVERY_CONTRACT_LINE_SOURCE_REQUIRED")
    expect(inspect([order("100")], true).blocker).toBeNull()
  })
  it("retains client isolation even when the contract key matches", () => {
    expect(inspect([order("100", "contract-a"), { ...order("200", "contract-a"), client_id: "CLI-002" }]).blocker?.code)
      .toBe("MIXED_DELIVERY_CLIENT")
  })
  it("preserves unowned internal stock delivery while isolating customer fulfillment", () => {
    const internal = { ...order("100"), client_id: null, order_type: "INTERNE" }
    expect(inspect([internal]).blocker).toBeNull()
    expect(inspect([internal, order("200")]).blocker?.code).toBe("MIXED_DELIVERY_PURPOSE")
  })
})
