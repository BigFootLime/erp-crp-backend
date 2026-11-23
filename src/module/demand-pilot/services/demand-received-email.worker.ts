import pool from "../../../config/database";
import { sendTransactionalEmail } from "../../../shared/email/resend.service";

const SUBJECT = "Nouvelles échéances client à examiner dans CERP";

export function demandReceivedEmailEnabled() {
  return process.env.CERP_CLIENT_DEMAND_EMAILS === "1"
    && Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim());
}

type PendingEmail = {
  notification_id: string;
  attempts: number;
  email: string | null;
  message: string;
};

export async function processDemandReceivedEmail() {
  if (!demandReceivedEmailEnabled()) return false;
  // A two-minute lease is longer than the bounded provider call. The stable
  // provider key also covers a worker restart after sending and before recording it.
  const { rows: [job] } = await pool.query<PendingEmail>(
    `WITH expired AS (
       UPDATE public.client_demand_notification_emails
       SET status='FAILED', updated_at=now()
       WHERE status='PROCESSING' AND attempts=5 AND next_attempt<=now()
     ), due AS (
       SELECT q.notification_id
       FROM public.client_demand_notification_emails q
       WHERE q.status IN ('PENDING','RETRY','PROCESSING') AND q.next_attempt<=now() AND q.attempts<5
       ORDER BY q.next_attempt, q.notification_id LIMIT 1 FOR UPDATE SKIP LOCKED
     ), claim AS (
       UPDATE public.client_demand_notification_emails q
       SET status='PROCESSING', attempts=q.attempts+1,
           next_attempt=now()+interval '2 minutes', updated_at=now()
       FROM due WHERE q.notification_id=due.notification_id
       RETURNING q.notification_id,q.attempts
     )
     SELECT claim.*, n.message, u.email
     FROM claim JOIN public.app_notifications n ON n.id=claim.notification_id
     LEFT JOIN public.users u ON u.id=n.user_id
       AND coalesce(nullif(lower(btrim(u.status)), ''), 'active')
           NOT IN ('inactive','blocked','suspended')`,
  );
  if (!job) return false;

  const email = job.email?.trim();
  if (!email || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)) {
    await finishEmail(job, "SKIPPED");
    return true;
  }
  const text = job.message + "\n\nOuvrez CERP, puis cliquez sur votre notification pour examiner le relevé.";
  const html = "<p>" + text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\n\n/g, "</p><p>") + "</p>";
  const delivery = await sendTransactionalEmail({
    to: [email], subject: SUBJECT, text, html,
    idempotencyKey: "client-demand-notification:" + job.notification_id,
    timeoutMs: 12_000,
  }).catch(() => null);
  if (delivery?.ok) await finishEmail(job, "SENT", delivery.id ?? null);
  else await finishEmail(job, job.attempts >= 5 ? "FAILED" : "RETRY");
  return true;
}

async function finishEmail(job: PendingEmail, status: "SENT" | "FAILED" | "RETRY" | "SKIPPED", providerId: string | null = null) {
  await pool.query(
    `UPDATE public.client_demand_notification_emails
     SET status=$2, provider_id=$3, next_attempt=now()+interval '3 minutes', updated_at=now()
     WHERE notification_id=$1 AND status='PROCESSING' AND attempts=$4`,
    [job.notification_id, status, providerId, job.attempts],
  );
}
