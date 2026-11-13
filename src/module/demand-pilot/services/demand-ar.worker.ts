import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  svcGenerateCommandeAr,
  svcSendCommandeAr,
} from "../../commande-client/services/commande-ar.service";
import {
  buildCommandeArContentSnapshot,
  isCommandeArSnapshotCurrent,
} from "../../commande-client/domain/commande-ar-fingerprint";
import { repoLoadCommandeArGenerationData } from "../../commande-client/repository/commande-ar.repository";
import { sendCommandeArSchema } from "../../commande-client/validators/commande-ar.validators";

type Job = {
  revision_id: string;
  commande_id: string;
  actor_id: number;
  idempotency_key: string;
  ar_id: string | null;
  attempts: number;
};
export async function processDemandAcknowledgement() {
  const db = await pool.connect();
  let job: Job | undefined;
  try {
    job = (
      await db.query<Job>(`UPDATE public.demand_acknowledgement_jobs j SET status='PROCESSING',attempts=attempts+1,updated_at=now(),next_attempt=now()+interval '10 minutes'
   WHERE revision_id=(SELECT revision_id FROM public.demand_acknowledgement_jobs WHERE status IN ('PENDING','RETRY','PROCESSING')
    AND next_attempt<=now() ORDER BY updated_at,revision_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING revision_id,commande_id,actor_id,idempotency_key,ar_id,attempts`)
    ).rows[0];
    if (!job) return false;
    // Serialize different schedule revisions of the same commercial order across service instances.
    await db.query(
      "SELECT pg_advisory_lock(hashtextextended('demand-ar:'||$1::text,0))",
      [job.commande_id],
    );
    const source = await repoLoadCommandeArGenerationData(
      db,
      Number(job.commande_id),
    );
    if (!source)
      throw new HttpError(409, "ORDER_NOT_FOUND", "Commande absente.");
    const actor = (
      await db.query<{ role: string }>(
        "SELECT role FROM public.users WHERE id=$1 AND lower(status) IN ('active','actif')",
        [job.actor_id],
      )
    ).rows[0];
    if (!actor)
      throw new HttpError(
        409,
        "AR_ACTOR_INACTIVE",
        "Habilitation ADV à renouveler.",
      );
    const snapshot = buildCommandeArContentSnapshot(source);
    const previous = (
      await db.query<{
        id: string;
        status: string;
        content_snapshot: unknown;
        content_fingerprint: string | null;
      }>(
        `SELECT id,status,content_snapshot,content_fingerprint FROM public.commande_ar_log
   WHERE commande_id=$1 ORDER BY generated_at DESC,id DESC LIMIT 1`,
        [job.commande_id],
      )
    ).rows[0];
    const same =
      previous &&
      isCommandeArSnapshotCurrent({
        storedSnapshot: previous.content_snapshot,
        storedFingerprint: previous.content_fingerprint,
        currentSnapshot: snapshot,
      });
    if (same && previous.status === "SENT") {
      await db.query(
        "UPDATE public.demand_acknowledgement_jobs SET status='UNCHANGED',ar_id=$2,updated_at=now() WHERE revision_id=$1",
        [job.revision_id, previous.id],
      );
      return true;
    }
    // Use the established immutable archive, PDF renderer and send claim; never reconstruct an AR in the demand module.
    const existingId =
      same && previous.status !== "FAILED" ? previous.id : null;
    const id =
      existingId ??
      (
        await svcGenerateCommandeAr({
          commande_id: Number(job.commande_id),
          user_id: job.actor_id,
          user_role: actor.role,
          reissue_reason: "Modification acceptée de l’échéancier client",
          idempotency_key: job.idempotency_key,
        })
      ).ar_id;
    await db.query(
      "UPDATE public.demand_acknowledgement_jobs SET ar_id=$2 WHERE revision_id=$1",
      [job.revision_id, id],
    );
    const recipient = (
      await db.query<{ contact_id: string; email: string }>(
        `SELECT ct.contact_id,ct.email FROM public.industrial_policies p
   JOIN public.contacts ct ON ct.contact_id=p.auto_ar_contact_id AND ct.client_id=p.client_id
   WHERE p.client_id=$1 AND p.auto_enabled AND ct.email IS NOT NULL`,
        [source.header.client_id],
      )
    ).rows[0];
    if (!recipient) {
      await db.query(
        "UPDATE public.demand_acknowledgement_jobs SET status='READY',updated_at=now(),reason='AR prêt pour la diffusion ADV.' WHERE revision_id=$1",
        [job.revision_id],
      );
      return true;
    }
    const body = sendCommandeArSchema.shape.body.parse({
      ar_id: id,
      recipient_emails: [recipient.email],
      recipient_contact_ids: [recipient.contact_id],
      idempotency_key: job.idempotency_key,
    });
    await svcSendCommandeAr({
      commande_id: Number(job.commande_id),
      user_id: job.actor_id,
      user_role: actor.role,
      body,
    });
    await db.query(
      "UPDATE public.demand_acknowledgement_jobs SET status='SENT',reason=NULL,updated_at=now() WHERE revision_id=$1",
      [job.revision_id],
    );
    return true;
  } catch (err) {
    if (!job) throw err;
    const retry =
      job.attempts < 3 && (!(err instanceof HttpError) || err.status >= 500);
    const message =
      err instanceof HttpError
        ? err.message
        : "Génération ou diffusion à contrôler. La tentative conserve sa clé de reprise.";
    await db.query(
      "UPDATE public.demand_acknowledgement_jobs SET status=$2,reason=$3,updated_at=now(),next_attempt=now()+interval '5 minutes' WHERE revision_id=$1",
      [job.revision_id, retry ? "RETRY" : "REVIEW", message],
    );
    return true;
  } finally {
    try {
      if (job)
        await db.query(
          "SELECT pg_advisory_unlock(hashtextextended('demand-ar:'||$1::text,0))",
          [job.commande_id],
        );
    } finally {
      db.release();
    }
  }
}
