import { describe, expect, it } from "vitest"

import {
  isHistoricalOldDeliveryQualityTarget,
  isStrictHistoricalOldDeliveryGroup,
  type DeliveryQualityRelease,
} from "../module/livraisons/domain/quality-release-gate"

type Target = DeliveryQualityRelease["targets"][number]

function target(allocationId: string, options: {
  scope?: "OLD" | "NEW"
  documents?: number
  controlCount?: number
  currentControl?: boolean
} = {}): Target {
  const scope = options.scope ?? "OLD"
  return {
    key: `ALLOCATION:${allocationId}`,
    allocation_id: allocationId,
    delivery_line_id: `line-${allocationId}`,
    article_id: "article",
    article_code: "ART",
    article_designation: "Article",
    lot_id: "lot",
    lot_code: "LOT",
    unite: "U",
    object_type: "LOT",
    object_id: "lot",
    label: "LOT",
    qty_requested: 1,
    qty_allowed: 1,
    plan: null,
    control_count: options.controlCount ?? 0,
    latest_decision: null,
    derogation_id: null,
    release_decision_id: null,
    historical_provenance: scope === "OLD"
      ? {
          scope: "OLD",
          documents: Array.from({ length: options.documents ?? 1 }, (_, index) => ({
            id: `document-${index}`, type: "CONTROLE", label: "Historical control", location: "vault", created_by: 1,
          })),
          has_current_lot_control: options.currentControl ?? false,
        }
      : null,
  }
}

describe("#1367 historical OLD shipment eligibility", () => {
  it("accepts the operational exemption only when every exact allocation is documented OLD without a current control", () => {
    const release = { targets: [target("allocation-a"), target("allocation-b")] }

    expect(isStrictHistoricalOldDeliveryGroup(["allocation-a", "allocation-b"], release)).toBe(true)
    expect(isStrictHistoricalOldDeliveryGroup(["allocation-a", "allocation-missing"], release)).toBe(false)
    expect(isStrictHistoricalOldDeliveryGroup([], release)).toBe(false)
  })

  it.each([
    ["missing historical document", target("allocation-a", { documents: 0 })],
    ["a current CERP control", target("allocation-a", { currentControl: true })],
    ["a historical control count", target("allocation-a", { controlCount: 1 })],
    ["new provenance", target("allocation-a", { scope: "NEW" })],
  ])("does not exempt %s", (_label, candidate) => {
    expect(isStrictHistoricalOldDeliveryGroup(["allocation-a"], { targets: [candidate] })).toBe(false)
  })

  it("keeps aggregate historical classification separate from its required document evidence", () => {
    const undocumented = target("allocation-a", { documents: 0 })

    expect(isHistoricalOldDeliveryQualityTarget(undocumented)).toBe(true)
    expect(isStrictHistoricalOldDeliveryGroup(["allocation-a"], { targets: [undocumented] })).toBe(false)
  })
})
