import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { logger } from "../../../shared/observability/logger";
import { calculateIndustrialPlan } from "../domain/industrial-plan";
import { placeIndustrialProposals } from "../domain/industrial-capacity";
import {
  readOverdueContractTargetPreparations,
  readRecoveryCommitments,
  readPicTargets,
} from "../repository/industrial-targets.repository";
import { industrialExceptions } from "../domain/industrial-exceptions";
import {
  readIndustrialRouting,
  readIndustrialAbc,
} from "../repository/industrial-analysis.repository";
import { projectMasterPlan } from "../domain/planning-master-plan";
import { readMasterPlanSourceTx } from "../repository/planning-master-plan.repository";
import { readIndustrialInput } from "../repository/industrial-input.repository";
import { readIndustrialPolicy } from "../repository/industrial-policy.repository";
import { proposeIndustrialContractTargetRecovery, simulateRecoverySlots } from "../domain/industrial-contract-target-recovery";
import type { z } from "zod";
import type { industrialRunSchema } from "../validators/industrial-plan.validators";

const columns =
  "id::text,client_id,start::text,label,capacity_percent::float8,months,weeks,status,created_at::text,error,source_digest,validated_at::text";
type Run = z.infer<typeof industrialRunSchema> & {
  id: string;
  status: string;
  source_digest: string | null;
};
export async function industrialTx<T>(
  work: (tx: PoolClient) => Promise<T>,
  isolation:
    "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED",
) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL " + isolation);
    const value = await work(tx);
    await tx.query("COMMIT");
    return value;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
async function compute(tx: PoolClient, run: Run) {
  const source = await readIndustrialInput(
    tx,
    run.client_id,
    run.start,
    run.months,
    run.weeks,
  );
  const projection = calculateIndustrialPlan(source);
  const master = await readMasterPlanSourceTx(tx, {
    start: run.start,
    weeks: run.weeks,
  });
  const ids = source.articles.map((a) => a.id);
  const routing = await readIndustrialRouting(tx, ids);
  const abc = await readIndustrialAbc(tx, ids, source.today);
  const through = new Date(
    Date.parse(source.today + "T12:00:00Z") + 41 * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const placements = placeIndustrialProposals({
    proposals: projection.proposals,
    routing,
    snapshot: master.snapshot,
    today: source.today,
    through,
  });
  const preparedContractTargets = await readOverdueContractTargetPreparations(
    tx,
    run.client_id,
    source.today,
  );
  const policy = await readIndustrialPolicy(tx, run.client_id);
  const recoverySlots = simulateRecoverySlots(source,projection,preparedContractTargets,placements,
    {routing,snapshot:master.snapshot,through});
  const recoveryCommitments = await readRecoveryCommitments(tx,[...new Set(preparedContractTargets.map(p=>p.article_id))],run.client_id);
  const contractTargetRecovery = proposeIndustrialContractTargetRecovery({
    source,
    result: projection,
    prepared: preparedContractTargets,
    placements: recoverySlots,
    commitments: recoveryCommitments,
    transitDays: policy.transit_calendar_days,
    capacityPercent: run.capacity_percent,
  });
  const capacity =
    master.snapshot.activation === "OBSERVE"
      ? []
      : projectMasterPlan(
          master.snapshot,
          master.orders,
          master.periods,
        ).capacities.flatMap((res) =>
          res.cells.map((cell, i) => ({
            week: master.periods[i].label,
            resource: res.label,
            id: res.id,
            capacity_minutes:
              cell.capacityMinutes === null
                ? null
                : Math.floor(
                    (cell.capacityMinutes * run.capacity_percent) / 100,
                  ),
            committed_minutes: cell.committedMinutes,
            forecast_minutes: cell.forecastMinutes,
            issues: cell.issues,
          })),
        );
  if (master.snapshot.activation === "OBSERVE")
    projection.issues.push(
      "Capacité atelier non validée : planning en observation.",
    );
  for (const row of capacity)
    if (
      row.capacity_minutes !== null &&
      row.committed_minutes !== null &&
      row.committed_minutes > row.capacity_minutes
    )
      projection.issues.push(
        "Surcharge " + row.resource + " · semaine du " + row.week + ".",
      );
  const targets = await readPicTargets(
    tx,
    run.client_id,
    run.start,
    run.months,
  );
  const pic = projection.pic.map((cell) => {
    const target = targets.find(
      (t) =>
        t.month === cell.month &&
        t.family === cell.family &&
        t.unit === cell.unit,
    );
    return {
      ...cell,
      target_revenue_eur: target?.revenue_target_eur ?? null,
      target_stock: target?.stock_target ?? null,
    };
  });
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sizingPolicy: "qualified-article-yield-with-order-pegging-v2",
        source,
        capacity,
        placements,
        routing,
        abc,
        targets,
        preparedContractTargets,
        recoveryCommitments,
        recoverySlots,
        contractTargetRecovery,
        planningRevision: master.snapshot.revision,
        policy,
      }),
    )
    .digest("hex");
  return {
    result: {
      ...projection,
      pic,
      targets,
      capacity,
      placements,
      contract_target_recovery: contractTargetRecovery,
      abc,
      exceptions: industrialExceptions(source, projection),
      planning_revision: master.snapshot.revision,
      sources: {
        demand: source.demand.length,
        articles: source.articles.length,
        stock_and_receipts: source.supplies.length,
      },
      scope: "ARTICLES_DU_CLIENT_TOUS_ENGAGEMENTS",
    },
    digest,
  };
}
/** Re-read every input inside the caller's SERIALIZABLE transaction.  Execution
 * must never rely on a result JSON that was valid only when it was displayed. */
