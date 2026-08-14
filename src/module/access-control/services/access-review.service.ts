import crypto from "node:crypto";
import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { withTransaction } from "../repository/access-control.repository";
import * as repo from "../repository/access-review.repository";
import type { AccessAuditContext } from "../types/access-control.types";
import type {
  AccessReviewCandidate,
  AccessReviewDecision,
  AccessReviewRiskLevel,
  AccessReviewRiskReason,
} from "../types/access-review.types";

const PRIVILEGED_ROLE_KEYS = new Set(["Administrateur Systeme et Reseau", "Directeur"]);

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function idempotencyKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (key.length < 8 || key.length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une clé Idempotency-Key stable de 8 à 200 caractères est requise.");
  }
  return key;
}

function isBlocked(status: string | null): boolean {
  return ["blocked", "suspended", "inactive"].includes((status ?? "").trim().toLowerCase());
}

export function assessAccessReviewCandidate(
  candidate: AccessReviewCandidate,
  failedLoginThreshold: number
): { reasons: AccessReviewRiskReason[]; level: AccessReviewRiskLevel } {
  const privileged = candidate.is_superadmin || candidate.roles.some((role) => PRIVILEGED_ROLE_KEYS.has(role));
  const failedBurst = candidate.failed_login_count >= failedLoginThreshold;
  const blocked = isBlocked(candidate.status);
  const reasons: AccessReviewRiskReason[] = [];
  if (privileged) reasons.push("PRIVILEGED");
  if (candidate.inactive) reasons.push("INACTIVE");
  if (blocked) reasons.push("BLOCKED");
  if (failedBurst) reasons.push("FAILED_LOGIN_BURST");
  if (candidate.exceptional_module_keys.length > 0) reasons.push("EXCEPTIONAL_ACCESS");

  const level: AccessReviewRiskLevel =
    blocked || failedBurst || (privileged && candidate.inactive)
      ? "HIGH"
      : reasons.length > 0
        ? "MEDIUM"
        : "LOW";
  return { reasons, level };
}

async function audit(
  tx: PoolClient,
  context: AccessAuditContext,
  action: string,
  entityId: string,
  details: Record<string, unknown>
) {
  await repoInsertAuditLog({
    user_id: context.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: "administration-acces",
      entity_type: "access_review",
      entity_id: entityId,
      path: context.path,
      client_session_id: context.client_session_id,
      details,
    },
    ip: context.ip,
    user_agent: context.user_agent,
    device_type: context.device_type,
    os: context.os,
    browser: context.browser,
    tx,
  });
}

export async function createAccessReview(params: {
  inactivity_days: number;
  login_failure_window_days: number;
  failed_login_threshold: number;
  due_in_days: number;
  raw_idempotency_key: string | undefined;
  audit: AccessAuditContext;
}) {
  const key = idempotencyKey(params.raw_idempotency_key);
  const requestHash = stableHash({
    inactivity_days: params.inactivity_days,
    login_failure_window_days: params.login_failure_window_days,
    failed_login_threshold: params.failed_login_threshold,
    due_in_days: params.due_in_days,
  });

  return withTransaction(async (tx) => {
    await repo.repoLockReviewCreation(tx);
    const replay = await repo.repoFindReviewByIdempotency(tx, params.audit.user_id, key);
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d’idempotence a déjà servi pour une autre revue.");
      }
      return { review: await repo.repoGetReview(replay.id, tx), replayed: true };
    }

    const alreadyOpen = await repo.repoFindOpenReview(tx);
    if (alreadyOpen) {
      throw new HttpError(409, "ACCESS_REVIEW_ALREADY_OPEN", "Une revue d’accès est déjà ouverte. Terminez-la avant d’en créer une nouvelle.");
    }

    const now = new Date();
    const reviewId = crypto.randomUUID();
    const periodEnd = now.toISOString();
    const periodStart = new Date(now.getTime() - params.login_failure_window_days * 86_400_000).toISOString();
    const inactivityCutoff = new Date(now.getTime() - params.inactivity_days * 86_400_000).toISOString();
    const dueAt = new Date(now.getTime() + params.due_in_days * 86_400_000).toISOString();

    await repo.repoInsertReview(tx, {
      id: reviewId,
      period_start: periodStart,
      period_end: periodEnd,
      inactivity_days: params.inactivity_days,
      login_failure_window_days: params.login_failure_window_days,
      failed_login_threshold: params.failed_login_threshold,
      due_at: dueAt,
      created_by: params.audit.user_id,
      idempotency_key: key,
      request_hash: requestHash,
    });
    const candidates = await repo.repoListReviewCandidates(tx, {
      inactivity_cutoff: inactivityCutoff,
      login_failure_cutoff: periodStart,
    });
    for (const candidate of candidates) {
      const risk = assessAccessReviewCandidate(candidate, params.failed_login_threshold);
      await repo.repoInsertReviewItem(tx, {
        review_id: reviewId,
        candidate,
        risk_reasons: risk.reasons,
        risk_level: risk.level,
      });
    }
    await audit(tx, params.audit, "ACCESS_REVIEW_CREATED", reviewId, {
      account_count: candidates.length,
      inactivity_days: params.inactivity_days,
      login_failure_window_days: params.login_failure_window_days,
      failed_login_threshold: params.failed_login_threshold,
      due_at: dueAt,
    });
    return { review: await repo.repoGetReview(reviewId, tx), replayed: false };
  });
}

