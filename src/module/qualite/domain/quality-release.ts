// Libération, quantités, quarantaine, instruments, dérogations et moteur
// d'éligibilité ciblé (#228). Pur : aucune I/O.

import { HttpError } from "../../../utils/httpError";
import type { QualityCharacteristicSpec } from "./quality-plan";
import type { QualityVerdict } from "./quality-policy";

const EPS = 1e-9;

/* -------------------------------------------------------------------------- */
/* 1) Objet contrôlé — typage obligatoire de la source                        */
/* -------------------------------------------------------------------------- */

export const QUALITY_SOURCE_TYPES = [
  "RECEPTION_LINE",
  "OF",
  "OF_OPERATION",
  "LOT",
  "STOCK_LEVEL",
  "ARTICLE",
  "PIECE_TECHNIQUE",
  "FOURNISSEUR",
  "DELIVERY_LINE",
] as const;
export type QualitySourceType = (typeof QUALITY_SOURCE_TYPES)[number];

export type QualitySourceRef = {
  source_type: QualitySourceType;
  source_id: string;
};

export function assertSourceRef(ref: Partial<QualitySourceRef> | null | undefined): QualitySourceRef {
  const type = ref?.source_type;
  const id = (ref?.source_id ?? "").trim();
  if (!type || !QUALITY_SOURCE_TYPES.includes(type)) {
    throw new HttpError(422, "QUALITY_SOURCE_TYPE_REQUIRED", "Type de source obligatoire et typé.");
  }
  if (!id) {
    throw new HttpError(422, "QUALITY_SOURCE_ID_REQUIRED", "Identifiant de source obligatoire.");
  }
  return { source_type: type, source_id: id };
}

/* -------------------------------------------------------------------------- */
/* 2) Registre de quantités                                                   */
/* -------------------------------------------------------------------------- */

export type QuantityLedger = {
  population: number;
  controlled: number;
  conforming: number;
  released: number;
  held: number;
  scrapped: number;
  reworked: number;
  sorted: number;
  returned: number;
  consumed: number;
};

export const EMPTY_LEDGER: QuantityLedger = {
  population: 0,
  controlled: 0,
  conforming: 0,
  released: 0,
  held: 0,
  scrapped: 0,
  reworked: 0,
  sorted: 0,
  returned: 0,
  consumed: 0,
};

const LEDGER_DISPOSED_FIELDS = [
  "released",
  "held",
  "scrapped",
  "reworked",
  "sorted",
  "returned",
] as const;

export function assertQuantityLedger(ledger: QuantityLedger): void {
  const problems: Array<{ field: string; code: string }> = [];

  for (const [field, value] of Object.entries(ledger)) {
    if (!Number.isFinite(value)) {
      problems.push({ field, code: "NOT_FINITE" });
      continue;
    }
    if (value < -EPS) problems.push({ field, code: "NEGATIVE" });
  }
  if (problems.length > 0) {
    throw new HttpError(422, "QUALITY_QUANTITY_INVALID", "Quantité qualité invalide.", { problems });
  }

  if (ledger.population <= EPS) {
    throw new HttpError(
      422,
      "QUALITY_POPULATION_REQUIRED",
      "La population contrôlée doit être strictement positive."
    );
  }
  if (ledger.controlled > ledger.population + EPS) {
    throw new HttpError(
      422,
      "QUALITY_CONTROLLED_EXCEEDS_POPULATION",
      "La quantité contrôlée dépasse la population."
    );
  }
  if (ledger.conforming > ledger.controlled + EPS) {
    throw new HttpError(
      422,
      "QUALITY_CONFORMING_EXCEEDS_CONTROLLED",
      "La quantité conforme dépasse la quantité contrôlée."
    );
  }
  if (ledger.released > ledger.conforming + EPS) {
    throw new HttpError(
      422,
      "QUALITY_RELEASED_EXCEEDS_CONFORMING",
      "La quantité libérée dépasse la quantité conforme."
    );
  }
  const disposed = LEDGER_DISPOSED_FIELDS.reduce((sum, field) => sum + ledger[field], 0);
  if (disposed > ledger.population + EPS) {
    throw new HttpError(
      422,
      "QUALITY_DISPOSITIONS_EXCEED_POPULATION",
      "Le cumul des dispositions dépasse la population.",
      { disposed, population: ledger.population }
    );
  }
  if (ledger.consumed > ledger.released + EPS) {
    throw new HttpError(
      422,
      "QUALITY_CONSUMED_EXCEEDS_RELEASED",
      "La quantité déjà consommée dépasse la quantité libérée."
    );
  }
}

