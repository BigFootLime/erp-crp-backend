import { qualitySha256 } from "../../qualite/domain/quality-policy"
import {
  evaluateDerogationUsage,
  evaluateQualityEligibility,
  type DerogationState,
  type DerogationUsageContext,
  type EligibilityTarget,
} from "../../qualite/domain/quality-release"

export const DELIVERY_QUALITY_RELEASE_STATES = ["READY", "BLOCKED", "DEROGATED", "UNKNOWN"] as const
export type DeliveryQualityReleaseState = (typeof DELIVERY_QUALITY_RELEASE_STATES)[number]

export type DeliveryQualityReleaseReason = {
  code: string
  severity: "BLOCKING" | "INFO"
  message: string
  expected_action: string | null
  object_type: string | null
  object_id: string | null
}

export type DeliveryQualityEvidence = {
  id: string
  entity_type: "CONTROL" | "NON_CONFORMITY" | "ACTION" | "PLAN" | "DEROGATION" | "RELEASE"
  entity_id: string
  document_type: string
  version: number
  revision: string | null
  original_name: string
  mime_type: string
  size_bytes: number
  sha256: string
  target_keys: string[]
}

export type DeliveryQualityPolicy = {
  id: string
  code: string
  version: number
  rules_sha256: string
  signature_reference: string
  signed_at: string
  rules: unknown
}

export type DeliveryQualityPolicyRules = {
  schema: "cerp.quality.delivery-release-policy.v1" | "cerp.quality.delivery-release-policy.v2"
  engine: "CERP_QUALITY_ELIGIBILITY_V1"
  aggregate_scope: "ALL_DELIVERY_ALLOCATIONS"
  derogation_mode: "FORBIDDEN" | "APPROVED_LINKED_RELEASE_ONLY"
  required_control_triggers: Array<"LOT_RELEASE">
  require_independent_decider: boolean
  required_documents: Array<{
    document_type: string
    scope: "PER_DELIVERY" | "PER_TARGET"
    min_count: number
  }>
}

export type DeliveryQualityDerogation = {
  release_decision_id: string
  release_decision_justification: string | null
  consumption_id: string | null
  consumption_bon_livraison_id: string | null
  consumption_qty: number | null
  state: DerogationState
  context: DerogationUsageContext
  requested_by: number
  requested_at: string
  approved_by: number | null
  approved_at: string | null
  requirement: string
  deviation: string
}

export type DeliveryQualityTargetObservation = {
  key: string
  target: EligibilityTarget
  allocation_id: string
  delivery_line_id: string
  article_id: string | null
  article_code: string | null
  article_designation: string | null
  lot_id: string | null
  lot_code: string | null
  unite: string | null
  plan: { id: string; code: string; version: number } | null
  control_count: number
  latest_decision: {
    id: string
    decision: "FULL" | "PARTIAL" | "HOLD" | "REJECT"
    qty: number
    decided_at: string
  } | null
  derogation: DeliveryQualityDerogation | null
}

export type DeliveryQualityReleaseInput = {
  bon_livraison_id: string
  evaluated_at: string
  policy_candidates: DeliveryQualityPolicy[]
  targets: DeliveryQualityTargetObservation[]
  evidence: DeliveryQualityEvidence[]
  unavailable_reason?: string | null
}

