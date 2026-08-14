import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: { query: vi.fn() },
  findByIdempotency: vi.fn(),
  lockCreation: vi.fn(),
  findOpen: vi.fn(),
  insertReview: vi.fn(),
  listCandidates: vi.fn(),
  insertItem: vi.fn(),
  getReview: vi.fn(),
  listReviews: vi.fn(),
  getReviewForUpdate: vi.fn(),
  getItemForUpdate: vi.fn(),
  recordDecision: vi.fn(),
  countPending: vi.fn(),
  closeReview: vi.fn(),
  insertAudit: vi.fn(),
}));

vi.mock("../repository/access-control.repository", () => ({
  withTransaction: vi.fn(async (fn: (tx: typeof mocks.tx) => Promise<unknown>) => fn(mocks.tx)),
}));

vi.mock("../repository/access-review.repository", () => ({
  repoLockReviewCreation: mocks.lockCreation,
  repoFindReviewByIdempotency: mocks.findByIdempotency,
  repoFindOpenReview: mocks.findOpen,
  repoInsertReview: mocks.insertReview,
  repoListReviewCandidates: mocks.listCandidates,
  repoInsertReviewItem: mocks.insertItem,
  repoGetReview: mocks.getReview,
  repoListReviews: mocks.listReviews,
  repoGetReviewForUpdate: mocks.getReviewForUpdate,
  repoGetReviewItemForUpdate: mocks.getItemForUpdate,
  repoRecordReviewDecision: mocks.recordDecision,
  repoCountPendingReviewItems: mocks.countPending,
  repoCloseReview: mocks.closeReview,
}));

vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAudit,
}));

import {
  assessAccessReviewCandidate,
  createAccessReview,
  decideAccessReviewItem,
} from "./access-review.service";

const audit = {
  user_id: 4,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/admin/access/reviews",
  client_session_id: null,
};

const riskyCandidate = {
  user_id: 9,
  username: "OLD.ADMIN",
  status: "Active",
  roles: ["Directeur"],
  is_superadmin: false,
  last_activity_at: "2025-01-01T00:00:00.000Z",
  failed_login_count: 7,
  last_failed_login_at: "2026-08-14T08:00:00.000Z",
  exceptional_module_keys: ["stock"],
  inactive: true,
};

const review = {
  id: "11111111-1111-4111-8111-111111111111",
  period_start: "2026-07-15T00:00:00.000Z",
  period_end: "2026-08-14T00:00:00.000Z",
  status: "OPEN" as const,
  inactivity_days: 90,
  login_failure_window_days: 30,
  failed_login_threshold: 5,
  due_at: "2026-08-28T00:00:00.000Z",
  created_by: 4,
  created_at: "2026-08-14T00:00:00.000Z",
  closed_by: null,
  closed_at: null,
  items: [],
  summary: {
    total: 0,
    pending: 0,
    high_risk: 0,
    medium_risk: 0,
    privileged: 0,
    inactive: 0,
    failed_login_bursts: 0,
    exceptional_access: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdempotency.mockResolvedValue(null);
  mocks.findOpen.mockResolvedValue(null);
  mocks.listCandidates.mockResolvedValue([riskyCandidate]);
  mocks.getReview.mockResolvedValue(review);
  mocks.insertAudit.mockResolvedValue({ id: "audit-1", created_at: "2026-08-14T00:00:00Z" });
});

describe("SOL-25 access review", () => {
  it("classifies privileged inactive accounts with repeated failures as high risk", () => {
    expect(assessAccessReviewCandidate(riskyCandidate, 5)).toEqual({
      reasons: ["PRIVILEGED", "INACTIVE", "FAILED_LOGIN_BURST", "EXCEPTIONAL_ACCESS"],
      level: "HIGH",
    });
  });

  it("snapshots every account and audits without changing account state", async () => {
    const result = await createAccessReview({
      inactivity_days: 90,
      login_failure_window_days: 30,
      failed_login_threshold: 5,
      due_in_days: 14,
      raw_idempotency_key: "review-2026-q3",
      audit,
    });

    expect(result).toEqual({ review, replayed: false });
    expect(mocks.insertReview).toHaveBeenCalledOnce();
    expect(mocks.insertItem).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        candidate: riskyCandidate,
        risk_level: "HIGH",
      })
    );
    expect(mocks.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ action: "ACCESS_REVIEW_CREATED" }),
      tx: mocks.tx,
    }));
  });

  it("replays the same creation key and rejects a different payload", async () => {
    await createAccessReview({
      inactivity_days: 90,
      login_failure_window_days: 30,
      failed_login_threshold: 5,
      due_in_days: 14,
      raw_idempotency_key: "review-2026-q3",
      audit,
    });
    const inserted = mocks.insertReview.mock.calls[0]?.[1];
    mocks.findByIdempotency.mockResolvedValue({ ...review, request_hash: inserted.request_hash });

    const replay = await createAccessReview({
      inactivity_days: 90,
      login_failure_window_days: 30,
      failed_login_threshold: 5,
      due_in_days: 14,
      raw_idempotency_key: "review-2026-q3",
      audit,
    });
    expect(replay.replayed).toBe(true);
    expect(mocks.insertReview).toHaveBeenCalledTimes(1);

    await expect(createAccessReview({
      inactivity_days: 120,
      login_failure_window_days: 30,
      failed_login_threshold: 5,
      due_in_days: 14,
      raw_idempotency_key: "review-2026-q3",
      audit,
    })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("records one audited human decision and replays an identical retry", async () => {
    mocks.getReviewForUpdate.mockResolvedValue({ ...review, request_hash: "x" });
    mocks.getItemForUpdate.mockResolvedValue({
      review_id: review.id,
      user_id: 9,
      decision: null,
      decision_idempotency_key: null,
      decision_request_hash: null,
    });

    const first = await decideAccessReviewItem({
      review_id: review.id,
      user_id: 9,
      decision: "CHANGE_REQUIRED",
      rationale: "Retirer l’accès stock avant le 20 août.",
      raw_idempotency_key: "decision-review-user-9",
      audit,
    });
    expect(first.replayed).toBe(false);
    const recorded = mocks.recordDecision.mock.calls[0]?.[1];
    expect(recorded).toMatchObject({ user_id: 9, decision: "CHANGE_REQUIRED" });
    expect(mocks.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ action: "ACCESS_REVIEW_DECISION_RECORDED" }),
    }));

    mocks.getItemForUpdate.mockResolvedValue({
      review_id: review.id,
      user_id: 9,
      decision: "CHANGE_REQUIRED",
      decision_idempotency_key: recorded.idempotency_key,
      decision_request_hash: recorded.request_hash,
    });
    const replay = await decideAccessReviewItem({
      review_id: review.id,
      user_id: 9,
      decision: "CHANGE_REQUIRED",
      rationale: "Retirer l’accès stock avant le 20 août.",
      raw_idempotency_key: "decision-review-user-9",
      audit,
    });
    expect(replay.replayed).toBe(true);
    expect(mocks.recordDecision).toHaveBeenCalledTimes(1);
  });
});