export function remainingUndisposedQty(ledger: QuantityLedger): number {
  const disposed = LEDGER_DISPOSED_FIELDS.reduce((sum, field) => sum + ledger[field], 0);
  return Math.max(0, ledger.population - disposed);
}

export function releasableQty(ledger: QuantityLedger): number {
  return Math.max(0, Math.min(ledger.conforming - ledger.released, remainingUndisposedQty(ledger)));
}

/* -------------------------------------------------------------------------- */
/* 3) Décision de libération                                                  */
/* -------------------------------------------------------------------------- */

export const QUALITY_RELEASE_DECISIONS = ["FULL", "PARTIAL", "HOLD", "REJECT"] as const;
export type QualityReleaseDecision = (typeof QUALITY_RELEASE_DECISIONS)[number];

export type ReleaseRequest = {
  decision: QualityReleaseDecision;
  qty: number;
  unit: string | null;
  ledger: QuantityLedger;
  verdict: QualityVerdict;
  hasDerogation: boolean;
  evidenceCount: number;
};

export type ReleaseOutcome = {
  decision: QualityReleaseDecision;
  qty_released: number;
  qty_held: number;
  ledger: QuantityLedger;
};

/**
 * Aucune libération automatique : cette fonction n'est appelée que par une
 * commande explicite, avec rôle autorisé, verrou optimiste et preuve
 * suffisante vérifiés en amont.
 */
export function evaluateReleaseRequest(request: ReleaseRequest): ReleaseOutcome {
  assertQuantityLedger(request.ledger);

  if (!Number.isFinite(request.qty)) {
    throw new HttpError(422, "QUALITY_RELEASE_QTY_INVALID", "Quantité de libération invalide.");
  }
  if (request.decision !== "HOLD" && request.qty <= EPS) {
    throw new HttpError(
      422,
      "QUALITY_RELEASE_QTY_REQUIRED",
      "Une libération exige une quantité strictement positive."
    );
  }
  if (!request.unit || !request.unit.trim()) {
    throw new HttpError(422, "QUALITY_RELEASE_UNIT_REQUIRED", "L'unité de la décision est obligatoire.");
  }

  if (request.verdict === "EN_ATTENTE") {
    throw new HttpError(
      422,
      "QUALITY_VERDICT_INCOMPLETE",
      "Le verdict n'est pas calculé : contrôle incomplet, aucune décision possible."
    );
  }

  if (request.decision === "HOLD") {
    const held = Math.min(remainingUndisposedQty(request.ledger), request.qty > EPS ? request.qty : remainingUndisposedQty(request.ledger));
    if (held <= EPS) {
      throw new HttpError(
        422,
        "QUALITY_NOTHING_TO_HOLD",
        "Aucune quantité disponible à mettre en quarantaine."
      );
    }
    return {
      decision: "HOLD",
      qty_released: 0,
      qty_held: held,
      ledger: { ...request.ledger, held: request.ledger.held + held },
    };
  }

  if (request.decision === "REJECT") {
    return { decision: "REJECT", qty_released: 0, qty_held: 0, ledger: request.ledger };
  }

  if (request.verdict === "NON_CONFORME" && !request.hasDerogation) {
    throw new HttpError(
      422,
      "QUALITY_RELEASE_REQUIRES_DEROGATION",
      "Libérer un résultat non conforme exige une dérogation approuvée et active."
    );
  }
  if (request.verdict === "PARTIEL" && request.decision === "FULL") {
    throw new HttpError(
      422,
      "QUALITY_RELEASE_PARTIAL_ONLY",
      "Un verdict partiel n'autorise qu'une libération partielle : le reste demeure bloqué."
    );
  }

  const maximum = releasableQty(request.ledger);
  if (request.qty > maximum + EPS) {
    throw new HttpError(
      422,
      "QUALITY_RELEASE_QTY_EXCEEDS_ALLOWED",
      "La quantité demandée dépasse la quantité libérable.",
      { requested: request.qty, releasable: maximum }
    );
  }
  if (request.decision === "FULL" && request.qty + EPS < maximum) {
    throw new HttpError(
      422,
      "QUALITY_RELEASE_FULL_MISMATCH",
      "Une libération totale doit porter sur la totalité de la quantité libérable.",
      { requested: request.qty, releasable: maximum }
    );
  }
  if (request.evidenceCount < 0) {
    throw new HttpError(422, "QUALITY_EVIDENCE_INVALID", "Nombre de preuves invalide.");
  }

  const nextLedger: QuantityLedger = {
    ...request.ledger,
    released: request.ledger.released + request.qty,
  };
  const held = Math.max(0, remainingUndisposedQty(nextLedger));

  return {
    decision: request.decision,
    qty_released: request.qty,
    qty_held: request.decision === "PARTIAL" ? held : 0,
    ledger: nextLedger,
  };
}

