import { laterScheduleConversions } from "../repository/demand-forecast-conversion";
import { createHash } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { PoolClient } from "pg";
import { executeClientForecastCommandTx } from "../../client/services/client-contract-forecast.service";
import { reviseDeliveryPromises } from "../../affaire/repository/delivery-promises.repository";

type ClaimedJob = {
  revision_id: string;
  idempotency_key: string;
  requested_by_user_id: number | null;
};
type Aggregate = {
  quantity: string;
  delivery_due: string;
  revision_ids: string[];
  has_total: boolean;
  has_remaining: boolean;
};

const currentRevision = `NOT EXISTS(SELECT 1 FROM public.demand_pilot_revisions newer WHERE
 (newer.client_id,newer.external_site,newer.external_order_key,newer.external_line_key,newer.external_schedule_key)
 =(r.client_id,r.external_site,r.external_order_key,r.external_line_key,r.external_schedule_key)
 AND newer.kind='FORECAST' AND newer.revision_no>r.revision_no AND newer.status IN('ACCEPTED_PENDING_MATERIALIZATION','MATERIALIZED'))`;

function audit(userId: number) {
  return {
    user_id: userId,
    ip: null,
    user_agent: null,
    device_type: null,
    os: null,
    browser: null,
    path: "demand-pilot-materialization",
    page_key: "demand-pilot",
    client_session_id: null,
  };
}

