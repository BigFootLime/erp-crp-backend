import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { QualityDeliveryPolicyStatus } from "../module/qualite/domain/quality-policy";
import type { QualityActor } from "../module/qualite/repository/quality-360.repository";
import { repoTransitionDeliveryPolicy, type DeliveryPolicyRow } from "../module/qualite/repository/quality-delivery-policy.repository";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../config/database", () => ({ default: { connect } }));

// Exercise the real repository against the vocabulary of the deployed CHECK.
const migration = fs.readFileSync(path.resolve("db/patches/20260813_quality_delivery_workflow_0437.sql"), "utf8");
const eventConstraint = migration.match(/quality_delivery_release_policy_event_type_0437_ck\s+CHECK \(event_type IN \(([^)]+)\)\)/)?.[1];
if (!eventConstraint) throw new Error("Delivery-policy event constraint not found");
const allowedEvents = new Set([...eventConstraint.matchAll(/'([^']+)'/g)].map((match) => match[1]));
const updatedAt = "2026-10-10T14:00:00.000Z";
const actor: QualityActor = { user_id: 17, role: "Responsable qualité", request_id: null,
  ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null,
  page_key: null, client_session_id: null };

function policy(status: QualityDeliveryPolicyStatus): DeliveryPolicyRow {
  return { id: "00000000-0000-4000-8000-000000001095", code: "DELIVERY-RELEASE", version: 1,
    label: "Fictive policy", status, justification: "Repository regression", rules: {}, rules_sha256: "rules-hash",
    signature_reference: "TEST-SIGNATURE", document_reference: "test-policy.txt", signed_by: 17, signed_at: updatedAt,
    valid_from: updatedAt, valid_to: null, submitted_by: 17, submitted_at: updatedAt,
    activated_by: null, activated_at: null, superseded_by_policy_id: null, superseded_at: null,
    revoked_by: null, revoked_at: null, revocation_reason: null, created_at: updatedAt,
    updated_at: updatedAt, created_by: 17, updated_by: 17 };
}

function database(from: QualityDeliveryPolicyStatus, auditFailure?: Error) {
  let committed = policy(from), pending = { ...committed };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === "BEGIN") pending = { ...committed };
    else if (sql === "COMMIT") committed = { ...pending };
    else if (sql === "ROLLBACK") pending = { ...committed };
    else if (sql.includes("SELECT pg_advisory_xact_lock") || sql.includes("FROM public.quality_command_receipts")) return { rows: [] };
    else if (sql.includes("SELECT id::text AS id FROM public.quality_delivery_release_policy")) return { rows: [] };
    else if (sql.includes("FROM public.quality_delivery_release_policy")) return { rows: [{ ...pending }] };
    else if (sql.includes("UPDATE public.quality_delivery_release_policy")) pending.status = values[1] as QualityDeliveryPolicyStatus;
    else if (sql.includes("INSERT INTO public.quality_delivery_release_policy_event")) {
      if (!allowedEvents.has(String(values[1]))) throw new Error("quality_delivery_release_policy_event_type_0437_ck");
      if (auditFailure) throw auditFailure;
    } else if (!sql.includes("INSERT INTO public.quality_command_receipts")) throw new Error("Unexpected SQL: " + sql);
    return { rows: [] };
  });
  const release = vi.fn();
  connect.mockResolvedValue({ query, release });
  return { query, release, committed: () => committed };
}

function transition(from: QualityDeliveryPolicyStatus, to: QualityDeliveryPolicyStatus) {
  return { id: policy(from).id, actor, idempotencyKey: "policy-regression-1095",
    body: { target_status: to, expected_updated_at: updatedAt, reason: "Documented policy transition",
      signature_reference: "TEST-SIGNATURE", document_reference: "test-policy.txt" } };
}

describe("#1095 delivery-policy transitions keep transactional audit events", () => {
  it.each([
    ["SIGNED", "ACTIVE", "ACTIVATED"],
    ["IN_REVIEW", "DRAFT", "UPDATED"],
    ["DRAFT", "IN_REVIEW", "SUBMITTED"],
    ["IN_REVIEW", "SIGNED", "SIGNED"],
    ["ACTIVE", "SUPERSEDED", "SUPERSEDED"],
    ["SIGNED", "REVOKED", "REVOKED"],
  ] as const)("commits %s → %s with event %s", async (from, to, eventType) => {
    const db = database(from);
    await expect(repoTransitionDeliveryPolicy(transition(from, to))).resolves.toMatchObject({ status: to });
    const audit = db.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.quality_delivery_release_policy_event"))!;
    expect(audit[1]?.slice(0, 5)).toEqual([policy(from).id, eventType, from, to, "Documented policy transition"]);
    expect(JSON.parse(String(audit[1]?.[5]))).toMatchObject({ status: to });
    expect(audit[1]?.[7]).toBe(actor.user_id);
    expect(db.committed().status).toBe(to);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rolls back activation if its audit cannot be persisted", async () => {
    const failure = new Error("Audit unavailable"), db = database("SIGNED", failure);
    await expect(repoTransitionDeliveryPolicy(transition("SIGNED", "ACTIVE"))).rejects.toBe(failure);
    expect(db.committed().status).toBe("SIGNED");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.quality_command_receipts"))).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("still refuses unsigned activation before any update or audit", async () => {
    const db = database("DRAFT");
    await expect(repoTransitionDeliveryPolicy(transition("DRAFT", "ACTIVE"))).rejects.toMatchObject({ code: "QUALITY_DELIVERY_POLICY_TRANSITION_FORBIDDEN" });
    expect(db.committed().status).toBe("DRAFT");
    expect(db.query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT)\b/.test(sql))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});
