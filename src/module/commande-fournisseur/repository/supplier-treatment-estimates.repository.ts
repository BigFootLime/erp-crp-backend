import { createHash } from "node:crypto";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";

export type TreatmentEstimateInput = {
  orderId: string;
  lineId: string;
  estimatedReturnDate: string;
  reason: string;
  sourceVersion: string;
  idempotencyKey: string;
  actorId: number;
};

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function listTreatmentEstimates(orderId: string) {
  const rows = await db.query(
    `SELECT estimate.id::text,estimate.line_id::text,estimate.estimated_return_date::text,
       estimate.reason,estimate.source_version,estimate.created_by,estimate.updated_at::text,estimate.status,
       line.position,line.designation,line.type,line.date_promesse::text AS official_promise_date
     FROM public.supplier_internal_treatment_estimates estimate
     JOIN public.commande_fournisseur_ligne line ON line.id=estimate.line_id
     WHERE estimate.order_id=$1::uuid
     ORDER BY line.position,line.id`,
    [orderId],
  );
  return {
    order_id: orderId,
    items: rows.rows.map((row) => ({
      ...row,
      promise_state: "ESTIMATED_NOT_CONFIRMED",
    })),
  };
}

/** Writes only the internal estimate table; official promise and CBN inputs stay untouched. */
export async function saveTreatmentEstimate(input: TreatmentEstimateInput) {
  const tx = await db.connect();
  const requestHash = hash({
    orderId: input.orderId,
    lineId: input.lineId,
    estimatedReturnDate: input.estimatedReturnDate,
    reason: input.reason,
    sourceVersion: input.sourceVersion,
  });
  try {
    await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `treatment-estimate:${input.actorId}:${input.idempotencyKey}`,
    ]);
    const replay = (
      await tx.query<{ request_hash: string; result: Record<string, unknown> }>(
        `SELECT request_hash,result FROM public.supplier_internal_treatment_estimate_commands
         WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.actorId, input.idempotencyKey],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== requestHash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Clé d'idempotence déjà utilisée avec une autre estimation.",
        );
      await tx.query("COMMIT");
      return { ...replay.result, idempotency_replayed: true };
    }
    const estimate = (
      await tx.query(
        `INSERT INTO public.supplier_internal_treatment_estimates(supplier_id,order_id,line_id,estimated_return_date,reason,source_version,created_by)
         SELECT c.fournisseur_id,c.id,l.id,$3::date,$4,$5,$6 FROM public.commande_fournisseur c
         JOIN public.commande_fournisseur_ligne l ON l.commande_id=c.id
         WHERE c.id=$1::uuid AND l.id=$2::uuid AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
           AND l.statut_ligne='ACTIVE' AND (l.type='SOUS_TRAITANCE' OR l.operation_libelle IS NOT NULL)
         ON CONFLICT(line_id) DO UPDATE SET estimated_return_date=EXCLUDED.estimated_return_date,reason=EXCLUDED.reason,
           source_version=EXCLUDED.source_version,created_by=EXCLUDED.created_by,updated_at=now()
         RETURNING id::text,estimated_return_date::text,status,reason,source_version,updated_at::text`,
        [
          input.orderId,
          input.lineId,
          input.estimatedReturnDate,
          input.reason,
          input.sourceVersion,
          input.actorId,
        ],
      )
    ).rows[0];
    if (!estimate)
      throw new HttpError(
        409,
        "SUPPLIER_TREATMENT_LINE_NOT_OPEN",
        "La ligne est inexistante, clôturée ou ne correspond pas à un traitement.",
      );
    const result = {
      ...estimate,
      promise_state: "ESTIMATED_NOT_CONFIRMED",
      idempotency_replayed: false,
    };
    await tx.query(
      `INSERT INTO public.supplier_internal_treatment_estimate_commands(actor_id,idempotency_key,request_hash,result)
       VALUES($1,$2,$3,$4::jsonb)`,
      [
        input.actorId,
        input.idempotencyKey,
        requestHash,
        JSON.stringify(result),
      ],
    );
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