/* -------------------------------------------------------------------------- */
/* 4) Instruments de métrologie                                               */
/* -------------------------------------------------------------------------- */

export type InstrumentState = {
  id: string;
  code: string | null;
  designation: string | null;
  statut: string | null;
  criticite: string | null;
  categorie: string | null;
  next_due_date: string | null;
  deleted: boolean;
};

export type MetrologyPolicy = {
  // Réglage historique `metrologie.block_on_overdue_critical` : conservé, mais
  // appliqué à l'instrument réellement utilisé, jamais en blocage global.
  block_on_overdue_critical: boolean;
};

export type InstrumentUsageEvaluation = {
  allowed: boolean;
  severity: "OK" | "WARNING" | "BLOCKING";
  code:
    | "OK"
    | "INSTRUMENT_REQUIRED"
    | "INSTRUMENT_UNKNOWN"
    | "INSTRUMENT_DELETED"
    | "INSTRUMENT_INACTIVE"
    | "INSTRUMENT_OUT_OF_SCOPE"
    | "INSTRUMENT_OVERDUE_CRITICAL"
    | "INSTRUMENT_OVERDUE";
  message: string;
};

export function evaluateInstrumentUsage(params: {
  characteristic: Pick<QualityCharacteristicSpec, "key" | "requires_instrument" | "instrument_category">;
  instrument: InstrumentState | null;
  at: Date;
  policy: MetrologyPolicy;
}): InstrumentUsageEvaluation {
  const { characteristic, instrument, at, policy } = params;

  if (!characteristic.requires_instrument) {
    return { allowed: true, severity: "OK", code: "OK", message: "Aucun moyen de contrôle requis." };
  }
  if (!instrument) {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_REQUIRED",
      message: `La caractéristique ${characteristic.key} exige l'instrument réellement utilisé.`,
    };
  }
  if (instrument.deleted) {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_DELETED",
      message: "Instrument supprimé du parc de métrologie.",
    };
  }
  if ((instrument.statut ?? "").toUpperCase() !== "ACTIF") {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_INACTIVE",
      message: `Instrument non actif (${instrument.statut ?? "statut inconnu"}).`,
    };
  }
  if (
    characteristic.instrument_category &&
    (instrument.categorie ?? "").trim().toLowerCase() !==
      characteristic.instrument_category.trim().toLowerCase()
  ) {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_OUT_OF_SCOPE",
      message: `Instrument hors périmètre : catégorie ${characteristic.instrument_category} attendue.`,
    };
  }

  const overdue = isInstrumentOverdue(instrument, at);
  if (!overdue) {
    return { allowed: true, severity: "OK", code: "OK", message: "Instrument valide." };
  }

  const critical = (instrument.criticite ?? "").toUpperCase() === "CRITIQUE";
  if (critical && policy.block_on_overdue_critical) {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_OVERDUE_CRITICAL",
      message: `Instrument critique en retard d'étalonnage (échéance ${instrument.next_due_date}).`,
    };
  }
  return {
    allowed: true,
    severity: "WARNING",
    code: critical ? "INSTRUMENT_OVERDUE_CRITICAL" : "INSTRUMENT_OVERDUE",
    message: `Étalonnage dépassé (échéance ${instrument.next_due_date}) : traçabilité dégradée.`,
  };
}

export function isInstrumentOverdue(instrument: InstrumentState, at: Date): boolean {
  if (!instrument.next_due_date) return false;
  const due = new Date(instrument.next_due_date);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < at.getTime();
}

/* -------------------------------------------------------------------------- */
/* 5) Dérogations / concessions — usage                                       */
/* -------------------------------------------------------------------------- */

export type DerogationState = {
  id: string;
  code: string;
  status: string;
  article_id: string | null;
  piece_technique_id: string | null;
  piece_version_id: string | null;
  lot_id: string | null;
  of_id: string | null;
  commande_id: string | null;
  bon_livraison_id: string | null;
  max_qty: number | null;
  unit: string | null;
  consumed_qty: number;
  valid_from: string | null;
  valid_to: string | null;
};

export type DerogationUsageContext = {
  article_id: string | null;
  piece_technique_id: string | null;
  piece_version_id: string | null;
  lot_id: string | null;
  of_id: string | null;
  commande_id: string | null;
  bon_livraison_id: string | null;
  unit: string | null;
};