export async function assertValidatedIndustrialRunFreshTx(
  tx: PoolClient,
  id: string,
) {
  const row = (
    await tx.query<Run & { result: unknown }>(
      `SELECT ${columns},result FROM public.industrial_plan_runs WHERE id=$1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "PLAN_NOT_FOUND", "Calcul introuvable.");
  if (row.status !== "VALIDATED")
    throw new HttpError(
      409,
      "PLAN_NOT_VALIDATED",
      "Validez le PDP avant de créer un ordre.",
    );
  const { digest } = await compute(tx, row);
  if (digest !== row.source_digest)
    throw new HttpError(
      409,
      "PLAN_STALE",
      "Le scénario industriel a changé. Relancez et validez le calcul.",
    );
  if (!row.result)
    throw new HttpError(
      409,
      "PLAN_RESULT_MISSING",
      "Le résultat du calcul est indisponible.",
    );
  return row;
}
export async function enqueueIndustrialRun(
  input: z.infer<typeof industrialRunSchema>,
  actor: number,
) {
  return industrialTx(async (tx) => {
    await readIndustrialPolicy(tx, input.client_id, true);
    const row = (
      await tx.query<Run>(
        `INSERT INTO public.industrial_plan_runs(client_id,start,label,capacity_percent,months,weeks,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
        [
          input.client_id,
          input.start,
          input.label,
          input.capacity_percent,
          input.months,
          input.weeks,
          actor,
        ],
      )
    ).rows[0];
    return row;
  });
}
export async function industrialRunById(id: string) {
  const run = (
    await pool.query(
      "SELECT " +
        columns +
        ",result FROM public.industrial_plan_runs WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!run) throw new HttpError(404, "PLAN_NOT_FOUND", "Calcul introuvable.");
  return run;
}
export async function listIndustrialRuns(clientId: string) {
  return {
    items: (
      await pool.query(
        "SELECT " +
          columns +
          " FROM public.industrial_plan_runs WHERE client_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
        [clientId],
      )
    ).rows,
  };
}
export async function processIndustrialRun() {
  const token = randomUUID();
  const claim = (
    await pool.query<Run>(
      `UPDATE public.industrial_plan_runs SET status='RUNNING',claimed=$1,updated_at=now() WHERE id=(
 SELECT id FROM public.industrial_plan_runs WHERE status='QUEUED' OR (status='RUNNING' AND updated_at<now()-interval '10 minutes')
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ${columns}`,
      [token],
    )
  ).rows[0];
  if (!claim) return false;
  try {
    await industrialTx(async (tx) => {
      const computed = await compute(tx, claim);
      await tx.query(
        `UPDATE public.industrial_plan_runs SET status='READY',result=$3,source_digest=$4,updated_at=now()
    WHERE id=$1 AND claimed=$2 AND status='RUNNING'`,
        [claim.id, token, JSON.stringify(computed.result), computed.digest],
      );
    }, "REPEATABLE READ");
  } catch (err) {
    const message =
      err instanceof HttpError
        ? err.message
        : err instanceof Error &&
            [
              "Cycle dans la nomenclature applicable.",
              "Nomenclature incomplète ou coefficient invalide.",
            ].includes(err.message)
          ? err.message
          : "Calcul industriel interrompu. Consultez le journal du service.";
    logger.error("industrial_run_failed", {
      run_id: claim.id,
      failure_code:
        err instanceof HttpError ? err.code : "PLAN_CALCULATION_FAILED",
    });
    await pool.query(
      "UPDATE public.industrial_plan_runs SET status='FAILED',error=$3,updated_at=now() WHERE id=$1 AND claimed=$2",
      [claim.id, token, message],
    );
  }
  return true;
}
export async function validateIndustrialRun(id: string, actor: number) {
  return industrialTx(async (tx) => {
    const row = (
      await tx.query<Run>(
        "SELECT " +
          columns +
          " FROM public.industrial_plan_runs WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "PLAN_NOT_FOUND", "Calcul introuvable.");
    if (row.status === "VALIDATED") return row;
    if (row.status !== "READY")
      throw new HttpError(409, "PLAN_NOT_READY", "Attendez la fin du calcul.");
    const { digest } = await compute(tx, row);
    if (digest !== row.source_digest)
      throw new HttpError(
        409,
        "PLAN_STALE",
        "Le carnet, les stocks, les règles ou la capacité ont changé. Relancez le calcul.",
      );
    return (
      await tx.query(
        "UPDATE public.industrial_plan_runs SET status='VALIDATED',validated_at=now(),validated_by=$2,updated_at=now() WHERE id=$1 RETURNING " +
          columns,
        [id, actor],
      )
    ).rows[0];
  }, "SERIALIZABLE");
}
export function startIndustrialPlanMaintenance() {
  let active: Promise<unknown> | null = null,
    stopped = false;
  const tick = () => {
    if (active || stopped) return;
    active = processIndustrialRun()
      .catch((e: unknown) => {
        if ((e as { code?: string }).code !== "42P01")
          logger.error("industrial_queue_failed", {
            failure_code: "QUEUE_UNAVAILABLE",
          });
      })
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, 2500);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