export type DeliveryQualityRelease = {
  state: DeliveryQualityReleaseState
  preview_sha256: string
  policy: {
    id: string
    code: string
    version: number
    rules_sha256: string
    signature_reference: string
    signed_at: string
  } | null
  reasons: DeliveryQualityReleaseReason[]
  targets: Array<{
    key: string
    allocation_id: string
    delivery_line_id: string
    article_id: string | null
    article_code: string | null
    article_designation: string | null
    lot_id: string | null
    lot_code: string | null
    unite: string | null
    object_type: string
    object_id: string
    label: string | null
    qty_requested: number
    qty_allowed: number
    plan: { id: string; code: string; version: number } | null
    control_count: number
    latest_decision: DeliveryQualityTargetObservation["latest_decision"]
    derogation_id: string | null
    release_decision_id: string | null
  }>
  required_evidence: DeliveryQualityEvidence[]
  derogation_ids: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function parseDeliveryQualityPolicyRules(value: unknown): DeliveryQualityPolicyRules | null {
  if (!isRecord(value)) return null
  const isV1 = value.schema === "cerp.quality.delivery-release-policy.v1"
  const isV2 = value.schema === "cerp.quality.delivery-release-policy.v2"
  if (!isV1 && !isV2) return null
  const expectedKeys = isV1
    ? ["schema", "engine", "aggregate_scope", "derogation_mode", "required_documents"]
    : [
        "schema",
        "engine",
        "aggregate_scope",
        "derogation_mode",
        "required_control_triggers",
        "require_independent_decider",
        "required_documents",
      ]
  if (!hasExactKeys(value, expectedKeys)) return null
  if (value.engine !== "CERP_QUALITY_ELIGIBILITY_V1") return null
  if (value.aggregate_scope !== "ALL_DELIVERY_ALLOCATIONS") return null
  if (value.derogation_mode !== "FORBIDDEN" && value.derogation_mode !== "APPROVED_LINKED_RELEASE_ONLY") return null
  if (!Array.isArray(value.required_documents)) return null
  if (isV2) {
    if (!Array.isArray(value.required_control_triggers)) return null
    if (
      value.required_control_triggers.length !== 1 ||
      value.required_control_triggers[0] !== "LOT_RELEASE" ||
      typeof value.require_independent_decider !== "boolean"
    ) return null
  }

  const requiredDocuments: DeliveryQualityPolicyRules["required_documents"] = []
  for (const raw of value.required_documents) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["document_type", "scope", "min_count"])) return null
    if (typeof raw.document_type !== "string" || !raw.document_type.trim()) return null
    if (raw.scope !== "PER_DELIVERY" && raw.scope !== "PER_TARGET") return null
    if (typeof raw.min_count !== "number" || !Number.isInteger(raw.min_count) || raw.min_count < 1 || raw.min_count > 100) return null
    requiredDocuments.push({
      document_type: raw.document_type.trim(),
      scope: raw.scope,
      min_count: raw.min_count,
    })
  }

  return {
    schema: isV2
      ? "cerp.quality.delivery-release-policy.v2"
      : "cerp.quality.delivery-release-policy.v1",
    engine: value.engine,
    aggregate_scope: value.aggregate_scope,
    derogation_mode: value.derogation_mode,
    required_control_triggers: isV2 ? ["LOT_RELEASE"] : [],
    require_independent_decider: isV2 ? Boolean(value.require_independent_decider) : true,
    required_documents: requiredDocuments,
  }
}

function targetSnapshot(
  observation: DeliveryQualityTargetObservation,
  qtyAllowed = 0,
  derogationId: string | null = null,
  releaseDecisionId: string | null = null
): DeliveryQualityRelease["targets"][number] {
  return {
    key: observation.key,
    allocation_id: observation.allocation_id,
    delivery_line_id: observation.delivery_line_id,
    article_id: observation.article_id,
    article_code: observation.article_code,
    article_designation: observation.article_designation,
    lot_id: observation.lot_id,
    lot_code: observation.lot_code,
    unite: observation.unite,
    object_type: observation.target.object_type,
    object_id: observation.target.object_id,
    label: observation.target.label,
    qty_requested: observation.target.qty_requested,
    qty_allowed: qtyAllowed,
    plan: observation.plan,
    control_count: observation.control_count,
    latest_decision: observation.latest_decision,
    derogation_id: derogationId,
    release_decision_id: releaseDecisionId,
  }
}

function visibleTargets(input: DeliveryQualityReleaseInput): DeliveryQualityRelease["targets"] {
  return [...input.targets]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((observation) => targetSnapshot(observation))
}

