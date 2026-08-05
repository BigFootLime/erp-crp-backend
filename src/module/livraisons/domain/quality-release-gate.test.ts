import { describe, expect, it } from "vitest"

import { qualitySha256 } from "../../qualite/domain/quality-policy"
import {
  evaluateDeliveryQualityRelease,
  parseDeliveryQualityPolicyRules,
  type DeliveryQualityEvidence,
  type DeliveryQualityPolicy,
  type DeliveryQualityReleaseInput,
  type DeliveryQualityTargetObservation,
} from "./quality-release-gate"

const BL_ID = "10000000-0000-4000-8000-000000000001"
const LOT_ID = "10000000-0000-4000-8000-000000000002"
const CONTROL_ID = "10000000-0000-4000-8000-000000000003"
const RELEASE_ID = "10000000-0000-4000-8000-000000000004"
const DEROGATION_ID = "10000000-0000-4000-8000-000000000005"
const CONSUMPTION_ID = "10000000-0000-4000-8000-000000000006"

function rules(requiredDocuments: Array<Record<string, unknown>> = []) {
  return {
    schema: "cerp.quality.delivery-release-policy.v1",
    engine: "CERP_QUALITY_ELIGIBILITY_V1",
    aggregate_scope: "ALL_DELIVERY_ALLOCATIONS",
    derogation_mode: "APPROVED_LINKED_RELEASE_ONLY",
    required_documents: requiredDocuments,
  }
}

function policy(policyRules: unknown = rules()): DeliveryQualityPolicy {
  return {
    id: "10000000-0000-4000-8000-000000000010",
    code: "SHIP-QUALITY",
    version: 1,
    rules: policyRules,
    rules_sha256: qualitySha256(policyRules),
    signature_reference: "QMS-SIG-2026-01",
    signed_at: "2026-08-01T08:00:00.000Z",
  }
}

function target(overrides: Partial<DeliveryQualityTargetObservation["target"]> = {}): DeliveryQualityTargetObservation {
  return {
    key: `LOT:${LOT_ID}`,
    target: {
      object_type: "LOT",
      object_id: LOT_ID,
      label: "LOT-42",
      qty_requested: 5,
      lot_status: "LIBERE",
      qty_released: 5,
      qty_held: 0,
      qty_consumed: 0,
      open_nc_without_disposition: 0,
      pending_mandatory_controls: 0,
      derogation: null,
      ...overrides,
    },
    derogation: null,
  }
}

function evidence(): DeliveryQualityEvidence {
  return {
    id: "10000000-0000-4000-8000-000000000020",
    entity_type: "CONTROL",
    entity_id: CONTROL_ID,
    document_type: "CERTIFICATE",
    version: 1,
    revision: "A",
    original_name: "certificat-matiere.pdf",
    mime_type: "application/pdf",
    size_bytes: 2048,
    sha256: "c".repeat(64),
    target_keys: [`LOT:${LOT_ID}`],
  }
}

function input(overrides: Partial<DeliveryQualityReleaseInput> = {}): DeliveryQualityReleaseInput {
  return {
    bon_livraison_id: BL_ID,
    evaluated_at: "2026-08-05T09:00:00.000Z",
    policy_candidates: [policy()],
    targets: [target()],
    evidence: [],
    ...overrides,
  }
}

