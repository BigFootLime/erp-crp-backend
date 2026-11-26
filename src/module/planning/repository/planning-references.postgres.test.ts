import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { repoGetPlanningReferenceOf } from "./planning-references.repository";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../../config/database", () => ({ default: { query } }));

const fixturePort = process.env.CERP_PLANNING_REFERENCE_PG_PORT;
const fixtureDatabase = "cerp_planning_references_fixture";
const fixtureUser = "cerp_reference_test";
const enabled = process.env.CERP_E2E_ISOLATED === "1" && /^\d{5}$/.test(fixturePort ?? "");

describe.skipIf(!enabled)("Planning OF reference commitments on disposable PostgreSQL", () => {
  let pg: Pool;
  beforeAll(async () => {
    pg = new Pool({
      host: "127.0.0.1", port: Number(fixturePort), database: fixtureDatabase, user: fixtureUser,
      connectionTimeoutMillis: 3000,
    });
    const resolveIdentity = await pg.query("SELECT current_database() AS db, current_user AS role");
    expect(resolveIdentity.rows).toEqual([{ db: fixtureDatabase, role: fixtureUser }]);
    await pg.query(`
      SET TIME ZONE 'Europe/Paris';
      CREATE TABLE public.ordres_fabrication (id bigint PRIMARY KEY, quantite_lancee numeric, technical_snapshot jsonb);
      CREATE TABLE public.of_revisions (id text PRIMARY KEY, statut text);
      CREATE TABLE public.of_operations (
        id text PRIMARY KEY, of_id bigint, revision_id text, phase int, designation text, status text,
        poste_id text, machine_id text, tp numeric, tf_unit numeric, qte numeric, coef numeric,
        started_at timestamptz, ended_at timestamptz, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.postes (id text PRIMARY KEY, code text, label text);
      CREATE TABLE public.machines (id text PRIMARY KEY, code text, name text);
      CREATE TABLE public.planning_events (
        id text PRIMARY KEY, of_operation_id text, status text, archived_at timestamptz,
        start_ts timestamptz, end_ts timestamptz
      );
      CREATE TABLE public.planning_tasks (
        operation_id text PRIMARY KEY, committed_start timestamptz, committed_end timestamptz
      );
      INSERT INTO public.ordres_fabrication VALUES (
        42, 10, '{"operations":[{"phase":10,"type_operation":"USINAGE"},{"phase":20,"type_operation":"SOUS_TRAITANCE"},{"phase":25,"type_operation":"SOUS_TRAITANCE"},{"phase":30,"type_operation":"USINAGE"},{"phase":50,"type_operation":"SOUS_TRAITANCE"}]}'
      );
      INSERT INTO public.of_revisions VALUES ('active', 'ACTIVE'), ('retired', 'ARCHIVED');
      INSERT INTO public.machines VALUES ('machine-1', 'M01', 'Fraiseuse de recette');
      INSERT INTO public.of_operations (id,of_id,revision_id,phase,designation,status,machine_id,tp,tf_unit,qte,coef) VALUES
        ('machining',42,'active',10,'Usinage','TODO','machine-1',0,0.1,1,1),
        ('external',42,NULL,20,'Sous-traitance','TODO',NULL,0,0.1,1,1),
        ('external-event',42,'active',25,'Sous-traitance avec événement','TODO',NULL,0,0.1,1,1),
        ('unplaced',42,'active',30,'Sans engagement','TODO',NULL,0,0.1,1,1),
        ('cancelled',42,'active',40,'Annulée','CANCELLED',NULL,0,0.1,1,1),
        ('retired',42,'retired',50,'Retirée','TODO',NULL,0,0.1,1,1);
      INSERT INTO public.planning_events VALUES
        ('cancelled-event','machining','CANCELLED',NULL,'2026-11-01T08:00:00Z','2026-11-01T09:00:00Z'),
        ('archived-event','machining','PLANNED',now(),'2026-11-02T08:00:00Z','2026-11-02T09:00:00Z'),
        ('backwards-event','machining','PLANNED',NULL,'2026-11-03T08:00:00Z','2026-11-03T07:00:00Z'),
        ('first-valid-event','machining','PLANNED',NULL,'2027-03-02T08:00:00Z','2027-03-02T09:00:00Z'),
        ('later-event','machining','PLANNED',NULL,'2027-03-02T10:00:00Z','2027-03-02T11:00:00Z'),
        ('external-event-priority','external-event','PLANNED',NULL,'2027-03-02T11:00:00Z','2027-03-02T12:00:00Z'),
        ('event-for-cancelled-phase','cancelled','PLANNED',NULL,'2027-03-03T08:00:00Z','2027-03-03T09:00:00Z');
      INSERT INTO public.planning_tasks VALUES
        ('external','2027-03-03T08:30:00Z','2027-03-04T09:30:00Z'),
        ('external-event','2027-03-03T08:30:00Z','2027-03-04T09:30:00Z'),
        ('unplaced','2027-03-03T08:30:00Z','2027-03-04T09:30:00Z'),
        ('retired','2027-03-03T08:30:00Z','2027-03-04T09:30:00Z');
    `);
  });
  afterAll(async () => { await pg?.end(); });

  it("returns current commitments in ISO format and keeps previous operation fields", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "42", numero: "OF-FIXTURE", total_ops: 6, done_ops: 0 }] });
    query.mockImplementationOnce((sql: string, values: unknown[]) => pg.query(sql, values));
    const result = await repoGetPlanningReferenceOf(42);
    expect(result?.numero).toBe("OF-FIXTURE");
    expect(result?.operations).toMatchObject([
      { id: "machining", phase: 10, machine_name: "Fraiseuse de recette", planned_duration_minutes: 60, is_current: true,
        committed: { start: "2027-03-02T08:00:00.000Z", end: "2027-03-02T09:00:00.000Z" } },
      { id: "external", is_current: true,
        committed: { start: "2027-03-03T08:30:00.000Z", end: "2027-03-04T09:30:00.000Z" } },
      { id: "external-event", is_current: true,
        committed: { start: "2027-03-02T11:00:00.000Z", end: "2027-03-02T12:00:00.000Z" } },
      { id: "unplaced", is_current: true, committed: null },
      { id: "cancelled", is_current: false, committed: null },
      { id: "retired", is_current: false, committed: null },
    ]);
    expect(result?.operations[0]).not.toHaveProperty("committed_start");
    expect(result?.operations[0]).not.toHaveProperty("committed_end");
  });
});
