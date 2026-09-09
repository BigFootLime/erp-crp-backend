// Canonical Quality 360 gate for operational writes (#616).
//
// This intentionally consumes the same pure eligibility evaluator as the
// Quality API and shipment gate.  It performs all reads through the caller's
// transaction, so a stock/production/finance write cannot commit against a
// stale quality decision.

import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import {
  assertQualityEligibility,
  evaluateQualityEligibility,
  type EligibilityTarget,
  type QualityEligibilityPurpose,
} from "../domain/quality-release";

type Queryable = Pick<PoolClient, "query">;

export type OperationalQualityDecision = {
  purpose: QualityEligibilityPurpose;
  target: EligibilityTarget;
  /**
   * Reservations are commitments against the released quantity even before a
   * physical issue is posted.  Keeping this explicit prevents the audit
   * snapshot from pretending that a reservation is already consumed.
   */
  already_committed_qty: number;
  evaluated_at: string;
  evidence: {
    control_ids: string[];
    release_decision_ids: string[];
    derogation_ids: string[];
    receipt_admission_ids?: string[];
  };
};

const numeric = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Evaluates a physical lot under the lock held by the business command. A
 * missing control/release quantity remains a zero quantity and is therefore
 * rejected by `assertQualityEligibility`; it is never converted into a pass.
 */
