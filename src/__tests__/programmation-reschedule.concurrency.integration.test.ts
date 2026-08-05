import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const integrationUrl = process.env.PROGRAMMATION_RESCHEDULE_TEST_DATABASE_URL;

vi.mock("../shared/realtime/realtime-outbox-transaction", () => ({
  withRealtimeOutboxTransaction: async (
    client: { query: (sql: string, values?: unknown[]) => Promise<unknown>; release: (destroy?: boolean) => void },
    work: (client: unknown) => Promise<unknown>,
  ) => {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      client.release();
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      client.release();
      throw error;
    }
  },
}));

vi.mock("../shared/realtime/realtime-outbox.service", () => ({
  enqueueAppNotificationCreated: vi.fn(async () => "notification-outbox"),
  enqueueEntityChanged: vi.fn(async () => "entity-outbox"),
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: vi.fn(async () => ({ id: crypto.randomUUID(), created_at: new Date().toISOString() })),
}));

const suite = integrationUrl ? describe : describe.skip;

suite("programmation reschedule PostgreSQL concurrency", () => {
  let pool: import("pg").Pool;
  let repository: typeof import("../module/programmation/repository/programmation.repository");

  const taskId = "11111111-1111-4111-8111-111111111111";
  const otherTaskId = "22222222-2222-4222-8222-222222222222";
  const pieceId = "33333333-3333-4333-8333-333333333333";
  const otherPieceId = "44444444-4444-4444-8444-444444444444";
  const operationId = "55555555-5555-4555-8555-555555555555";
  const audit = {
    user_id: 1,
    role: "Responsable Programmation",
    ip: null,
    user_agent: null,
    device_type: null,
    os: null,
    browser: null,
    path: "/api/v1/programmations/reschedule",
    page_key: "planning",
    client_session_id: null,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = integrationUrl;
    const pg = await import("pg");
    const bootstrap = new pg.Client({ connectionString: integrationUrl });
    await bootstrap.connect();
    const database = await bootstrap.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) {
      throw new Error("PROGRAMMATION_RESCHEDULE_TEST_DATABASE_URL must target an explicitly named test/local/sandbox database");
    }
    await bootstrap.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await bootstrap.query(`
      CREATE TABLE public.users (
        id integer PRIMARY KEY, username text NOT NULL, status text, role text
      );
      CREATE TABLE public.pieces_techniques (
        id uuid PRIMARY KEY, code_piece text NOT NULL, designation text NOT NULL
      );
      CREATE TABLE public.machines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, name text NOT NULL,
        status text, is_available boolean DEFAULT true, scheduling_enabled boolean DEFAULT true,
        machine_family_code text
      );
      CREATE TABLE public.postes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, label text NOT NULL,
        is_active boolean DEFAULT true, machine_id uuid REFERENCES public.machines(id)
      );
      CREATE TABLE public.of_operations (
        id uuid PRIMARY KEY, designation text
      );
      CREATE TABLE public.of_time_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), of_operation_id uuid NOT NULL REFERENCES public.of_operations(id),
        user_id integer NOT NULL REFERENCES public.users(id), started_at timestamptz NOT NULL, ended_at timestamptz
      );
      CREATE TYPE public.planning_event_status AS ENUM ('PLANNED','IN_PROGRESS','DONE','BLOCKED','CANCELLED');
      CREATE TABLE public.planning_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), machine_id uuid REFERENCES public.machines(id),
        poste_id uuid REFERENCES public.postes(id), title text NOT NULL, start_ts timestamptz NOT NULL,
        end_ts timestamptz NOT NULL, status public.planning_event_status NOT NULL DEFAULT 'PLANNED', archived_at timestamptz
      );
      CREATE TABLE public.programmations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id),
        date_commencement date NOT NULL, date_fin date NOT NULL, programmer_user_id integer REFERENCES public.users(id),
        plan_reference text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer REFERENCES public.users(id), updated_by integer REFERENCES public.users(id),
        archived_at timestamptz, archived_by integer REFERENCES public.users(id),
        CONSTRAINT programmations_dates_ok CHECK (date_commencement <= date_fin)
      );
      CREATE TABLE public.app_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id integer NOT NULL REFERENCES public.users(id),
        kind text NOT NULL, title text NOT NULL, message text NOT NULL, severity text NOT NULL,
        action_url text, action_label text, payload jsonb NOT NULL DEFAULT '{}', dedupe_key text,
        created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
      );
      CREATE UNIQUE INDEX app_notifications_user_dedupe_idx
        ON public.app_notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE TABLE public.erp_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.cerp_schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE OR REPLACE FUNCTION public.tg_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    `);
    const migration = await fs.readFile(
      path.resolve(process.cwd(), "db/patches/20260805_programmation_safe_reschedule_0004.sql"),
      "utf8",
    );
    await bootstrap.query(migration);
    await bootstrap.end();

    const databaseModule = await import("../config/database");
    pool = databaseModule.default;
    repository = await import("../module/programmation/repository/programmation.repository");
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE public.programmation_reschedule_events,
               public.programmation_reschedule_operations,
               public.programmation_dependencies,
               public.programmation_required_skills,
               public.programmation_user_skills,
               public.programmation_calendar_closures,
               public.app_notifications,
               public.planning_events,
               public.of_time_logs,
               public.programmations,
               public.of_operations,
               public.postes,
               public.machines,
               public.pieces_techniques,
               public.programmation_calendars,
               public.users
      RESTART IDENTITY CASCADE
    `);
    await pool.query(`INSERT INTO public.users (id, username, status, role) VALUES
      (1, 'planner', 'active', 'Responsable Programmation'),
      (2, 'planner-two', 'active', 'Programmation')`);
    await pool.query(`INSERT INTO public.pieces_techniques (id, code_piece, designation) VALUES
      ($1::uuid, 'P-001', 'Pièce une'), ($2::uuid, 'P-002', 'Pièce deux')`, [pieceId, otherPieceId]);
    await pool.query(`INSERT INTO public.of_operations (id, designation) VALUES ($1::uuid, 'Programmation CN')`, [operationId]);
    await pool.query(`INSERT INTO public.programmations (
      id, piece_technique_id, date_commencement, date_fin, programmer_user_id, of_operation_id
    ) VALUES ($1::uuid, $2::uuid, '2026-08-10', '2026-08-12', 1, $3::uuid)`, [taskId, pieceId, operationId]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const previewBody = () => ({
    expected_version: 1,
    reason: "Priorité client confirmée",
    timezone: "Europe/Paris",
    source: "API" as const,
    candidate: {
      start_date: "2026-08-17",
      end_date: "2026-08-19",
      programmer_user_id: 1,
      machine_id: null,
      poste_id: null,
      calendar_id: null,
    },
  });

  it("serializes a double drop and replays one committed operation", async () => {
    const preview = await repository.repoPreviewProgrammationReschedule({ id: taskId, body: previewBody() });
    expect(preview.valid).toBe(true);
    const body = {
      ...previewBody(),
      idempotency_key: "drop:concurrent-0001",
      preview_token: preview.preview_token,
    };
    const [first, second] = await Promise.all([
      repository.repoCommitProgrammationReschedule({ id: taskId, body, audit }),
      repository.repoCommitProgrammationReschedule({ id: taskId, body, audit }),
    ]);
    expect(first.operation_id).toBe(second.operation_id);
    expect([first.idempotent_replay, second.idempotent_replay].filter(Boolean)).toHaveLength(1);
    const state = await pool.query(`SELECT version, date_commencement::text AS start_date FROM public.programmations WHERE id = $1`, [taskId]);
    expect(state.rows[0]).toMatchObject({ version: 2, start_date: "2026-08-17" });
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM public.programmation_reschedule_operations`)).rows[0].count).toBe(1);
  });

  it("allows one of two concurrent different intentions and returns an actionable stale conflict", async () => {
    const firstPreview = await repository.repoPreviewProgrammationReschedule({ id: taskId, body: previewBody() });
    const secondPreviewBody = {
      ...previewBody(),
      candidate: { ...previewBody().candidate, start_date: "2026-08-24", end_date: "2026-08-26" },
    };
    const secondPreview = await repository.repoPreviewProgrammationReschedule({ id: taskId, body: secondPreviewBody });
    const settled = await Promise.allSettled([
      repository.repoCommitProgrammationReschedule({
        id: taskId,
        audit,
        body: { ...previewBody(), idempotency_key: "drop:intention-0001", preview_token: firstPreview.preview_token },
      }),
      repository.repoCommitProgrammationReschedule({
        id: taskId,
        audit,
        body: { ...secondPreviewBody, idempotency_key: "drop:intention-0002", preview_token: secondPreview.preview_token },
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "PROGRAMMATION_STALE", status: 409 });
    expect(rejected?.reason.details).toMatchObject({ expected_version: 1, current_version: 2 });
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM public.programmation_reschedule_operations`)).rows[0].count).toBe(1);
  });

  it("rejects overlap and open time-log constraints without partial writes", async () => {
    await pool.query(`INSERT INTO public.programmations (
      id, piece_technique_id, date_commencement, date_fin, programmer_user_id
    ) VALUES ($1::uuid, $2::uuid, '2026-08-17', '2026-08-18', 1)`, [otherTaskId, otherPieceId]);
    await pool.query(`INSERT INTO public.of_time_logs (of_operation_id, user_id, started_at) VALUES ($1::uuid, 1, now())`, [operationId]);
    const preview = await repository.repoPreviewProgrammationReschedule({ id: taskId, body: previewBody() });
    expect(preview.valid).toBe(false);
    expect(preview.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      "PROGRAMMER_OVERLAP", "PROGRAMMATION_TIME_LOG_OPEN",
    ]));
    await expect(repository.repoCommitProgrammationReschedule({
      id: taskId,
      audit,
      body: {
        ...previewBody(),
        idempotency_key: "drop:blocked-0001",
        preview_token: preview.preview_token,
      },
    })).rejects.toMatchObject({ code: "PROGRAMMATION_CONSTRAINT_VIOLATION", status: 409 });
    const state = await pool.query(`SELECT version, date_commencement::text AS start_date FROM public.programmations WHERE id = $1`, [taskId]);
    expect(state.rows[0]).toMatchObject({ version: 1, start_date: "2026-08-10" });
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM public.programmation_reschedule_operations`)).rows[0].count).toBe(0);
  });

  it("compensates once and idempotently replays cancellation", async () => {
    const preview = await repository.repoPreviewProgrammationReschedule({ id: taskId, body: previewBody() });
    const committed = await repository.repoCommitProgrammationReschedule({
      id: taskId,
      audit,
      body: {
        ...previewBody(),
        idempotency_key: "drop:cancel-case-0001",
        preview_token: preview.preview_token,
      },
    });
    const cancelBody = {
      expected_version: committed.task.version,
      reason: "Annulation compensée de la recette",
      timezone: "Europe/Paris",
      source: "API" as const,
      idempotency_key: "cancel:concurrent-0001",
    };
    const first = await repository.repoCancelProgrammationReschedule({
      id: taskId, operationId: committed.operation_id, body: cancelBody, audit,
    });
    const second = await repository.repoCancelProgrammationReschedule({
      id: taskId, operationId: committed.operation_id, body: cancelBody, audit,
    });
    expect(first.operation_id).toBe(second.operation_id);
    expect(second.idempotent_replay).toBe(true);
    const state = await pool.query(`SELECT version, date_commencement::text AS start_date, date_fin::text AS end_date FROM public.programmations WHERE id = $1`, [taskId]);
    expect(state.rows[0]).toMatchObject({ version: 3, start_date: "2026-08-10", end_date: "2026-08-12" });
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM public.programmation_reschedule_events`)).rows[0].count).toBe(2);
  });
});
