import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { logger } from "../../../shared/observability/logger";
import { decideDemand } from "../repository/demand-pilot.repository";
import { recoverDemandMaterializations } from "./demand-pilot-materialization.service";
import { processDemandAcknowledgement } from "./demand-ar.worker";
import { processAgreedCounterOffer } from "./demand-counter.worker";

/** The original enabling user is recorded by the policy, never inferred from an external login. */
export async function processAutomaticDemand() {
  type Candidate = {
    revision_id: string;
    client_id: string;
    revision_no: number;
    actor_id: number;
    idempotency_key: string;
    attempts: number;
  };
  const claim = (
    await pool.query<Candidate>(`WITH candidate AS (
  SELECT d.id,d.client_id,d.revision_no,p.updated_by AS actor_id,p.version
  FROM public.demand_pilot_revisions d JOIN public.industrial_policies p ON p.client_id=d.client_id AND p.auto_enabled
  LEFT JOIN public.demand_pilot_auto_checks ck ON ck.revision_id=d.id
  WHERE d.status='PENDING' AND d.diff_type<>'REMOVED'
    AND (ck.revision_id IS NULL OR (ck.status IN('PROCESSING','RETRY') AND ck.next_attempt<=now()))
    AND NOT EXISTS(SELECT 1 FROM public.demand_pilot_revisions n WHERE (n.client_id,n.external_site,n.external_order_key,n.external_line_key,n.external_schedule_key)
      =(d.client_id,d.external_site,d.external_order_key,d.external_line_key,d.external_schedule_key) AND n.revision_no>d.revision_no)
  ORDER BY d.created_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED
 ), job AS(
  INSERT INTO public.demand_pilot_auto_checks(revision_id,policy_version,actor_id,status,next_attempt)
  SELECT id,version,actor_id,'PROCESSING',now()+interval '2 minutes' FROM candidate
  ON CONFLICT(revision_id) DO UPDATE SET attempts=demand_pilot_auto_checks.attempts+1,status='PROCESSING',actor_id=excluded.actor_id,
   policy_version=excluded.policy_version,next_attempt=excluded.next_attempt
  WHERE demand_pilot_auto_checks.next_attempt<=now() AND demand_pilot_auto_checks.status IN('PROCESSING','RETRY')
  RETURNING revision_id,actor_id,idempotency_key,attempts)
  SELECT job.*,candidate.client_id,candidate.revision_no FROM job JOIN candidate ON candidate.id=job.revision_id`)
  ).rows[0];
  if (!claim) return false;
  try {
    const result = await decideDemand({
      clientId: claim.client_id,
      id: claim.revision_id,
      expectedVersion: claim.revision_no,
      action: "ACCEPT",
      automatic: true,
      reason: "Politique CRP : décision automatique",
      actor: { userId: claim.actor_id },
      idempotencyKey: claim.idempotency_key,
    });
    const review = result.data.status === "REVIEW";
    await pool.query(
      "UPDATE public.demand_pilot_auto_checks SET status=$2,reason=$3 WHERE revision_id=$1",
      [
        claim.revision_id,
        review ? "REVIEW" : "DECIDED",
        result.data.decision_reason ?? null,
      ],
    );
  } catch (e) {
    const review =
      (e instanceof HttpError && e.status < 500) || claim.attempts >= 3;
    const reason =
      e instanceof HttpError
        ? e.message
        : "Erreur de traitement. Relancer ou examiner la demande.";
    await pool.query(
      "UPDATE public.demand_pilot_auto_checks SET status=$2,reason=$3,next_attempt=now()+interval '2 minutes' WHERE revision_id=$1",
      [claim.revision_id, review ? "REVIEW" : "RETRY", reason],
    );
    // Only transport/technical errors are retried. Human decisions or superseding imports win.
    if (review)
      await pool.query(
        "UPDATE public.demand_pilot_revisions SET status='REVIEW',decision_reason=$2 WHERE id=$1 AND status='PENDING'",
        [claim.revision_id, reason],
      );
  }
  return true;
}
export function startDemandAutomation() {
  let active: Promise<unknown> | null = null,
    stopped = false;
  const tick = () => {
    if (stopped || active) return;
    active = recoverDemandMaterializations(10)
      .then(() => processAgreedCounterOffer())
      .then(() => processAutomaticDemand())
      .then(() => processDemandAcknowledgement())
      .catch((e) => {
        if (e?.code !== "42P01")
          logger.error("demand_automation_failed", {
            failure_code: "DECISION_QUEUE",
          });
      })
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, 3000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