export type DerogationUsageEvaluation = {
  allowed: boolean;
  code:
    | "OK"
    | "DEROGATION_NOT_APPROVED"
    | "DEROGATION_EXPIRED"
    | "DEROGATION_NOT_YET_VALID"
    | "DEROGATION_REVOKED"
    | "DEROGATION_OUT_OF_SCOPE"
    | "DEROGATION_UNIT_MISMATCH"
    | "DEROGATION_QTY_EXCEEDED";
  remaining_qty: number | null;
  message: string;
};

const DEROGATION_SCOPE_AXES = [
  "article_id",
  "piece_technique_id",
  "piece_version_id",
  "lot_id",
  "of_id",
  "commande_id",
  "bon_livraison_id",
] as const;

export function evaluateDerogationUsage(params: {
  derogation: DerogationState;
  context: DerogationUsageContext;
  qty: number;
  at: Date;
}): DerogationUsageEvaluation {
  const { derogation, context, qty, at } = params;
  const remaining =
    derogation.max_qty === null ? null : Math.max(0, derogation.max_qty - derogation.consumed_qty);

  const deny = (
    code: Exclude<DerogationUsageEvaluation["code"], "OK">,
    message: string
  ): DerogationUsageEvaluation => ({ allowed: false, code, remaining_qty: remaining, message });

  const status = (derogation.status ?? "").toUpperCase();
  if (status === "REVOKED") return deny("DEROGATION_REVOKED", "Dérogation révoquée.");
  if (status === "EXPIRED") return deny("DEROGATION_EXPIRED", "Dérogation expirée.");
  if (status !== "APPROVED" && status !== "CONSUMED") {
    return deny("DEROGATION_NOT_APPROVED", `Dérogation non approuvée (${status || "statut inconnu"}).`);
  }

  if (derogation.valid_from) {
    const from = new Date(derogation.valid_from);
    if (!Number.isNaN(from.getTime()) && at.getTime() < from.getTime()) {
      return deny("DEROGATION_NOT_YET_VALID", "Dérogation pas encore valide.");
    }
  }
  if (derogation.valid_to) {
    const to = new Date(derogation.valid_to);
    if (!Number.isNaN(to.getTime()) && at.getTime() > to.getTime()) {
      return deny("DEROGATION_EXPIRED", "Dérogation expirée.");
    }
  }

  for (const axis of DEROGATION_SCOPE_AXES) {
    const expected = derogation[axis];
    if (!expected) continue;
    if (context[axis] !== expected) {
      return deny("DEROGATION_OUT_OF_SCOPE", `Dérogation hors périmètre sur ${axis}.`);
    }
  }
  // Une concession sans aucun axe ne couvre rien : elle ne peut pas devenir un
  // blanc-seing global.
  const hasScope = DEROGATION_SCOPE_AXES.some((axis) => Boolean(derogation[axis]));
  if (!hasScope) {
    return deny("DEROGATION_OUT_OF_SCOPE", "Dérogation sans périmètre exploitable.");
  }

  if (derogation.unit && context.unit && derogation.unit.trim() !== context.unit.trim()) {
    return deny("DEROGATION_UNIT_MISMATCH", "Unité de la concession incohérente avec la décision.");
  }

  if (!Number.isFinite(qty) || qty <= EPS) {
    return deny("DEROGATION_QTY_EXCEEDED", "Quantité de consommation invalide.");
  }
  if (remaining !== null && qty > remaining + EPS) {
    return deny(
      "DEROGATION_QTY_EXCEEDED",
      `Quantité résiduelle insuffisante (${remaining} restant).`
    );
  }

  return { allowed: true, code: "OK", remaining_qty: remaining, message: "Concession applicable." };
}

export function derogationStatusAfterConsumption(params: {
  max_qty: number | null;
  consumed_qty: number;
}): "APPROVED" | "CONSUMED" {
  if (params.max_qty === null) return "APPROVED";
  return params.consumed_qty + EPS >= params.max_qty ? "CONSUMED" : "APPROVED";
}

/* -------------------------------------------------------------------------- */
/* 6) Moteur d'éligibilité ciblé                                              */
/* -------------------------------------------------------------------------- */

export const QUALITY_ELIGIBILITY_PURPOSES = ["RESERVE", "SHIP", "INVOICE"] as const;
export type QualityEligibilityPurpose = (typeof QUALITY_ELIGIBILITY_PURPOSES)[number];

export type EligibilityTarget = {
  object_type: QualitySourceType;
  object_id: string;
  label: string | null;
  qty_requested: number;
  // État qualité de l'objet exact, jamais de l'usine entière.
  lot_status: "LIBERE" | "EN_ATTENTE" | "QUARANTAINE" | "BLOQUE" | null;
  qty_released: number;
  qty_held: number;
  qty_consumed: number;
  open_nc_without_disposition: number;
  pending_mandatory_controls: number;
  derogation: { status: string; valid_to: string | null } | null;
};

