import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { decideDemand } from "../repository/demand-pilot.repository";

/** Customer agreement resumes the exact CRP proposal; the ERP checks it again before booking. */
export async function processAgreedCounterOffer() {
  const c = (
    await pool.query<{
      id: string;
      revision_id: string;
      revision_no: number;
      client_id: string;
      due_date: string;
      actor_id: number;
    }>(
      `SELECT o.id,o.revision_id,r.revision_no,r.client_id,o.due_date::text,o.actor_id
   FROM public.demand_counter_offers o JOIN public.demand_pilot_revisions r ON r.id=o.revision_id WHERE o.status='AGREED'
   ORDER BY o.answered_at,o.id LIMIT 1`,
    )
  ).rows[0];
  if (!c) return false;
  try {
    await decideDemand({
      clientId: c.client_id,
      id: c.revision_id,
      expectedVersion: c.revision_no,
      action: "ACCEPT",
      confirmedNeedDate: c.due_date,
      actor: { userId: c.actor_id },
      reason: "Contre-proposition CRP acceptée par le client",
      idempotencyKey: c.id,
    });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await pool.query(
      "UPDATE public.demand_pilot_revisions SET decision_reason=$2 WHERE id=$1 AND status='REVIEW'",
      [c.revision_id, e.message],
    );
  }
  await pool.query(
    "UPDATE public.demand_counter_offers SET status='CHECKED' WHERE id=$1 AND status='AGREED'",
    [c.id],
  );
  return true;
}