async function inspectOperationalLotQualityEligibility(params: {
  client: Queryable;
  lotId: string;
  qty: number;
  /** Physical movement/reservation unit when the caller has one. */
  unit?: string | null;
  purpose: QualityEligibilityPurpose;
  lockRows:boolean;
  receiptLineId?:string;
}) {
  const lotRes = await params.client.query<{
    lot_code: string;
    lot_status: EligibilityTarget["lot_status"];
    article_unit: string | null;
  }>(
    `
      SELECT lot.lot_code, lot.lot_status::text AS lot_status, article.unite AS article_unit
      FROM public.lots lot
      JOIN public.articles article ON article.id = lot.article_id
      WHERE lot.id = $1::uuid
      ${params.lockRows ? "FOR UPDATE" : ""}
    `,
    [params.lotId]
  );
  const lot = lotRes.rows[0] ?? null;
  if (!lot) throw new HttpError(409, "QUALITY_LOT_NOT_FOUND", "Le lot à contrôler est introuvable.");

  const controls = await params.client.query<{
    id: string;
    qty_released: string;
    qty_held: string;
    qty_consumed: string;
    unite: string | null;
    pending: boolean;
    trigger_type:string|null;
    reception_ligne_id:string|null;
  }>(
    `
      SELECT
        qc.id::text AS id,
        qc.qty_released::text AS qty_released,
        qc.qty_held::text AS qty_held,
        qc.qty_consumed::text AS qty_consumed,
        qc.unite,qc.trigger_type,qc.reception_ligne_id::text,
        (qc.validation_date IS NULL OR COALESCE(qc.verdict, 'EN_ATTENTE') = 'EN_ATTENTE') AS pending
      FROM public.quality_control qc
      WHERE qc.lot_id = $1::uuid
         OR (qc.source_type = 'LOT' AND qc.source_id = $1::text)
      ORDER BY qc.control_date DESC, qc.id DESC
      LIMIT 1
      ${params.lockRows ? "FOR UPDATE" : ""}
    `,
    [params.lotId]
  );
  // One lot release is an entitlement, not an additive vote. Use the newest
  // control exactly as the delivery-release aggregate does; summing historical
  // controls for the same population would over-authorize physical stock.
  const controlIds = controls.rows.map((row) => row.id);
  const admission=!controls.rows.length?(await params.client.query<{id:string;quantity:number;unit:string;receipt_line_id:string;direct_consumed:number}>(`
    SELECT d.id::text,d.quantity::float8,d.unit,d.receipt_line_id::text,
      COALESCE((SELECT sum(abs(sl.qty)) FROM public.stock_movement_lines sl JOIN public.stock_movements sm ON sm.id=sl.movement_id
        WHERE sl.lot_id=d.lot_id AND sm.status='POSTED' AND sm.movement_type='OUT'
          AND NOT EXISTS(SELECT 1 FROM public.of_material_consumptions mc WHERE mc.stock_movement_line_id=sl.id AND mc.reservation_id IS NOT NULL)),0)::float8 AS direct_consumed
    FROM public.consumable_receipt_admissions d JOIN public.reception_fournisseur_lignes rl ON rl.id=d.receipt_line_id
    WHERE d.lot_id=$1::uuid AND rl.lot_id=d.lot_id AND NOT rl.receipt_quality_required`,[params.lotId])).rows[0]:null;
  if(params.receiptLineId&&admission?.receipt_line_id!==params.receiptLineId&&(!controls.rows[0]||controls.rows[0].trigger_type!=="RECEPTION"||controls.rows[0].reception_ligne_id!==params.receiptLineId))
    throw new HttpError(409,"QUALITY_RECEIPT_CONTROL_REQUIRED","Ouvrez le contrôle qualité de cette réception et libérez la quantité acceptée avant la mise en stock.");
  const normalizedUnit = (value: string | null | undefined) => value?.trim().toUpperCase() || null;
  const articleUnit = normalizedUnit(lot.article_unit);
  const requestedUnit = normalizedUnit(params.unit);
  if(admission&&normalizedUnit(admission.unit)!==articleUnit)throw new HttpError(409,'QUALITY_ADMISSION_UNIT_MISMATCH','L’admission enregistrée utilise une unité différente de celle de l’article.');
  if (requestedUnit && articleUnit && requestedUnit !== articleUnit) {
    throw new HttpError(
      409,
      "QUALITY_UNIT_MISMATCH",
      "L'unité du mouvement ne correspond pas à l'unité de l'article du lot.",
      { lot_id: params.lotId, movement_unit: params.unit, article_unit: lot.article_unit }
    );
  }
  const conflictingControl = controls.rows.find((row) => {
    const controlUnit = normalizedUnit(row.unite);
    return Boolean(controlUnit && articleUnit && controlUnit !== articleUnit);
  });
  if (conflictingControl) {
    throw new HttpError(
      409,
      "QUALITY_CONTROL_UNIT_MISMATCH",
      "La décision Qualité du lot utilise une unité incompatible avec l'article.",
      { lot_id: params.lotId, article_unit: lot.article_unit, control_id: conflictingControl.id, control_unit: conflictingControl.unite }
    );
  }
  // A quality release is a finite entitlement.  `quality_control.qty_consumed`
  // is the formal ledger, but stock reservations are the operational
  // commitment made before the physical issue.  Count both ACTIVE and
  // CONSUMED reservations under the same control-row lock so two concurrent
  // reservations cannot both spend the same released quantity.
  const commitments = await params.client.query<{ qty: string }>(
    `
      SELECT (CASE WHEN status='CONSUMED' OR(status='ACTIVE' AND(expires_at IS NULL OR expires_at>now())) THEN qty_reserved ELSE qty_consumed END)::text AS qty
      FROM public.stock_reservations
      WHERE lot_id = $1::uuid
        AND(status IN ('ACTIVE', 'CONSUMED') OR qty_consumed>0)
      ${params.lockRows ? "FOR SHARE" : ""}
    `,
    [params.lotId]
  );
  // Receipt entry measures admitted physical quantity. Reservations and issues
  // concern that same stock and must not be charged a second time here.
  const alreadyCommittedQty = params.receiptLineId?0:commitments.rows.reduce((sum, row) => sum + numeric(row.qty), 0);
  const nc = await params.client.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.non_conformity nc
      WHERE nc.lot_id = $1::uuid
        AND nc.status::text NOT IN ('CLOSED', 'CANCELLED')
        AND NOT EXISTS (
          SELECT 1 FROM public.non_conformity_dispositions d WHERE d.non_conformity_id = nc.id
        )
    `,
    [params.lotId]
  );
  const concessions = controlIds.length === 0
    ? { rows: [] as Array<{ decision_id: string; derogation_id: string }> }
    : await params.client.query<{ decision_id: string; derogation_id: string }>(
      `
        SELECT rd.id::text AS decision_id, rd.derogation_id::text AS derogation_id
        FROM public.quality_release_decision rd
        JOIN public.quality_derogation d ON d.id = rd.derogation_id
        WHERE rd.quality_control_id = ANY($1::uuid[])
        ORDER BY rd.decided_at DESC, rd.id DESC
      `,
      [controlIds]
    );
  const activeConcession = concessions.rows[0] ?? null;
  const derogation = activeConcession
    ? await params.client.query<{ status: string; valid_to: string | null }>(
      `SELECT status, valid_to::text AS valid_to FROM public.quality_derogation WHERE id = $1::uuid`,
      [activeConcession.derogation_id]
    )
    : { rows: [] as Array<{ status: string; valid_to: string | null }> };

  const target: EligibilityTarget = {
    object_type: "LOT",
    object_id: params.lotId,
    label: lot.lot_code,
    qty_requested: params.qty,
    lot_status: lot.lot_status,
    qty_released: admission?admission.quantity:controls.rows.reduce((sum, row) => sum + numeric(row.qty_released), 0),
    qty_held: controls.rows.reduce((sum, row) => sum + numeric(row.qty_held), 0),
    qty_consumed: params.receiptLineId?0:admission?admission.direct_consumed:controls.rows.reduce((sum, row) => sum + numeric(row.qty_consumed), 0),
    open_nc_without_disposition: Number(nc.rows[0]?.total ?? 0),
    pending_mandatory_controls: controls.rows.filter((row) => row.pending).length,
    derogation: derogation.rows[0] ?? null,
  };
  const at = new Date();
  // Call the evaluator explicitly before asserting to preserve a single,
  // inspectable decision snapshot for the enclosing audit record.
  // Evaluate the requested write together with prior stock commitments.  The
  // returned target remains truthful about this command's own requested
  // quantity; the commitment is carried separately in the audit payload.
  const evaluationTarget = {
    ...target,
    qty_requested: target.qty_requested + alreadyCommittedQty,
  };
  const eligibility=evaluateQualityEligibility(evaluationTarget,params.purpose,at);
  return {
    eligibility,
    evaluationTarget,
    available:Math.max(0,eligibility.qty_allowed-alreadyCommittedQty),
    purpose: params.purpose,
    target,
    already_committed_qty: alreadyCommittedQty,
    evaluated_at: at.toISOString(),
    evidence: {
      control_ids: controlIds,
      release_decision_ids: concessions.rows.map((row) => row.decision_id),
      derogation_ids: concessions.rows.map((row) => row.derogation_id),
      receipt_admission_ids:admission?[admission.id]:[],
    },
  };
}

export async function readOperationalLotQualityEligibility(params:{client:Queryable;lotId:string;qty:number;unit?:string|null;purpose:QualityEligibilityPurpose}){
  return inspectOperationalLotQualityEligibility({...params,lockRows:false});
}
export async function assertOperationalLotQualityEligibility(params:{client:Queryable;lotId:string;qty:number;unit?:string|null;purpose:QualityEligibilityPurpose}):Promise<OperationalQualityDecision>{
  const decision=await inspectOperationalLotQualityEligibility({...params,lockRows:true});
  assertQualityEligibility(decision.evaluationTarget,params.purpose,new Date(decision.evaluated_at));
  return {purpose:decision.purpose,target:decision.target,already_committed_qty:decision.already_committed_qty,evaluated_at:decision.evaluated_at,evidence:decision.evidence};
}

/** qty includes this entry and all previous posted entries for the receipt line. */
export async function assertReceiptLotQualityEligibility(params:{client:Queryable;lotId:string;receiptLineId:string;qty:number;unit:string}){
  const decision=await inspectOperationalLotQualityEligibility({...params,purpose:"RESERVE",lockRows:true});
  assertQualityEligibility(decision.evaluationTarget,"RESERVE",new Date(decision.evaluated_at));
  return decision;
}
export async function readReceiptLotQualityEligibility(params:{client:Queryable;lotId:string;receiptLineId:string;qty:number;unit:string}){
  return inspectOperationalLotQualityEligibility({...params,purpose:"RESERVE",lockRows:false});
}

/**
 * Records an unreserved physical OUT against the exact quality-control row
 * whose entitlement was locked and evaluated.  Reserved flows deliberately
 * do not call this: their ACTIVE/CONSUMED reservation remains the durable
 * commitment ledger and charging both ledgers would double-count it.
 */
export async function recordDirectLotQualityConsumption(params: {
  client: Queryable;
  decision: OperationalQualityDecision;
  qty: number;
}): Promise<void> {
  if (!Number.isFinite(params.qty) || params.qty <= 0) {
    throw new HttpError(422, "QUALITY_MOVEMENT_QTY_INVALID", "Quantité de sortie invalide pour le contrôle Qualité.");
  }
  const controlId = params.decision.evidence.control_ids[0] ?? null;
  if (!controlId) {
    // The posted OUT is the consumption ledger for a dispensed receipt. The
    // gate already bounded it under the lot lock; never create a fake QC row.
    if(params.decision.evidence.receipt_admission_ids?.length)return;
    // The assertion cannot normally succeed without a current control, but do
    // not silently turn an unexpected data shape into an unbounded release.
    throw new HttpError(409, "QUALITY_CONTROL_MISSING", "Aucun contrôle Qualité ne peut enregistrer cette consommation.");
  }
  const updated = await params.client.query<{ id: string }>(
    `
      UPDATE public.quality_control
      SET qty_consumed = qty_consumed + $2,
          updated_at = now()
      WHERE id = $1::uuid
      RETURNING id::text AS id
    `,
    [controlId, params.qty]
  );
  if (!updated.rows[0]) {
    throw new HttpError(409, "QUALITY_CONTROL_MISSING", "Le contrôle Qualité de la sortie est introuvable.");
  }
}