export async function listAccessReviews(limit: number) {
  return { items: await repo.repoListReviews(limit) };
}

export async function getAccessReview(reviewId: string) {
  const review = await repo.repoGetReview(reviewId);
  if (!review) throw new HttpError(404, "ACCESS_REVIEW_NOT_FOUND", "Revue d’accès introuvable.");
  return review;
}

export async function decideAccessReviewItem(params: {
  review_id: string;
  user_id: number;
  decision: AccessReviewDecision;
  rationale: string | null;
  raw_idempotency_key: string | undefined;
  audit: AccessAuditContext;
}) {
  const key = idempotencyKey(params.raw_idempotency_key);
  const rationale = params.rationale?.trim() || null;
  const requestHash = stableHash({ decision: params.decision, rationale });

  return withTransaction(async (tx) => {
    const review = await repo.repoGetReviewForUpdate(tx, params.review_id);
    if (!review) throw new HttpError(404, "ACCESS_REVIEW_NOT_FOUND", "Revue d’accès introuvable.");
    if (review.status !== "OPEN") {
      throw new HttpError(409, "ACCESS_REVIEW_CLOSED", "Cette revue est clôturée et ne peut plus être modifiée.");
    }
    const item = await repo.repoGetReviewItemForUpdate(tx, params.review_id, params.user_id);
    if (!item) throw new HttpError(404, "ACCESS_REVIEW_ITEM_NOT_FOUND", "Compte absent de cette revue.");
    if (item.decision !== null) {
      if (item.decision_idempotency_key === key && item.decision_request_hash === requestHash) {
        return { review: await repo.repoGetReview(params.review_id, tx), replayed: true };
      }
      throw new HttpError(409, "ACCESS_REVIEW_DECISION_ALREADY_RECORDED", "Une décision est déjà enregistrée pour ce compte.");
    }

    await repo.repoRecordReviewDecision(tx, {
      review_id: params.review_id,
      user_id: params.user_id,
      decision: params.decision,
      rationale,
      decided_by: params.audit.user_id,
      idempotency_key: key,
      request_hash: requestHash,
    });
    await audit(tx, params.audit, "ACCESS_REVIEW_DECISION_RECORDED", params.review_id, {
      reviewed_user_id: params.user_id,
      decision: params.decision,
      rationale_present: rationale !== null,
    });
    return { review: await repo.repoGetReview(params.review_id, tx), replayed: false };
  });
}

export async function closeAccessReview(params: {
  review_id: string;
  audit: AccessAuditContext;
}) {
  return withTransaction(async (tx) => {
    const review = await repo.repoGetReviewForUpdate(tx, params.review_id);
    if (!review) throw new HttpError(404, "ACCESS_REVIEW_NOT_FOUND", "Revue d’accès introuvable.");
    if (review.status === "CLOSED") return { review: await repo.repoGetReview(params.review_id, tx), replayed: true };
    const pending = await repo.repoCountPendingReviewItems(tx, params.review_id);
    if (pending > 0) {
      throw new HttpError(409, "ACCESS_REVIEW_PENDING_DECISIONS", `${pending} décision(s) restent à enregistrer avant la clôture.`);
    }
    await repo.repoCloseReview(tx, { review_id: params.review_id, closed_by: params.audit.user_id });
    await audit(tx, params.audit, "ACCESS_REVIEW_CLOSED", params.review_id, { account_count_pending: 0 });
    return { review: await repo.repoGetReview(params.review_id, tx), replayed: false };
  });
}
