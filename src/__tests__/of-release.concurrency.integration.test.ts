import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const integrationUrl = process.env.OF_RELEASE_TEST_DATABASE_URL;

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString() })),
  enqueue: vi.fn(async () => undefined),
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.audit,
}));
vi.mock("../module/production/repository/production-realtime.repository", () => ({
  enqueueProductionOfChanged: mocks.enqueue,
  productionRealtimeActionFromAudit: vi.fn(() => "status_changed"),
}));

const suite = integrationUrl ? describe : describe.skip;

suite("#617 PostgreSQL OF release serialization", () => {
  let pool: import("pg").Pool;
  let repository: typeof import("../module/production/repository/production.repository");
  const audit = { user_id: 1, user_role: "Directeur", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/api/v1/production/ofs/1/release", page_key: "production", client_session_id: null };

  beforeAll(async () => {
    process.env.DATABASE_URL = integrationUrl;
    const pg = await import("pg");
    const bootstrap = new pg.Client({ connectionString: integrationUrl });
    await bootstrap.connect();
    const database = await bootstrap.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) throw new Error("OF_RELEASE_TEST_DATABASE_URL must target an explicitly named test/local/sandbox database");
    await bootstrap.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE public.users (id integer PRIMARY KEY);
      CREATE TYPE public.of_status AS ENUM ('BROUILLON','PLANIFIE','EN_COURS','EN_PAUSE','TERMINE','CLOTURE','ANNULE');
      CREATE TABLE public.ordres_fabrication (id bigint PRIMARY KEY, statut public.of_status NOT NULL, technical_snapshot jsonb, technical_snapshot_sha256 text, piece_technique_id uuid NOT NULL, quantite_lancee numeric NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), date_lancement_reelle date, updated_by integer);
      CREATE TABLE public.of_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), of_id bigint NOT NULL, status text, machine_id uuid);
      CREATE TABLE public.planning_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), of_id bigint, start_ts timestamptz NOT NULL, end_ts timestamptz NOT NULL, status text NOT NULL DEFAULT 'PLANNED', archived_at timestamptz);
      CREATE TABLE public.operation_dossiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_type text, operation_id text, dossier_type text);
      CREATE TABLE public.operation_dossier_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dossier_id uuid);
      CREATE TABLE public.operation_dossier_version_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dossier_version_id uuid, document_id uuid);
      CREATE TABLE public.quality_control (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), of_id bigint, plan_id uuid, plan_version integer, plan_snapshot jsonb, plan_snapshot_sha256 text);
      CREATE TABLE public.non_conformity (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), of_id bigint, status text);
      CREATE TABLE public.pieces_techniques_nomenclature (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_piece_technique_id uuid);
      CREATE TABLE public.stock_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), of_id bigint, article_id uuid, qty_reserved numeric, status text, expires_at timestamptz);
    `);
    const migration = await fs.readFile(path.resolve(process.cwd(), "db/patches/20260823_of_readiness_release_617.sql"), "utf8");
    await bootstrap.query(migration);
    await bootstrap.end();
    pool = (await import("../config/database")).default;
    repository = await import("../module/production/repository/production.repository");
  }, 60_000);

  beforeEach(async () => {
    mocks.audit.mockClear();
    mocks.enqueue.mockClear();
    await pool.query("TRUNCATE public.of_release_decisions, public.of_operations, public.planning_events, public.operation_dossiers, public.operation_dossier_versions, public.operation_dossier_version_documents, public.quality_control, public.non_conformity, public.pieces_techniques_nomenclature, public.stock_reservations, public.ordres_fabrication, public.users");
    await pool.query("INSERT INTO public.users (id) VALUES (1)");
    await pool.query(`INSERT INTO public.ordres_fabrication
      (id, statut, technical_snapshot, technical_snapshot_sha256, piece_technique_id, quantite_lancee)
      VALUES (1,'PLANIFIE','{"nomenclature":[],"achats":[]}'::jsonb,$1,'11111111-1111-4111-8111-111111111111',2)`, ["a".repeat(64)]);
    const operation = await pool.query<{ id: string }>("INSERT INTO public.of_operations (of_id,status) VALUES (1,'TODO') RETURNING id::text AS id");
    const operationId = operation.rows[0]!.id;
    await pool.query("INSERT INTO public.planning_events (of_id,start_ts,end_ts) VALUES (1,now(),now()+interval '1 hour')");
    const dossier = await pool.query<{ id: string }>("INSERT INTO public.operation_dossiers (operation_type,operation_id,dossier_type) VALUES ('OF_OPERATION',$1,'INSTRUCTION') RETURNING id::text AS id", [operationId]);
    const version = await pool.query<{ id: string }>("INSERT INTO public.operation_dossier_versions (dossier_id) VALUES ($1::uuid) RETURNING id::text AS id", [dossier.rows[0]!.id]);
    await pool.query("INSERT INTO public.operation_dossier_version_documents (dossier_version_id,document_id) VALUES ($1::uuid,gen_random_uuid())", [version.rows[0]!.id]);
    await pool.query(`INSERT INTO public.quality_control (of_id,plan_id,plan_version,plan_snapshot,plan_snapshot_sha256)
      VALUES (1,gen_random_uuid(),3,'{"characteristics":[{"code":"DIM-A"}]}'::jsonb,$1)`, ["b".repeat(64)]);
  });

  afterAll(async () => { await pool?.end(); });

  it("serializes two simultaneous releases: one decision, one status commitment and one audit", async () => {
    const results = await Promise.allSettled([
      repository.repoReleaseOrdreFabrication({ id: 1, body: { override: false }, audit }),
      repository.repoReleaseOrdreFabrication({ id: 1, body: { override: false }, audit }),
    ]);
    const settledSummary = results.map((result) => result.status === "fulfilled"
      ? { status: result.status }
      : {
          status: result.status,
          name: result.reason instanceof Error ? result.reason.name : typeof result.reason,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          code: (result.reason as { code?: unknown } | null)?.code ?? null,
        });
    expect(
      results.filter((result) => result.status === "fulfilled"),
      JSON.stringify(settledSummary)
    ).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "OF_RELEASE_INVALID_STATE", status: 409 } });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.of_release_decisions WHERE of_id=1")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT statut::text AS statut FROM public.ordres_fabrication WHERE id=1")).rows[0].statut).toBe("EN_COURS");
    const evidence = (await pool.query<{ evidence: Record<string, unknown> }>("SELECT evidence FROM public.of_release_decisions WHERE of_id=1")).rows[0].evidence;
    expect(evidence).toMatchObject({ evidence_version: 2, technical_snapshot_sha256: "a".repeat(64), quality_plan_count: 1 });
    expect(evidence.quality_plan_evidence).toEqual([expect.objectContaining({ snapshot_sha256: "b".repeat(64), plan_version: 3 })]);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not accept a legacy Quality row without a frozen plan snapshot as release evidence", async () => {
    await pool.query("UPDATE public.quality_control SET plan_snapshot=NULL, plan_snapshot_sha256=NULL WHERE of_id=1");
    await expect(repository.repoReleaseOrdreFabrication({ id: 1, body: { override: false }, audit })).rejects.toMatchObject({
      code: "OF_NOT_READY_FOR_RELEASE",
      status: 409,
      details: expect.objectContaining({ blockers: expect.arrayContaining(["QUALITY_PLAN_MISSING"]) }),
    });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.of_release_decisions WHERE of_id=1")).rows[0].count).toBe(0);
  });

  it("does not treat cancelled or archived planning events as capacity evidence", async () => {
    await pool.query("UPDATE public.planning_events SET status='CANCELLED' WHERE of_id=1");
    await expect(repository.repoReleaseOrdreFabrication({ id: 1, body: { override: false }, audit })).rejects.toMatchObject({
      code: "OF_NOT_READY_FOR_RELEASE",
      status: 409,
      details: expect.objectContaining({ blockers: expect.arrayContaining(["CAPACITY_OR_CALENDAR_MISSING"]) }),
    });
    await pool.query("UPDATE public.planning_events SET status='PLANNED', archived_at=now() WHERE of_id=1");
    await expect(repository.repoReleaseOrdreFabrication({ id: 1, body: { override: false }, audit })).rejects.toMatchObject({
      code: "OF_NOT_READY_FOR_RELEASE",
      status: 409,
      details: expect.objectContaining({ blockers: expect.arrayContaining(["CAPACITY_OR_CALENDAR_MISSING"]) }),
    });
  });

  it("requires quantity coverage for every frozen material article and ignores unrelated reservations", async () => {
    await pool.query(`UPDATE public.ordres_fabrication SET technical_snapshot = $1::jsonb WHERE id=1`, [JSON.stringify({
      nomenclature: [
        { child_article_id: "22222222-2222-4222-8222-222222222222", quantite: 2 },
        { child_article_id: "33333333-3333-4333-8333-333333333333", quantite: 3 },
      ],
      achats: [],
    })]);
    await pool.query(`INSERT INTO public.stock_reservations (of_id,article_id,qty_reserved,status) VALUES
      (1,'22222222-2222-4222-8222-222222222222',4,'ACTIVE'),
      (1,'44444444-4444-4444-8444-444444444444',99,'ACTIVE')`);

    const insufficient = await repository.repoGetOfReadiness({ id: 1 });
    expect(insufficient).toMatchObject({ ready: false, blockers: expect.arrayContaining(["MATERIAL_RESERVATION_MISSING"]) });
    expect(insufficient?.evidence).toMatchObject({ material_requirement_count: 2, material_requirement_covered_count: 1 });
    expect(insufficient?.evidence.material_requirement_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ article_id: "22222222-2222-4222-8222-222222222222", required_qty: 4, reserved_qty: 4, covered: true }),
      expect.objectContaining({ article_id: "33333333-3333-4333-8333-333333333333", required_qty: 6, reserved_qty: 0, covered: false }),
    ]));

    await pool.query(`INSERT INTO public.stock_reservations (of_id,article_id,qty_reserved,status)
      VALUES (1,'33333333-3333-4333-8333-333333333333',6,'ACTIVE')`);
    await expect(repository.repoGetOfReadiness({ id: 1 })).resolves.toMatchObject({ ready: true, blockers: [] });

    await pool.query(`UPDATE public.stock_reservations SET expires_at = now() - interval '1 second'
      WHERE article_id='33333333-3333-4333-8333-333333333333'`);
    await expect(repository.repoGetOfReadiness({ id: 1 })).resolves.toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(["MATERIAL_RESERVATION_MISSING"]),
    });
  });

  it("enforces one immutable decision per OF at the database boundary", async () => {
    await repository.repoReleaseOrdreFabrication({ id: 1, body: { override: false }, audit });
    await expect(pool.query("UPDATE public.of_release_decisions SET evidence='{}'::jsonb WHERE of_id=1")).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM public.of_release_decisions WHERE of_id=1")).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(`INSERT INTO public.of_release_decisions
      (of_id,decision,override,blocker_codes,override_reason,evidence,decided_by)
      VALUES (1,'RELEASED',false,ARRAY[]::text[],NULL,'{}'::jsonb,1)`)).rejects.toMatchObject({
        code: "23505",
        constraint: "of_release_decisions_one_per_of_uk",
      });
  });

  it("blocks a direct planned-to-execution write without an immutable decision", async () => {
    await expect(pool.query("UPDATE public.ordres_fabrication SET statut='EN_COURS' WHERE id=1")).rejects.toMatchObject({
      code: "55000", constraint: "of_execution_release_required_617",
    });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.of_release_decisions WHERE of_id=1")).rows[0].count).toBe(0);
  });
});
