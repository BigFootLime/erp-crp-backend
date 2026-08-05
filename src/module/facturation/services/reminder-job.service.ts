import { HttpError } from "../../../utils/httpError";
import { dateInTimeZone, safeReminderFailure } from "../domain/reminder-policy";
import {
  repoClaimNextReminder,
  repoClaimReminderForManualSend,
  repoCompleteReminderDelivery,
  repoGenerateReminderSuggestions,
  repoGetReminderReadiness,
  type ReminderClaim,
} from "../repository/reminders.repository";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import type { ReminderCycleResult, ReminderSuggestion } from "../types/reminders.types";
import { createReminderProvider, type ReminderProvider } from "../providers/reminder.provider";

async function deliverClaim(
  claim: ReminderClaim,
  provider: ReminderProvider
): Promise<ReminderSuggestion> {
  try {
    const receipt = await provider.send(claim.message);
    return repoCompleteReminderDelivery({
      claim,
      outcome: {
        ok: true,
        provider: "sandbox",
        providerMessageId: receipt.providerMessageId,
        recipientHash: receipt.recipientHash,
      },
    });
  } catch (error) {
    const failure = safeReminderFailure(error);
    return repoCompleteReminderDelivery({ claim, outcome: { ok: false, ...failure } });
  }
}

export async function svcSendReminder(params: {
  suggestionId: string;
  expectedVersion: number;
  idempotencyKey: string;
  actor: FinanceActorContext;
  provider?: ReminderProvider;
}): Promise<Record<string, unknown>> {
  const readiness = await repoGetReminderReadiness();
  if (!readiness.ready) {
    throw new HttpError(
      409,
      "REMINDER_DELIVERY_NOT_READY",
      "La politique validée et le provider sandbox sont requis avant tout envoi."
    );
  }
  const prepared = await repoClaimReminderForManualSend({
    suggestionId: params.suggestionId,
    expectedVersion: params.expectedVersion,
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
  });
  if (prepared.terminal) return prepared.terminal;
  if (!prepared.claim) throw new HttpError(409, "REMINDER_NOT_SENDABLE", "La relance n'est pas prête.");
  const suggestion = await deliverClaim(prepared.claim, params.provider ?? createReminderProvider());
  return { suggestion, idempotent_replay: false };
}

export async function processApprovedReminderQueue(params: {
  limit: number;
  provider?: ReminderProvider;
}): Promise<{ processed: number; sent: number; retryableFailures: number; finalFailures: number }> {
  const provider = params.provider ?? createReminderProvider();
  const result = { processed: 0, sent: 0, retryableFailures: 0, finalFailures: 0 };
  for (let index = 0; index < params.limit; index += 1) {
    const prepared = await repoClaimNextReminder();
    if (!prepared.claim) break;
    const suggestion = await deliverClaim(prepared.claim, provider);
    result.processed += 1;
    if (suggestion.status === "SENT") result.sent += 1;
    else if (suggestion.status === "FAILED_RETRYABLE") result.retryableFailures += 1;
    else if (suggestion.status === "FAILED_FINAL") result.finalFailures += 1;
  }
  return result;
}

export async function runReminderCycle(params: {
  now: Date;
  limit: number;
  actor: FinanceActorContext | null;
  provider?: ReminderProvider;
}): Promise<ReminderCycleResult> {
  const readiness = await repoGetReminderReadiness();
  if (!readiness.ready || !readiness.active_policy) {
    throw new HttpError(
      409,
      "REMINDER_POLICY_NOT_VALIDATED",
      "Le cycle de relance reste bloqué tant que sa politique et son sandbox ne sont pas validés."
    );
  }
  const asOfDate = dateInTimeZone(params.now, readiness.active_policy.timezone);
  const generated = await repoGenerateReminderSuggestions({
    asOfDate,
    limit: params.limit,
    actor: params.actor,
  });
  const processed = await processApprovedReminderQueue({ limit: params.limit, provider: params.provider });
  return {
    as_of_date: asOfDate,
    generated: generated.generated,
    blocked: generated.blocked,
    cancelled: generated.cancelled,
    already_present: generated.already_present,
    processed: processed.processed,
    sent: processed.sent,
    retryable_failures: processed.retryableFailures,
    final_failures: processed.finalFailures,
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function startReminderMaintenance(environment = process.env): () => void {
  const enabled = (environment.ADV_REMINDERS_JOB_ENABLED ?? "false").trim().toLowerCase() === "true";
  if (!enabled) return () => undefined;
  const intervalMs = boundedInteger(environment.ADV_REMINDERS_JOB_INTERVAL_MS, 300_000, 60_000, 86_400_000);
  const limit = boundedInteger(environment.ADV_REMINDERS_JOB_BATCH_SIZE, 100, 1, 500);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runReminderCycle({ now: new Date(), limit, actor: null })
      .catch((error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        console.error("[adv_reminders] bounded cycle failed", {
          code: typeof code === "string" ? code : "REMINDER_CYCLE_FAILURE",
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