export type EligibilityBlock = {
  code:
    | "LOT_NOT_RELEASED"
    | "LOT_QUARANTINE"
    | "QTY_NOT_RELEASED"
    | "OPEN_NON_CONFORMITY"
    | "MANDATORY_CONTROL_PENDING"
    | "DEROGATION_EXPIRED";
  message: string;
  expected_action: string;
  object_type: QualitySourceType;
  object_id: string;
};

export type EligibilityVerdict = {
  allowed: boolean;
  qty_allowed: number;
  blocks: EligibilityBlock[];
};

/**
 * Décide si une quantité identifiée peut être réservée, expédiée ou facturée.
 * Le blocage est ciblé objet + quantité + statut et il explique la cause et
 * l'action attendue. Aucun blocage global d'articles non concernés.
 */
export function evaluateQualityEligibility(
  target: EligibilityTarget,
  purpose: QualityEligibilityPurpose,
  at: Date
): EligibilityVerdict {
  const blocks: EligibilityBlock[] = [];
  const anchor = { object_type: target.object_type, object_id: target.object_id };

  if (target.lot_status === "BLOQUE") {
    blocks.push({
      ...anchor,
      code: "LOT_NOT_RELEASED",
      message: `Lot ${target.label ?? target.object_id} bloqué qualité.`,
      expected_action: "Prononcer une disposition qualité (libération, tri, rebut ou retour).",
    });
  }
  if (target.lot_status === "QUARANTAINE" || target.lot_status === "EN_ATTENTE") {
    blocks.push({
      ...anchor,
      code: "LOT_QUARANTINE",
      message: `Lot ${target.label ?? target.object_id} en quarantaine.`,
      expected_action: "Terminer le contrôle puis décider la libération de la quantité acceptée.",
    });
  }
  if (target.pending_mandatory_controls > 0) {
    blocks.push({
      ...anchor,
      code: "MANDATORY_CONTROL_PENDING",
      message: `${target.pending_mandatory_controls} contrôle(s) obligatoire(s) non terminé(s).`,
      expected_action: "Exécuter les contrôles obligatoires du plan applicable.",
    });
  }
  if (target.open_nc_without_disposition > 0) {
    blocks.push({
      ...anchor,
      code: "OPEN_NON_CONFORMITY",
      message: `${target.open_nc_without_disposition} non-conformité(s) sans disposition.`,
      expected_action: "Prononcer la disposition de chaque non-conformité ouverte.",
    });
  }
  if (target.derogation) {
    const status = target.derogation.status.toUpperCase();
    const expired =
      status === "EXPIRED" ||
      status === "REVOKED" ||
      (target.derogation.valid_to
        ? new Date(target.derogation.valid_to).getTime() < at.getTime()
        : false);
    if (expired) {
      blocks.push({
        ...anchor,
        code: "DEROGATION_EXPIRED",
        message: "La dérogation invoquée est expirée ou révoquée.",
        expected_action: "Obtenir une nouvelle dérogation approuvée ou traiter la non-conformité.",
      });
    }
  }

  const availableReleased = Math.max(0, target.qty_released - target.qty_consumed);
  const requested = Number.isFinite(target.qty_requested) ? Math.max(0, target.qty_requested) : 0;
  if (requested > availableReleased + EPS) {
    blocks.push({
      ...anchor,
      code: "QTY_NOT_RELEASED",
      message: `Quantité non libérée : ${requested} demandé, ${availableReleased} libéré.`,
      expected_action:
        purpose === "INVOICE"
          ? "Facturer uniquement la quantité libérée."
          : "Libérer la quantité complémentaire ou réduire la demande.",
    });
  }

  const qtyAllowed = blocks.some((b) => b.code !== "QTY_NOT_RELEASED")
    ? 0
    : Math.min(requested, availableReleased);

  return { allowed: blocks.length === 0, qty_allowed: qtyAllowed, blocks };
}

export function assertQualityEligibility(
  target: EligibilityTarget,
  purpose: QualityEligibilityPurpose,
  at: Date
): void {
  const verdict = evaluateQualityEligibility(target, purpose, at);
  if (!verdict.allowed) {
    throw new HttpError(
      409,
      "QUALITY_NOT_ELIGIBLE",
      "Quantité non éligible : la Qualité bloque cet objet précis.",
      { purpose, qty_allowed: verdict.qty_allowed, blocks: verdict.blocks }
    );
  }
}
