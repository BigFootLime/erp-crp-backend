import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Atelier" };
    next();
  },
  authorizeRole:
    (...roles: string[]) =>
    (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => void) => {
      if (req.user && roles.includes(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Accès interdit" });
    },
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/planning", () => {
  it("GET /api/v1/planning/health returns ok", async () => {
    const res = await request(app).get("/api/v1/planning/health").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /api/v1/planning/resources returns machines + postes", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            code: "M01",
            name: "Machine 1",
            type: "MILLING",
            status: "ACTIVE",
            is_available: true,
            archived_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            code: "P01",
            label: "Poste 1",
            machine_id: "11111111-1111-1111-1111-111111111111",
            machine_code: "M01",
            machine_name: "Machine 1",
            is_active: true,
            archived_at: null,
          },
        ],
      });

    const res = await request(app).get("/api/v1/planning/resources").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      machines: [{ resource_type: "MACHINE", code: "M01" }],
      postes: [{ resource_type: "POSTE", code: "P01" }],
    });

    const calls = mocks.poolQuery.mock.calls;
    expect(String(calls[0]?.[0])).toContain("FROM public.machines");
    expect(String(calls[1]?.[0])).toContain("FROM public.postes");
  });

  it("GET /api/v1/planning/events returns {items,total}", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            kind: "OF_OPERATION",
            status: "PLANNED",
            priority: "NORMAL",
            of_id: "7",
            of_operation_id: "44444444-4444-4444-4444-444444444444",
            machine_id: null,
            poste_id: "22222222-2222-2222-2222-222222222222",
            title: "P10 - Usinage",
            description: null,
            start_ts: "2026-02-14T08:00:00.000Z",
            end_ts: "2026-02-14T10:00:00.000Z",
            allow_overlap: false,
            created_at: "2026-02-14T07:00:00.000Z",
            updated_at: "2026-02-14T07:00:00.000Z",
             archived_at: null,
             of_numero: "OF-7",
             client_id: "C01",
             client_company_name: "ACME",
             client_color: null,
             client_blocked: false,
             client_block_reason: null,
             piece_code: "P-001",
             piece_designation: "Piece",
             operation_phase: 10,
             operation_designation: "Usinage",
             machine_code: null,
             machine_name: null,
             poste_code: "P01",
             poste_label: "Poste 1",

             of_date_fin_prevue: null,
             deadline_ts: null,
             stop_reason: null,
             blockers: [],
           },
         ],
       });

    const res = await request(app)
      .get("/api/v1/planning/events")
      .set("Authorization", "Bearer fake")
      .query({
        from: "2026-02-14T00:00:00.000Z",
        to: "2026-02-15T00:00:00.000Z",
      });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: "33333333-3333-3333-3333-333333333333",
      of_id: 7,
      poste_id: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("POST /api/v1/planning/autoplan creates sequential events", async () => {
    // Autoplan query: list operations for selected OFs
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            of_id: "7",
            of_numero: "OF-7",
            of_priority: "NORMAL",
            of_operation_id: "44444444-4444-4444-4444-444444444444",
            phase: 10,
            designation: "Usinage",
            temps_total_planned: 120,
            status: "TODO",
            machine_id: null,
            poste_id: "22222222-2222-2222-2222-222222222222",
          },
        ],
      })
      // Skip-planned check: no existing active planning event
      .mockResolvedValueOnce({ rows: [] })
      // repoCreatePlanningEvent reload: event list item
      .mockResolvedValueOnce({
        rows: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            kind: "OF_OPERATION",
            status: "PLANNED",
            priority: "NORMAL",
            of_id: "7",
            of_operation_id: "44444444-4444-4444-4444-444444444444",
            machine_id: null,
            poste_id: "22222222-2222-2222-2222-222222222222",
            title: "P10 - Usinage",
            description: null,
            start_ts: "2026-02-14T08:00:00.000Z",
            end_ts: "2026-02-14T10:00:00.000Z",
            allow_overlap: false,
            created_at: "2026-02-14T07:00:00.000Z",
            updated_at: "2026-02-14T07:00:00.000Z",
            archived_at: null,
            of_numero: "OF-7",
            client_id: "C01",
            client_company_name: "ACME",
            client_color: null,
            client_blocked: false,
            client_block_reason: null,
            piece_code: "P-001",
            piece_designation: "Piece",
            operation_phase: 10,
            operation_designation: "Usinage",
            machine_code: null,
            machine_name: null,
            poste_code: "P01",
            poste_label: "Poste 1",
            of_date_fin_prevue: null,
            deadline_ts: null,
            stop_reason: null,
            blockers: [],
          },
        ],
      });

    // repoCreatePlanningEvent internals: BEGIN, select defaults, conflict check, insert, audit, COMMIT
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("FROM public.of_time_logs")) {
        return { rows: [{ open_time_log_count: 0 }] };
      }
      if (q.includes("GROUP BY op.of_id, op.status")) {
        return {
          rows: [
            {
              of_id: "7",
              current_status: "TODO",
              has_done: false,
              has_in_progress: false,
              has_blocked: false,
              has_planned: true,
            },
          ],
        };
      }
      if (q.includes("FROM public.of_operations op") && q.includes("LIMIT 1")) {
        return {
          rows: [
            {
              of_id: "7",
              phase: 10,
              designation: "Usinage",
              machine_id: null,
              poste_id: "22222222-2222-2222-2222-222222222222",
            },
          ],
        };
      }
      if (q.includes("FROM public.ordres_fabrication o") && q.includes("active_events")) {
        return {
          rows: [
            {
              statut: "PLANIFIE",
              commande_id: null,
              numero: "OF-7",
              total_ops: 1,
              done_ops: 0,
              running_ops: 0,
              active_events: 1,
            },
          ],
        };
      }
      if (q.includes("SELECT commande_id::text AS commande_id FROM public.ordres_fabrication")) {
        return { rows: [{ commande_id: null }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post("/api/v1/planning/autoplan")
      .set("Authorization", "Bearer fake")
      .send({
        of_ids: [7],
        start_ts: "2026-02-14T08:00:00.000Z",
        step_minutes: 15,
        skip_planned: true,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      created_events: [
        {
          event_id: "33333333-3333-3333-3333-333333333333",
          of_id: 7,
          of_operation_id: "44444444-4444-4444-4444-444444444444",
        },
      ],
      skipped_operations: [],
    });
  });

  it("POST /api/v1/planning/events promotes commande to PLANIFIEE and creates notifications", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          kind: "OF_OPERATION",
          status: "PLANNED",
          priority: "NORMAL",
          of_id: "7",
          of_operation_id: "44444444-4444-4444-4444-444444444444",
          machine_id: null,
          poste_id: "22222222-2222-2222-2222-222222222222",
          operator_id: null,
          title: "P10 - Usinage",
          description: null,
          start_ts: "2026-02-14T08:00:00.000Z",
          end_ts: "2026-02-14T10:00:00.000Z",
          allow_overlap: false,
          created_at: "2026-02-14T07:00:00.000Z",
          updated_at: "2026-02-14T07:00:00.000Z",
          archived_at: null,
          of_numero: "OF-7",
          client_id: "C01",
          client_company_name: "ACME",
          client_color: null,
          client_blocked: false,
          client_block_reason: null,
          piece_code: "P-001",
          piece_designation: "Piece",
          operation_phase: 10,
          operation_designation: "Usinage",
          machine_code: null,
          machine_name: null,
          poste_code: "P01",
          poste_label: "Poste 1",
          operator_name: null,
          operation_started_at: null,
          operation_ended_at: null,
          production_group_id: null,
          production_group_code: null,
          of_date_fin_prevue: null,
          deadline_ts: null,
          stop_reason: null,
          blockers: [],
        },
      ],
    });

    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM public.of_operations op") && q.includes("WHERE op.id = $1::uuid") && q.includes("LIMIT 1")) {
        return {
          rows: [
            {
              of_id: "7",
              phase: 10,
              designation: "Usinage",
              machine_id: null,
              poste_id: "22222222-2222-2222-2222-222222222222",
            },
          ],
        };
      }
      if (q.includes("FROM public.of_time_logs")) {
        return { rows: [{ open_time_log_count: 0 }] };
      }
      if (q.includes("FROM public.planning_events e") && q.includes("LIMIT 25")) {
        return { rows: [] };
      }
      if (q.includes("INSERT INTO public.planning_events")) {
        return { rows: [] };
      }
      if (q.includes("GROUP BY op.of_id, op.status")) {
        return {
          rows: [
            {
              of_id: "7",
              current_status: "TODO",
              has_done: false,
              has_in_progress: false,
              has_blocked: false,
              has_planned: true,
            },
          ],
        };
      }
      if (q.includes("UPDATE public.of_operations")) {
        return { rows: [] };
      }
      if (q.includes("FROM public.ordres_fabrication o") && q.includes("active_events")) {
        return {
          rows: [
            {
              statut: "BROUILLON",
              commande_id: "123",
              numero: "OF-7",
              total_ops: 1,
              done_ops: 0,
              running_ops: 0,
              active_events: 1,
            },
          ],
        };
      }
      if (q.includes("SELECT id::int AS id, numero, client_id") && q.includes("FROM commande_client")) {
        return { rows: [{ id: 123, numero: "CC-123", client_id: "001" }] };
      }
      if (q.includes("FROM commande_historique") && q.includes("LIMIT 1")) {
        return { rows: [{ nouveau_statut: "ENREGISTREE" }] };
      }
      if (q.includes("INSERT INTO commande_historique")) {
        return { rows: [{ id: "11" }] };
      }
      if (q.includes("INSERT INTO public.commande_client_event_log")) {
        return { rows: [] };
      }
      if (q.includes("FROM public.users u") && q.includes("ghislaine")) {
        return { rows: [{ id: 9 }] };
      }
      if (q.includes("FROM public.app_notifications") && q.includes("dedupe_key")) {
        return { rows: [] };
      }
      if (q.includes("INSERT INTO public.app_notifications")) {
        return {
          rows: [
            {
              id: "55555555-5555-5555-5555-555555555555",
              user_id: 9,
              kind: "commande.planifiee",
              title: "Commande CC-123 planifiée",
              message: "La commande CC-123 est maintenant planifiée. Un AR peut être envoyé au client.",
              severity: "success",
              action_url: "/commandes/123",
              action_label: "Ouvrir",
              payload: {},
              created_at: "2026-02-14T07:01:00.000Z",
              read_at: null,
            },
          ],
        };
      }
      if (q.includes("SELECT commande_id::text AS commande_id FROM public.ordres_fabrication")) {
        return { rows: [{ commande_id: "123" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post("/api/v1/planning/events")
      .set("Authorization", "Bearer fake")
      .send({
        kind: "OF_OPERATION",
        status: "PLANNED",
        priority: "NORMAL",
        of_id: 7,
        of_operation_id: "44444444-4444-4444-4444-444444444444",
        poste_id: "22222222-2222-2222-2222-222222222222",
        start_ts: "2026-02-14T08:00:00.000Z",
        end_ts: "2026-02-14T10:00:00.000Z",
      });

    expect(res.status).toBe(201);
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO commande_historique"))).toBe(true);
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.app_notifications"))).toBe(true);
  });
});