describe("delivery quality release gate", () => {
  it("fails closed when no signed policy exists and keeps a deterministic preview hash", () => {
    const first = evaluateDeliveryQualityRelease(input({ policy_candidates: [] }))
    const later = evaluateDeliveryQualityRelease(
      input({ policy_candidates: [], evaluated_at: "2026-08-05T12:00:00.000Z" })
    )

    expect(first.state).toBe("UNKNOWN")
    expect(first.reasons[0]?.code).toBe("QUALITY_POLICY_MISSING")
    expect(first.preview_sha256).toBe(later.preview_sha256)
  })

  it("rejects unknown fields and a tampered signed policy", () => {
    expect(parseDeliveryQualityPolicyRules({ ...rules(), implicit_release: true })).toBeNull()
    const tampered = policy()
    tampered.rules_sha256 = "0".repeat(64)

    const result = evaluateDeliveryQualityRelease(input({ policy_candidates: [tampered] }))
    expect(result.state).toBe("UNKNOWN")
    expect(result.reasons[0]?.code).toBe("QUALITY_POLICY_INTEGRITY_FAILED")
  })

  it("returns READY only when every exact target is eligible", () => {
    const result = evaluateDeliveryQualityRelease(input())

    expect(result.state).toBe("READY")
    expect(result.reasons).toEqual([])
    expect(result.targets).toEqual([
      expect.objectContaining({ object_type: "LOT", object_id: LOT_ID, qty_requested: 5, qty_allowed: 5 }),
    ])
  })

  it.each([
    ["pending control", { pending_mandatory_controls: 1 }, "MANDATORY_CONTROL_PENDING"],
    ["open NC", { open_nc_without_disposition: 1 }, "OPEN_NON_CONFORMITY"],
    ["held lot", { lot_status: "QUARANTAINE" as const }, "LOT_QUARANTINE"],
    ["insufficient released quantity", { qty_released: 4 }, "QTY_NOT_RELEASED"],
  ])("returns BLOCKED for %s", (_label, targetOverrides, expectedCode) => {
    const result = evaluateDeliveryQualityRelease(input({ targets: [target(targetOverrides)] }))
    expect(result.state).toBe("BLOCKED")
    expect(result.reasons.map((reason) => reason.code)).toContain(expectedCode)
  })

  it("requires all proofs explicitly named by the signed policy", () => {
    const policyRules = rules([{ document_type: "CERTIFICATE", scope: "PER_TARGET", min_count: 1 }])
    const missing = evaluateDeliveryQualityRelease(input({ policy_candidates: [policy(policyRules)] }))
    const complete = evaluateDeliveryQualityRelease(
      input({ policy_candidates: [policy(policyRules)], evidence: [evidence()] })
    )

    expect(missing.state).toBe("BLOCKED")
    expect(missing.reasons[0]?.code).toBe("QUALITY_EVIDENCE_MISSING")
    expect(complete.state).toBe("READY")
    expect(complete.required_evidence).toHaveLength(1)
    expect(complete.preview_sha256).not.toBe(missing.preview_sha256)
  })

  it("returns DEROGATED only for an approved, scoped, dated and linked audited use", () => {
    const observation = target({
      derogation: { status: "APPROVED", valid_to: "2026-08-31T23:59:59.000Z" },
    })
    observation.derogation = {
      release_decision_id: RELEASE_ID,
      release_decision_justification: "Acceptation client documentée",
      consumption_id: CONSUMPTION_ID,
      consumption_bon_livraison_id: BL_ID,
      consumption_qty: 5,
      state: {
        id: DEROGATION_ID,
        code: "DER-42",
        status: "APPROVED",
        article_id: null,
        piece_technique_id: null,
        piece_version_id: null,
        lot_id: LOT_ID,
        of_id: null,
        commande_id: null,
        bon_livraison_id: BL_ID,
        max_qty: 5,
        unit: "pce",
        consumed_qty: 5,
        valid_from: "2026-08-01T00:00:00.000Z",
        valid_to: "2026-08-31T23:59:59.000Z",
      },
      context: {
        article_id: null,
        piece_technique_id: null,
        piece_version_id: null,
        lot_id: LOT_ID,
        of_id: null,
        commande_id: null,
        bon_livraison_id: BL_ID,
        unit: "pce",
      },
      requested_by: 10,
      requested_at: "2026-08-01T08:00:00.000Z",
      approved_by: 11,
      approved_at: "2026-08-01T10:00:00.000Z",
      requirement: "Tolérance contractuelle",
      deviation: "Écart dimensionnel accepté",
    }

    const result = evaluateDeliveryQualityRelease(input({ targets: [observation] }))
    expect(result.state).toBe("DEROGATED")
    expect(result.derogation_ids).toEqual([DEROGATION_ID])
  })

  it("blocks an unlinked or incompletely audited derogation", () => {
    const observation = target({ derogation: { status: "APPROVED", valid_to: null } })
    observation.derogation = {
      release_decision_id: RELEASE_ID,
      release_decision_justification: null,
      consumption_id: null,
      consumption_bon_livraison_id: null,
      consumption_qty: null,
      state: {
        id: DEROGATION_ID,
        code: "DER-42",
        status: "APPROVED",
        article_id: null,
        piece_technique_id: null,
        piece_version_id: null,
        lot_id: LOT_ID,
        of_id: null,
        commande_id: null,
        bon_livraison_id: null,
        max_qty: null,
        unit: null,
        consumed_qty: 0,
        valid_from: null,
        valid_to: null,
      },
      context: {
        article_id: null,
        piece_technique_id: null,
        piece_version_id: null,
        lot_id: LOT_ID,
        of_id: null,
        commande_id: null,
        bon_livraison_id: BL_ID,
        unit: null,
      },
      requested_by: 10,
      requested_at: "2026-08-01T08:00:00.000Z",
      approved_by: 11,
      approved_at: "2026-08-01T10:00:00.000Z",
      requirement: "Tolérance",
      deviation: "Écart",
    }

    const result = evaluateDeliveryQualityRelease(input({ targets: [observation] }))
    expect(result.state).toBe("BLOCKED")
    expect(result.reasons.map((reason) => reason.code)).toContain("DEROGATION_AUDIT_INCOMPLETE")
  })

  it("changes the preview hash when a quality quantity changes", () => {
    const ready = evaluateDeliveryQualityRelease(input())
    const changed = evaluateDeliveryQualityRelease(input({ targets: [target({ qty_released: 4 })] }))
    expect(ready.preview_sha256).not.toBe(changed.preview_sha256)
  })
})