const stableMonthKey = (revisionId: string, month: string) => {
  const hex = createHash("sha256")
    .update(`demand-pilot-month:${revisionId}:${month}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 17), 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Aggregate current accepted schedules only. Superseded/moved rows therefore
 * disappear from their former month instead of being added twice. */
async function acceptedMonth(
  tx: { query: Function },
  contractLineId: string,
  month: string,
): Promise<Aggregate> {
  const result = await tx.query(
    `
    SELECT COALESCE(sum(CASE WHEN r.quantity_basis='REMAINING' THEN greatest(0,r.quantity-${laterScheduleConversions}) ELSE r.quantity END),0)::text AS quantity,min(COALESCE(r.accepted_need_date,r.need_date))::text AS delivery_due,
      COALESCE(array_agg(r.id::text ORDER BY r.need_date,r.created_at,r.id),'{}'::text[]) AS revision_ids,
      COALESCE(bool_or(r.quantity_basis='TOTAL'),false) AS has_total, COALESCE(bool_or(r.quantity_basis='REMAINING'),false) AS has_remaining
    FROM public.demand_pilot_revisions r
    WHERE r.contract_line_id=$1::uuid AND date_trunc('month',COALESCE(r.accepted_need_date,r.need_date))::date=$2::date
      AND r.kind='FORECAST' AND r.status IN ('ACCEPTED_PENDING_MATERIALIZATION','MATERIALIZED')
      AND ${currentRevision}
  `,
    [contractLineId, `${month}-01`],
  );
  return (
    result.rows[0] ?? {
      quantity: "0",
      delivery_due: `${month}-01`,
      revision_ids: [],
      has_total: false,
      has_remaining: false,
    }
  );
}

async function markReview(revisionId: string, message: string) {
  await pool.query(
    `UPDATE public.demand_pilot_materialization_jobs SET status='REVIEW',last_error=$2,updated_at=now() WHERE revision_id=$1::uuid AND status<>'DONE'`,
    [revisionId, message.slice(0, 1000)],
  );
  await pool.query(
    `UPDATE public.demand_pilot_revisions SET status='REVIEW',decision_reason=COALESCE(decision_reason,$2) WHERE id=$1::uuid AND status='ACCEPTED_PENDING_MATERIALIZATION'`,
    [revisionId, message.slice(0, 2000)],
  );
}

async function markRetry(revisionId: string, message: string) {
  await pool.query(
    `UPDATE public.demand_pilot_materialization_jobs SET status='FAILED',last_error=$2,updated_at=now() WHERE revision_id=$1::uuid AND status='PROCESSING'`,
    [revisionId, message.slice(0, 1000)],
  );
}

/** A stale PROCESSING claim is recoverable with the original actor/key. */
async function claim(
  tx: { query: Function },
  revisionId: string,
): Promise<ClaimedJob | null> {
  const result = await tx.query(
    `UPDATE public.demand_pilot_materialization_jobs
    SET status='PROCESSING',attempt_count=attempt_count+1,updated_at=now()
    WHERE revision_id=$1::uuid AND (status IN ('PENDING','FAILED') OR (status='PROCESSING' AND updated_at < now()-interval '5 minutes'))
    RETURNING revision_id::text,idempotency_key::text,requested_by_user_id`,
    [revisionId],
  );
  return (result.rows[0] as ClaimedJob | undefined) ?? null;
}

async function applyMonth(
  tx: PoolClient,
  params: {
    revisionId: string;
    clientId: string;
    contractId: string;
    contractLineId: string;
    month: string;
    contractVersion: number;
    actorId: number;
  },
) {
  const date = params.month + "-01";
  const aggregate = await acceptedMonth(
    tx,
    params.contractLineId,
    params.month,
  );
  const existing = (
    await tx.query<{
      id: string;
      version: number;
      managed: boolean;
      converted: string;
      delivery_due: string;
    }>(
      `SELECT f.id::text,f.version,f.delivery_due::text,
  COALESCE(c.converted_quantity,0)::text AS converted, EXISTS(SELECT 1 FROM public.demand_pilot_forecast_bindings b WHERE b.forecast_id=f.id) AS managed
  FROM public.client_contract_forecasts f JOIN public.v_client_contract_forecast_coverage c ON c.forecast_id=f.id
  WHERE f.contract_id=$1 AND f.contract_line_id=$2 AND f.month=$3 FOR UPDATE OF f`,
      [params.contractId, params.contractLineId, date],
    )
  ).rows[0];
  if (existing && !existing.managed)
    throw new HttpError(
      409,
      "DEMAND_PILOT_FORECAST_OWNERSHIP",
      "Une prévision hors pilote existe déjà pour cette ligne et ce mois.",
    );
  if (!existing && !Number(aggregate.quantity))
    return { month: params.month, skipped: true };
  const converted = Number(existing?.converted ?? 0);
  if (converted && aggregate.has_total && aggregate.has_remaining)
    throw new HttpError(
      409,
      "DEMAND_FORECAST_BASIS_REVIEW",
      "Rapprocher les conversions avant de mélanger quantités totales et restantes.",
    );
  const quantity = aggregate.has_total
    ? Number(aggregate.quantity)
    : Number(aggregate.quantity) + converted;
  const key = stableMonthKey(params.revisionId, params.month);
  const saved = await executeClientForecastCommandTx(
    tx,
    params.clientId,
    params.contractId,
    {
      action: "SAVE",
      expected_contract_version: params.contractVersion,
      contract_line_id: params.contractLineId,
      month: params.month,
      expected_version: existing?.version ?? null,
      quantity,
      delivery_due: aggregate.delivery_due || existing?.delivery_due || date,
      estimate_date: aggregate.delivery_due || existing?.delivery_due || date,
      reason: "Programme client agrégé " + params.month,
    },
    key,
    audit(params.actorId),
  );
  const forecastId = saved.result.forecast.id,
    result = {
      month: params.month,
      forecast_id: forecastId,
      quantity,
      revision_ids: aggregate.revision_ids,
    };
  await tx.query(
    "INSERT INTO public.demand_pilot_forecast_bindings(forecast_id,contract_line_id,month) VALUES($1,$2,$3) ON CONFLICT(forecast_id) DO NOTHING",
    [forecastId, params.contractLineId, date],
  );
  await tx.query(
    `INSERT INTO public.demand_pilot_materialization_operations(revision_id,contract_line_id,month,idempotency_key,status,result)
 VALUES($1,$2,$3,$4,'DONE',$5) ON CONFLICT(revision_id,contract_line_id,month) DO NOTHING`,
    [
      params.revisionId,
      params.contractLineId,
      date,
      key,
      JSON.stringify(result),
    ],
  );
  return result;
}

async function materializeBoundFirm(
  row: any,
  revisionId: string,
  actorId: number,
) {
  const binding = (
    await pool.query<any>(
      `SELECT b.promise_root_id::text,r.affaire_id::int,r.version::int,r.initial_quantity::float8,
      COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s JOIN public.delivery_promise_parts p ON p.id=s.part_id WHERE p.root_id=r.id),0)::float8 AS shipped_quantity
    FROM public.demand_pilot_revisions d JOIN public.demand_pilot_firm_binding_scopes b
    ON (b.client_id,b.external_site,b.external_order_key,b.external_line_key,b.external_schedule_key,b.article_id)
     =(d.client_id,d.external_site,d.external_order_key,d.external_line_key,d.external_schedule_key,d.article_id)
     AND b.contract_id IS NOT DISTINCT FROM d.contract_id AND b.contract_line_id IS NOT DISTINCT FROM d.contract_line_id
    JOIN public.delivery_promise_roots r ON r.id=b.promise_root_id JOIN public.commande_client c ON c.id=r.commande_id JOIN public.commande_ligne l ON l.id=r.line_id
    WHERE d.id=$1::uuid AND c.client_id=$2 AND l.article_id=$3::uuid`,
      [revisionId, row.client_id, row.article_id],
    )
  ).rows[0];
  if (!binding)
    throw new HttpError(
      409,
      "DEMAND_PILOT_FIRM_BINDING_REQUIRED",
      "Un rattachement ADV vérifié à une promesse est requis.",
    );
  const key = stableMonthKey(revisionId, "firm");
  const replay = await pool.query(
    "SELECT root_id FROM public.delivery_promise_events WHERE actor_id=$1 AND request_key=$2",
    [actorId, key],
  );
  if (replay.rowCount) {
    if (replay.rows[0].root_id !== binding.promise_root_id)
      throw new HttpError(
        409,
        "FIRM_REVISION_CONFLICT",
        "La tentative avait une autre promesse.",
      );
    return { promise_root_id: binding.promise_root_id, replayed: true };
  }
  const remaining =
    Number(binding.initial_quantity) - Number(binding.shipped_quantity);
  const requested = Number(
    row.quantity_basis === "REMAINING"
      ? row.quantity
      : Number(row.quantity) - Number(binding.shipped_quantity),
  );
  if (remaining <= 0.000001)
    throw new HttpError(
      409,
      "DEMAND_PILOT_FIRM_ALREADY_SHIPPED",
      "La ligne est déjà entièrement expédiée.",
    );
  if (requested < -0.000001 || Math.abs(requested - remaining) > 0.000001)
    throw new HttpError(
      409,
      "DEMAND_PILOT_FIRM_QUANTITY_REVIEW",
      "La quantité ferme ne correspond pas au reliquat réellement expédiable; un avenant ADV est requis.",
    );
  // Existing AR quantity remains immutable; this canonical promise revision is
  // deliberately date-only and keeps shipped parts untouched.
  const result = await reviseDeliveryPromises(
    Number(binding.affaire_id),
    {
      root_id: binding.promise_root_id,
      expected_version: Number(binding.version),
      request_key: key,
      reason: `Recalage programme client ${revisionId}`,
      parts: [{ quantity: remaining, due_date: row.need_date }],
    },
    audit(actorId) as any,
  );
  return { promise_root_id: binding.promise_root_id, ...result };
}

export async function processDemandMaterialization(revisionId: string) {
  const tx = await pool.connect();
  let job: ClaimedJob | null = null;
  try {
    await tx.query("BEGIN");
    job = await claim(tx, revisionId);
    if (!job) {
      await tx.query("COMMIT");
      return { skipped: true };
    }
    const row = (
      await tx.query<any>(
        `SELECT r.client_id,r.kind,r.quantity::text,r.quantity_basis,r.article_id::text,COALESCE(r.accepted_need_date,r.need_date)::text AS need_date,r.contract_id::text,r.contract_line_id::text,r.status,r.before_snapshot
      FROM public.demand_pilot_revisions r WHERE r.id=$1::uuid FOR UPDATE`,
        [revisionId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== "ACCEPTED_PENDING_MATERIALIZATION" ||
      !job.requested_by_user_id
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_MATERIALIZATION_REVIEW",
        "La demande n’est plus matérialisable automatiquement.",
      );
    const superseded = await tx.query(
      `SELECT 1 FROM public.demand_pilot_revisions n WHERE n.client_id=$1
      AND n.external_site=(SELECT external_site FROM public.demand_pilot_revisions WHERE id=$2::uuid)
      AND n.external_order_key=(SELECT external_order_key FROM public.demand_pilot_revisions WHERE id=$2::uuid)
      AND n.external_line_key=(SELECT external_line_key FROM public.demand_pilot_revisions WHERE id=$2::uuid)
      AND n.external_schedule_key=(SELECT external_schedule_key FROM public.demand_pilot_revisions WHERE id=$2::uuid)
      AND n.status IN('ACCEPTED_PENDING_MATERIALIZATION','MATERIALIZED') AND n.revision_no>(SELECT revision_no FROM public.demand_pilot_revisions WHERE id=$2::uuid) LIMIT 1`,
      [row.client_id, revisionId],
    );
    if (superseded.rowCount)
      throw new HttpError(
        409,
        "DEMAND_PILOT_SUPERSEDED",
        "Cette révision a été remplacée avant sa matérialisation.",
      );
    if (row.kind === "FIRM") {
      await tx.query("COMMIT");
      const result = await materializeBoundFirm(
        row,
        revisionId,
        job.requested_by_user_id,
      );
      await tx.query("BEGIN");
      await tx.query(
        `UPDATE public.demand_pilot_materialization_jobs SET status='DONE',result=$2::jsonb,last_error=NULL,updated_at=now() WHERE revision_id=$1::uuid`,
        [revisionId, JSON.stringify(result)],
      );
      await tx.query(
        `UPDATE public.demand_pilot_revisions SET status='MATERIALIZED',materialization_ref=$2 WHERE id=$1::uuid AND status='ACCEPTED_PENDING_MATERIALIZATION'`,
        [revisionId, `promise:${result.promise_root_id}`],
      );
      await tx.query("COMMIT");
      return { materialized: true, ...result };
    }
    if (!row.contract_id || !row.contract_line_id)
      throw new HttpError(
        409,
        "DEMAND_PILOT_CONTRACT_REQUIRED",
        "Une prévision requiert un contrat et une ligne vérifiés.",
      );
    const contract = (
      await tx.query<any>(
        `SELECT version FROM public.client_contracts WHERE id=$1::uuid AND client_id=$2 AND status='ACTIVE' FOR SHARE`,
        [row.contract_id, row.client_id],
      )
    ).rows[0];
    if (!contract)
      throw new HttpError(
        409,
        "DEMAND_PILOT_CONTRACT_CHANGED",
        "Contrat actif introuvable.",
      );
    const predecessor = (
      await tx.query<{ due: string }>(
        `SELECT COALESCE(p.accepted_need_date,p.need_date)::text AS due FROM public.demand_pilot_revisions p
     JOIN public.demand_pilot_revisions r ON (p.client_id,p.external_site,p.external_order_key,p.external_line_key,p.external_schedule_key)
     =(r.client_id,r.external_site,r.external_order_key,r.external_line_key,r.external_schedule_key)
     WHERE r.id=$1 AND p.revision_no<r.revision_no AND p.status='MATERIALIZED' ORDER BY p.revision_no DESC LIMIT 1`,
        [revisionId],
      )
    ).rows[0];
    const months = [
      ...new Set(
        [predecessor?.due.slice(0, 7), row.need_date.slice(0, 7)].filter(
          Boolean,
        ) as string[],
      ),
    ].sort();
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "demand-forecast:" + row.contract_line_id,
    ]);
    const results = [];
    for (const month of months)
      results.push(
        await applyMonth(tx, {
          revisionId,
          clientId: row.client_id,
          contractId: row.contract_id,
          contractLineId: row.contract_line_id,
          month,
          contractVersion: contract.version,
          actorId: job.requested_by_user_id,
        }),
      );
    await tx.query(
      "UPDATE public.demand_pilot_materialization_jobs SET status='DONE',result=$2,last_error=NULL,updated_at=now() WHERE revision_id=$1",
      [revisionId, JSON.stringify(results)],
    );
    await tx.query(
      "UPDATE public.demand_pilot_revisions SET status='MATERIALIZED',materialization_ref=$2 WHERE id=$1 AND status='ACCEPTED_PENDING_MATERIALIZATION'",
      [revisionId, "forecast:" + row.contract_line_id + ":" + months.join(",")],
    );
    await tx.query("COMMIT");
    return { materialized: true, months: results };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    if (job) {
      const message =
        error instanceof Error
          ? error.message
          : "Erreur inconnue de matérialisation";
      // Version conflicts are expected if two schedules for a month are
      // accepted concurrently. Retrying rereads the current aggregate and
      // keeps the original idempotency attribution. Business refusals remain
      // explicitly visible to ADV instead of looping forever.
      if (
        !(error instanceof HttpError) ||
        error.code === "CLIENT_FORECAST_VERSION_CONFLICT"
      )
        await markRetry(revisionId, message);
      else await markReview(revisionId, message);
    }
    throw error;
  } finally {
    tx.release();
  }
}

/** Timer/queue entrypoint; it reclaims only abandoned claims, not REVIEW/DONE. */
export async function recoverDemandMaterializations(limit = 25) {
  const jobs = (
    await pool.query<{ revision_id: string }>(
      `SELECT revision_id::text FROM public.demand_pilot_materialization_jobs
    WHERE status IN ('PENDING','FAILED') OR (status='PROCESSING' AND updated_at < now()-interval '5 minutes') ORDER BY created_at LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    )
  ).rows;
  const outcomes: Array<{ revision_id: string; ok: boolean }> = [];
  for (const item of jobs) {
    try {
      await processDemandMaterialization(item.revision_id);
      outcomes.push({ revision_id: item.revision_id, ok: true });
    } catch {
      outcomes.push({ revision_id: item.revision_id, ok: false });
    }
  }
  return outcomes;
}