function blockingReason(params: Omit<DeliveryQualityReleaseReason, "severity">): DeliveryQualityReleaseReason {
  return { ...params, severity: "BLOCKING" }
}

function policySnapshot(policy: DeliveryQualityPolicy | null): DeliveryQualityRelease["policy"] {
  if (!policy) return null
  return {
    id: policy.id,
    code: policy.code,
    version: policy.version,
    rules_sha256: policy.rules_sha256,
    signature_reference: policy.signature_reference,
    signed_at: policy.signed_at,
  }
}

function buildResult(
  input: DeliveryQualityReleaseInput,
  state: DeliveryQualityReleaseState,
  policy: DeliveryQualityPolicy | null,
  reasons: DeliveryQualityReleaseReason[],
  targets: DeliveryQualityRelease["targets"],
  evidence: DeliveryQualityEvidence[],
  derogationIds: string[]
): DeliveryQualityRelease {
  const canonical = {
    schema: "cerp.quality.delivery-release-preview.v1",
    bon_livraison_id: input.bon_livraison_id,
    state,
    policy: policySnapshot(policy),
    reasons,
    targets,
    required_evidence: evidence,
    derogation_ids: derogationIds,
  }
  return {
    state,
    preview_sha256: qualitySha256(canonical),
    policy: canonical.policy,
    reasons,
    targets,
    required_evidence: evidence,
    derogation_ids: derogationIds,
  }
}

/**
 * Aggregate delivery release gate. It deliberately has no policy defaults:
 * missing, ambiguous, unsigned-at-source, tampered or unrecognised policy data
 * produces UNKNOWN and therefore cannot authorise a pack or shipment.
 */
