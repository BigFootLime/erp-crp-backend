import { afterAll, beforeAll, describe, expect, it } from "vitest";

import db from "../config/database";
import {
  repoApplyReferenceChangeSet,
  repoCreateReferenceChangeSet,
  repoDecideReferenceChangeSet,
} from "../module/reference-data/repository/reference-data.repository";
import type { ReferenceDataAuditContext } from "../module/reference-data/types/reference-data.types";

const enabled = process.env.CERP_E2E_ISOLATED === "1" && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

function audit(userId: number, role: string): ReferenceDataAuditContext {
  return {
    user_id: userId, role, ip: "127.0.0.1", user_agent: "vitest-sol33", device_type: "desktop",
    os: "test", browser: "test", path: "/api/v1/admin/reference-data", page_key: "reference-data",
    client_session_id: null,
  };
}

suite("SOL-33 isolated repository workflow", () => {
  let proposerId = 0;
  let approverId = 0;
  let originalMethod = "WEIGHTED_AVERAGE";
  const effectiveFrom = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    const users = await db.query<{ id: number; username: string }>(
      `SELECT id, username FROM public.users WHERE username=ANY($1::text[])`, [["KEENAN", "E2E_PURCHASING"]]
    );
    proposerId = users.rows.find((row) => row.username === "KEENAN")?.id ?? 0;
    approverId = users.rows.find((row) => row.username === "E2E_PURCHASING")?.id ?? 0;
    const setting = await db.query<{ method: string }>(
      `SELECT COALESCE(value_text,value_json->>'method') AS method FROM public.erp_settings WHERE key='stock.valuation_method'`
    );
    originalMethod = setting.rows[0]?.method ?? "WEIGHTED_AVERAGE";
    expect(proposerId).toBeGreaterThan(0);
    expect(approverId).toBeGreaterThan(0);
  });

  afterAll(async () => { await db.end(); });

  it("replays proposals idempotently, enforces four eyes, then applies an immutable version", async () => {
    const nextMethod = originalMethod === "FIFO" ? "WEIGHTED_AVERAGE" : "FIFO";
    const input = {
      idempotency_key: `sol33-propose-${Date.now()}`,
      effective_from: effectiveFrom,
      effective_to: null,
      reason: "Test isolé de gouvernance de la valorisation",
      source: "Fixture d'intégration SOL-33",
      reliability: "VERIFIED" as const,
      changes: [{
        dataset_code: "STOCK_VALUATION" as const,
        record_key: "stock.valuation_method" as const,
        value: { method: nextMethod as "FIFO" | "WEIGHTED_AVERAGE" },
      }],
    };
    const first = await repoCreateReferenceChangeSet(input, audit(proposerId, "Administrateur Systeme et Reseau"));
    const replay = await repoCreateReferenceChangeSet(input, audit(proposerId, "Administrateur Systeme et Reseau"));
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, change_set: { id: first.change_set.id } });

    await expect(repoDecideReferenceChangeSet(first.change_set.id, {
      idempotency_key: `sol33-self-${Date.now()}`, decision: "APPROVE", reason: "Auto-approbation interdite",
    }, audit(proposerId, "Administrateur Systeme et Reseau"))).rejects.toMatchObject({
      status: 403, code: "FOUR_EYES_APPROVAL_REQUIRED",
    });

    const approved = await repoDecideReferenceChangeSet(first.change_set.id, {
      idempotency_key: `sol33-approve-${Date.now()}`, decision: "APPROVE", reason: "Source et impact vérifiés",
    }, audit(approverId, "Directeur"));
    expect(approved.change_set.status).toBe("APPROVED");

    const applied = await repoApplyReferenceChangeSet(
      first.change_set.id, `sol33-apply-${Date.now()}`, audit(approverId, "Directeur")
    );
    expect(applied.change_set.status).toBe("APPLIED");
    const proof = await db.query<{ method: string; versions: string }>(
      `SELECT COALESCE(s.value_text,s.value_json->>'method') AS method,
              (SELECT count(*)::text FROM public.reference_data_versions v
                WHERE v.change_set_id=$1::uuid AND v.dataset_code='STOCK_VALUATION') AS versions
         FROM public.erp_settings s WHERE s.key='stock.valuation_method'`, [first.change_set.id]
    );
    expect(proof.rows[0]).toEqual({ method: nextMethod, versions: "1" });
  });

  it("blocks application when the canonical source changed after comparison", async () => {
    const current = await db.query<{ method: string }>(
      `SELECT COALESCE(value_text,value_json->>'method') AS method FROM public.erp_settings WHERE key='stock.valuation_method'`
    );
    const target = current.rows[0]?.method === "FIFO" ? "WEIGHTED_AVERAGE" : "FIFO";
    const proposed = await repoCreateReferenceChangeSet({
      idempotency_key: `sol33-stale-propose-${Date.now()}`,
      effective_from: effectiveFrom,
      effective_to: null,
      reason: "Test isolé de concurrence optimiste",
      source: "Fixture d'intégration SOL-33",
      reliability: "VERIFIED",
      changes: [{ dataset_code: "STOCK_VALUATION", record_key: "stock.valuation_method", value: { method: target } }],
    }, audit(proposerId, "Administrateur Systeme et Reseau"));
    await repoDecideReferenceChangeSet(proposed.change_set.id, {
      idempotency_key: `sol33-stale-approve-${Date.now()}`, decision: "APPROVE", reason: "Proposition vérifiée avant concurrence",
    }, audit(approverId, "Directeur"));

    await db.query(`UPDATE public.erp_settings SET value_text='SPECIFIC_IDENTIFICATION',updated_at=now() WHERE key='stock.valuation_method'`);
    await expect(repoApplyReferenceChangeSet(
      proposed.change_set.id, `sol33-stale-apply-${Date.now()}`, audit(approverId, "Directeur")
    )).rejects.toMatchObject({ status: 409, code: "REFERENCE_SNAPSHOT_STALE" });
  });

  it("rejects an unknown canonical unit before creating an approval request", async () => {
    await expect(repoCreateReferenceChangeSet({
      idempotency_key: `sol33-unit-${Date.now()}`,
      effective_from: effectiveFrom,
      effective_to: null,
      reason: "Test isolé de dépendance unité canonique",
      source: "Fixture d'intégration SOL-33",
      reliability: "VERIFIED",
      changes: [{
        dataset_code: "UNIT_CONVERSIONS",
        record_key: "00000000-0000-4000-8000-000000000033",
        value: { purchase_unit: "UNIT-DOES-NOT-EXIST", stock_unit: "u", factor: 1 },
      }],
    }, audit(proposerId, "Administrateur Systeme et Reseau"))).rejects.toMatchObject({
      status: 422,
      code: "UNKNOWN_CANONICAL_UNIT",
    });
  });
});