export function evaluateDeliveryQualityRelease(input: DeliveryQualityReleaseInput): DeliveryQualityRelease {
  if (input.unavailable_reason) {
    return buildResult(
      input,
      "UNKNOWN",
      null,
      [
        blockingReason({
          code: "QUALITY_SCHEMA_UNAVAILABLE",
          message: input.unavailable_reason,
          expected_action: "Restaurer le schéma Qualité puis recalculer la décision.",
          object_type: "BON_LIVRAISON",
          object_id: input.bon_livraison_id,
        }),
      ],
      visibleTargets(input),
      [],
      []
    )
  }

  if (input.policy_candidates.length !== 1) {
    const code = input.policy_candidates.length === 0 ? "QUALITY_POLICY_MISSING" : "QUALITY_POLICY_AMBIGUOUS"
    return buildResult(
      input,
      "UNKNOWN",
      null,
      [
        blockingReason({
          code,
          message:
            input.policy_candidates.length === 0
              ? "Aucune politique Qualité signée et active ne couvre l'expédition."
              : "Plusieurs politiques Qualité signées couvrent simultanément l'expédition.",
          expected_action: "Faire valider une unique politique Qualité applicable; aucune règle n'est déduite automatiquement.",
          object_type: "BON_LIVRAISON",
          object_id: input.bon_livraison_id,
        }),
      ],
      visibleTargets(input),
      [],
      []
    )
  }

  const policy = input.policy_candidates[0]
  const rules = parseDeliveryQualityPolicyRules(policy.rules)
  const rulesHashMatches = qualitySha256(policy.rules) === policy.rules_sha256.toLowerCase()
  if (!rules || !rulesHashMatches || !policy.signature_reference.trim() || !policy.signed_at) {
    return buildResult(
      input,
      "UNKNOWN",
      policy,
      [
        blockingReason({
          code: rulesHashMatches ? "QUALITY_POLICY_INVALID" : "QUALITY_POLICY_INTEGRITY_FAILED",
          message: "La politique Qualité signée est invalide, non reconnue ou son empreinte ne correspond pas.",
          expected_action: "Faire corriger et signer une nouvelle version de politique; la version signée reste immuable.",
          object_type: "QUALITY_POLICY",
          object_id: policy.id,
        }),
      ],
      visibleTargets(input),
      [],
      []
    )
  }

  if (input.targets.length === 0) {
    return buildResult(
      input,
      "UNKNOWN",
      policy,
      [
        blockingReason({
          code: "QUALITY_SCOPE_EMPTY",
          message: "Aucune allocation de livraison ne permet de déterminer le périmètre Qualité.",
          expected_action: "Compléter les lignes et allocations avant de recalculer la décision.",
          object_type: "BON_LIVRAISON",
          object_id: input.bon_livraison_id,
        }),
      ],
      visibleTargets(input),
      [],
      []
    )
  }

  const at = new Date(input.evaluated_at)
  if (Number.isNaN(at.getTime())) {
    return buildResult(
      input,
      "UNKNOWN",
      policy,
      [
        blockingReason({
          code: "QUALITY_EVALUATION_DATE_INVALID",
          message: "La date d'évaluation Qualité est invalide.",
          expected_action: "Recalculer la décision avec l'horloge serveur.",
          object_type: "BON_LIVRAISON",
          object_id: input.bon_livraison_id,
        }),
      ],
      visibleTargets(input),
      [],
      []
    )
  }

  const reasons: DeliveryQualityReleaseReason[] = []
  const targets: DeliveryQualityRelease["targets"] = []
  const derogationIds = new Set<string>()

  for (const observation of [...input.targets].sort((a, b) => a.key.localeCompare(b.key))) {
    if (rules.required_control_triggers.includes("LOT_RELEASE")) {
      if (!observation.plan) {
        reasons.push(
          blockingReason({
            code: "QUALITY_PLAN_REQUIRED",
            message: `Aucun plan LOT_RELEASE publie ne couvre ${observation.target.label ?? observation.target.object_id}.`,
            expected_action: "Publier un plan LOT_RELEASE applicable a l'article puis demarrer le controle.",
            object_type: observation.target.object_type,
            object_id: observation.target.object_id,
          })
        )
      } else if (observation.control_count === 0) {
        reasons.push(
          blockingReason({
            code: "QUALITY_CONTROL_REQUIRED",
            message: `Le controle LOT_RELEASE de ${observation.target.label ?? observation.target.object_id} n'a pas ete demarre.`,
            expected_action: "Demarrer et renseigner le controle sur cette allocation exacte.",
            object_type: observation.target.object_type,
            object_id: observation.target.object_id,
          })
        )
      } else if (!observation.latest_decision) {
        reasons.push(
          blockingReason({
            code: "QUALITY_DECISION_REQUIRED",
            message: `Aucune decision de liberation n'est prononcee pour ${observation.target.label ?? observation.target.object_id}.`,
            expected_action: "Faire decider le controle par un utilisateur distinct de l'operateur.",
            object_type: observation.target.object_type,
            object_id: observation.target.object_id,
          })
        )
      }
    }
    const verdict = evaluateQualityEligibility(observation.target, "SHIP", at)
    for (const block of verdict.blocks) {
      reasons.push(
        blockingReason({
          code: block.code,
          message: block.message,
          expected_action: block.expected_action,
          object_type: block.object_type,
          object_id: block.object_id,
        })
      )
    }

    let acceptedDerogation: DeliveryQualityDerogation | null = null
    if (observation.derogation) {
      const d = observation.derogation
      const auditComplete =
        d.requested_by > 0 &&
        Boolean(d.requested_at) &&
        d.approved_by !== null &&
        Boolean(d.approved_at) &&
        d.approved_by !== d.requested_by &&
        d.requirement.trim().length >= 3 &&
        d.deviation.trim().length >= 3 &&
        Boolean(d.release_decision_justification?.trim()) &&
        d.consumption_id !== null &&
        d.consumption_bon_livraison_id === input.bon_livraison_id &&
        d.consumption_qty !== null &&
        d.consumption_qty > 0
      const usage = evaluateDerogationUsage({
        derogation: {
          ...d.state,
          // The receipt is already included in the persisted consumed total;
          // reconstruct the pre-consumption balance to validate this exact use.
          consumed_qty: Math.max(0, d.state.consumed_qty - (d.consumption_qty ?? 0)),
        },
        context: d.context,
        qty: d.consumption_qty ?? observation.target.qty_requested,
        at,
      })

      if (rules.derogation_mode === "FORBIDDEN") {
        reasons.push(
          blockingReason({
            code: "DEROGATION_FORBIDDEN_BY_POLICY",
            message: "Une dérogation est liée alors que la politique signée interdit son usage pour l'expédition.",
            expected_action: "Traiter la non-conformité sans dérogation ou faire valider une nouvelle politique.",
            object_type: observation.target.object_type,
            object_id: observation.target.object_id,
          })
        )
      } else if (!auditComplete) {
        reasons.push(
          blockingReason({
            code: "DEROGATION_AUDIT_INCOMPLETE",
            message: "La dérogation ne possède pas l'auteur, le motif, le périmètre, les dates et la consommation liée requis.",
            expected_action: "Compléter et approuver la dérogation, puis lier sa consommation à la décision de libération et au BL.",
            object_type: observation.target.object_type,
            object_id: observation.target.object_id,
          })
        )
      } else if (!usage.allowed) {
        reasons.push(
          blockingReason({
            code: usage.code,
            message: usage.message,
            expected_action: "Corriger la portée ou la validité de la dérogation avant expédition.",
            object_type: observation.target.object_type,
            object_id: observation.target.object_id,
          })
        )
      } else {
        acceptedDerogation = d
        derogationIds.add(d.state.id)
      }
    }

    targets.push(
      targetSnapshot(
        observation,
        verdict.qty_allowed,
        acceptedDerogation?.state.id ?? null,
        observation.latest_decision?.id ?? acceptedDerogation?.release_decision_id ?? null
      )
    )
  }

  const requiredEvidence = new Map<string, DeliveryQualityEvidence>()
  const customerEvidence = input.evidence
    .filter((doc) => /^[a-f0-9]{64}$/i.test(doc.sha256))
    .sort((a, b) => a.id.localeCompare(b.id))

  for (const requirement of rules.required_documents) {
    if (requirement.scope === "PER_DELIVERY") {
      const matches = customerEvidence.filter((doc) => doc.document_type === requirement.document_type)
      if (matches.length < requirement.min_count) {
        reasons.push(
          blockingReason({
            code: "QUALITY_EVIDENCE_MISSING",
            message: `Preuve ${requirement.document_type} manquante pour la livraison (${matches.length}/${requirement.min_count}).`,
            expected_action: "Joindre une preuve décisionnelle visible client avec empreinte SHA-256.",
            object_type: "BON_LIVRAISON",
            object_id: input.bon_livraison_id,
          })
        )
      }
      for (const doc of matches) requiredEvidence.set(doc.id, doc)
      continue
    }

    for (const target of targets) {
      const matches = customerEvidence.filter(
        (doc) => doc.document_type === requirement.document_type && doc.target_keys.includes(target.key)
      )
      if (matches.length < requirement.min_count) {
        reasons.push(
          blockingReason({
            code: "QUALITY_EVIDENCE_MISSING",
            message: `Preuve ${requirement.document_type} manquante pour ${target.label ?? target.object_id} (${matches.length}/${requirement.min_count}).`,
            expected_action: "Joindre une preuve décisionnelle visible client avec empreinte SHA-256.",
            object_type: target.object_type,
            object_id: target.object_id,
          })
        )
      }
      for (const doc of matches) requiredEvidence.set(doc.id, doc)
    }
  }

  const evidence = [...requiredEvidence.values()].sort((a, b) => a.id.localeCompare(b.id))
  const derogations = [...derogationIds].sort()
  const state: DeliveryQualityReleaseState = reasons.length > 0 ? "BLOCKED" : derogations.length > 0 ? "DEROGATED" : "READY"
  return buildResult(input, state, policy, reasons, targets, evidence, derogations)
}
