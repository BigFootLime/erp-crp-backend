// #170 — OF récursifs, opérations et traçabilité immuable.
// Tests d'orchestration HTTP (pg mocké, mêmes conventions que commandes.routes.test.ts) :
// machine d'état, verrou optimiste, RBAC par capacité, réordonnancement,
// aperçu sans effet de bord, génération idempotente, réception bornée.

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
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string }; headers?: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void
  ) => {
    const requestedRole = req.headers?.["x-test-role"];
    req.user = {
      id: 1,
      role: typeof requestedRole === "string" ? requestedRole : "Administrateur Systeme et Reseau",
    };
    next();
  },
  authorizeRole:
    () =>
    (_req: unknown, _res: unknown, next: () => void) => {
      next();
    },
}));

import app from "../config/app";

const OF_UPDATED_AT = "2026-07-22T10:00:00.000+02:00";
const PIECE_ROOT = "22222222-2222-2222-2222-222222222222";
const PIECE_A = "33333333-3333-3333-3333-333333333333";
const PIECE_B = "44444444-4444-4444-4444-444444444444";
const PIECE_C = "55555555-5555-5555-5555-555555555555";
const VERSION_ID = "66666666-6666-6666-6666-666666666666";
const OP_1 = "77777777-7777-7777-7777-777777777771";
const OP_2 = "77777777-7777-7777-7777-777777777772";

function ofHeaderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "5",
    numero: "OF-2026-000005",
    affaire_id: null,
    commande_id: null,
    parent_of_id: null,
    root_of_id: "5",
    generation_batch_id: null,
    generation_level: 0,
    source_bom_line_id: null,
    structure_path: "5",
    quantity_per_parent: 1,
    quantity_cumulative: 1,
    client_id: null,
    client_company_name: null,
    production_group_id: null,
    production_group_code: null,
    piece_technique_id: PIECE_ROOT,
    piece_technique_version_id: VERSION_ID,
    technical_snapshot_sha256: "a".repeat(64),
    technical_snapshot_at: "2026-07-22T09:00:00.000Z",
    piece_code: "PT-ROOT",
    piece_designation: "Piece mere",
    quantite_lancee: 26,
    quantite_bonne: 0,
    quantite_rebut: 0,
    statut: "BROUILLON",
    priority: "NORMAL",
    date_lancement_prevue: null,
    date_fin_prevue: null,
    date_lancement_reelle: null,
    date_fin_reelle: null,
    notes: null,
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: OF_UPDATED_AT,
    created_by: 1,
    updated_by: 1,
    ...overrides,
  };
}

function installHeaderReaders(statut = "BROUILLON") {
  mocks.poolQuery.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes("FROM ordres_fabrication o") || (q.includes("FROM ordres_fabrication") && q.includes("o.numero"))) {
      return { rows: [ofHeaderRow({ statut })] };
    }
    if (q.includes("FROM of_operations")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
});

describe("#170 OF state machine + optimistic lock (PATCH /production/ofs/:id)", () => {
  function installOfForUpdate(params: { statut: string; updated_at?: string }) {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM ordres_fabrication") && q.includes("FOR UPDATE")) {
        return {
          rows: [{ id: "5", commande_id: null, statut: params.statut, updated_at: params.updated_at ?? OF_UPDATED_AT }],
        };
      }
      if (q.includes("UPDATE ordres_fabrication SET")) return { rows: [{ id: "5" }] };
      if (q.includes("INSERT INTO erp_audit_logs")) return { rows: [{ id: "1", created_at: "2026-01-01T00:00:00.000Z" }] };
      return { rows: [] };
    });
    installHeaderReaders(params.statut);
  }

  it("rejects an invalid statut transition with 409 OF_INVALID_TRANSITION", async () => {
    installOfForUpdate({ statut: "BROUILLON" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .send({ statut: "CLOTURE", expected_updated_at: OF_UPDATED_AT });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_INVALID_TRANSITION" });
  });

  it("accepts a valid transition BROUILLON -> PLANIFIE", async () => {
    installOfForUpdate({ statut: "BROUILLON" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .send({ statut: "PLANIFIE", expected_updated_at: OF_UPDATED_AT });
    expect(res.status).toBe(200);
  });

  it("rejects a stale optimistic token with 409 CONCURRENT_MODIFICATION", async () => {
    installOfForUpdate({ statut: "BROUILLON" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .send({ notes: "maj", expected_updated_at: "2026-07-22T09:59:59.000+02:00" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("locks structural fields after launch with 409 OF_LOCKED_AFTER_LAUNCH", async () => {
    installOfForUpdate({ statut: "EN_COURS" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .send({ quantite_lancee: 99, expected_updated_at: OF_UPDATED_AT });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_LOCKED_AFTER_LAUNCH" });
  });

  it("still accepts workshop life fields after launch", async () => {
    installOfForUpdate({ statut: "EN_COURS" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .send({ quantite_bonne: 10, expected_updated_at: OF_UPDATED_AT });
    expect(res.status).toBe(200);
  });

  it("denies OF mutations to roles without any OF capability (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .set("x-test-role", "Employe")
      .send({ notes: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OF_FORBIDDEN" });
  });

  it("denies cancellation to operator roles without cancel capability (403)", async () => {
    installOfForUpdate({ statut: "EN_COURS" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5")
      .set("x-test-role", "Operateur Atelier")
      .send({ statut: "ANNULE", expected_updated_at: OF_UPDATED_AT });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "OF_TRANSITION_FORBIDDEN" });
  });
});

describe("#170 operation transitions + time logs", () => {
  it("rejects an invalid operation transition DONE -> RUNNING (409)", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM of_operations") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: OP_1, status: "DONE" }] };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .patch(`/api/v1/production/ofs/5/operations/${OP_1}`)
      .send({ status: "RUNNING" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_OPERATION_INVALID_TRANSITION" });
  });

  it("refuses starting a time log on a cancelled OF (409 OF_EXECUTION_NOT_ALLOWED)", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM ordres_fabrication") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: "5", statut: "ANNULE" }] };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .post(`/api/v1/production/ofs/5/operations/${OP_1}/time-logs/start`)
      .send({ type: "PRODUCTION" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_EXECUTION_NOT_ALLOWED" });
  });

  it("refuses starting a time log on a DONE operation (409 OF_OPERATION_ALREADY_DONE)", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM ordres_fabrication") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: "5", statut: "EN_COURS" }] };
      }
      if (q.includes("FROM of_operations") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: OP_1, machine_id: null, status: "DONE" }] };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .post(`/api/v1/production/ofs/5/operations/${OP_1}/time-logs/start`)
      .send({ type: "PRODUCTION" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_OPERATION_ALREADY_DONE" });
  });

  it("auto-advances a BROUILLON OF to EN_COURS when a time log starts", async () => {
    const updates: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM ordres_fabrication") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: "5", statut: "BROUILLON" }] };
      }
      if (q.includes("FROM of_operations") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: OP_1, machine_id: null, status: "TODO" }] };
      }
      if (q.includes("INSERT INTO of_time_logs")) return { rows: [{ id: "log-1" }] };
      if (q.includes("UPDATE ordres_fabrication")) {
        updates.push(q);
        return { rows: [] };
      }
      if (q.includes("INSERT INTO erp_audit_logs")) return { rows: [{ id: "1", created_at: "2026-01-01T00:00:00.000Z" }] };
      return { rows: [] };
    });
    mocks.poolQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("FROM of_operations op")) {
        return {
          rows: [
            {
              id: OP_1,
              of_id: "5",
              phase: 10,
              designation: "Tournage",
              cf_id: null,
              poste_id: null,
              poste_code: null,
              poste_label: null,
              machine_id: null,
              machine_code: null,
              machine_name: null,
              hourly_rate_applied: 0,
              tp: 0.5,
              tf_unit: 0.1,
              qte: 1,
              coef: 1,
              temps_total_planned: 0.6,
              temps_total_real: 0,
              status: "RUNNING",
              started_at: "2026-07-22T10:00:00.000Z",
              ended_at: null,
              notes: null,
              updated_at: "2026-07-22T10:00:00.000Z",
              open_log_id: "log-1",
              open_log_of_operation_id: OP_1,
              open_log_user_id: 1,
              open_log_machine_id: null,
              open_log_started_at: "2026-07-22T10:00:00.000Z",
              open_log_ended_at: null,
              open_log_duration_minutes: null,
              open_log_type: "PRODUCTION",
              open_log_comment: null,
              open_log_created_at: "2026-07-22T10:00:00.000Z",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .post(`/api/v1/production/ofs/5/operations/${OP_1}/time-logs/start`)
      .set("x-test-role", "Responsable Production")
      .send({ type: "PRODUCTION" });
    expect(res.status).toBe(201);
    expect(updates.some((q) => q.includes("'EN_COURS'::of_status"))).toBe(true);
  });
});

describe("#170 operations reorder (PATCH /production/ofs/:id/operations/reorder)", () => {
  function installReorderMocks(params: { statut?: string; opStatuses?: [string, string] }) {
    const statut = params.statut ?? "BROUILLON";
    const [s1, s2] = params.opStatuses ?? ["TODO", "READY"];
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM ordres_fabrication") && q.includes("FOR UPDATE")) {
        return { rows: [{ id: "5", statut, updated_at: OF_UPDATED_AT }] };
      }
      if (q.includes("FROM of_operations") && q.includes("FOR UPDATE")) {
        return {
          rows: [
            { id: OP_1, phase: 10, status: s1 },
            { id: OP_2, phase: 20, status: s2 },
          ],
        };
      }
      if (q.includes("UPDATE of_operations")) return { rows: [] };
      if (q.includes("UPDATE ordres_fabrication")) return { rows: [] };
      if (q.includes("INSERT INTO erp_audit_logs")) return { rows: [{ id: "1", created_at: "2026-01-01T00:00:00.000Z" }] };
      return { rows: [] };
    });
    installHeaderReaders(statut);
  }

  it("reorders operations before launch (200)", async () => {
    installReorderMocks({});
    const res = await request(app)
      .patch("/api/v1/production/ofs/5/operations/reorder")
      .send({
        expected_updated_at: OF_UPDATED_AT,
        operations: [
          { op_id: OP_2, phase: 10 },
          { op_id: OP_1, phase: 20 },
        ],
      });
    expect(res.status).toBe(200);
  });

  it("refuses reorder once an operation is RUNNING (409 OF_OPERATION_SEQUENCE_LOCKED)", async () => {
    installReorderMocks({ opStatuses: ["RUNNING", "TODO"] });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5/operations/reorder")
      .send({
        expected_updated_at: OF_UPDATED_AT,
        operations: [
          { op_id: OP_2, phase: 10 },
          { op_id: OP_1, phase: 20 },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_OPERATION_SEQUENCE_LOCKED" });
  });

  it("refuses reorder on a launched OF (409 OF_LOCKED_AFTER_LAUNCH)", async () => {
    installReorderMocks({ statut: "EN_COURS" });
    const res = await request(app)
      .patch("/api/v1/production/ofs/5/operations/reorder")
      .send({
        expected_updated_at: OF_UPDATED_AT,
        operations: [
          { op_id: OP_2, phase: 10 },
          { op_id: OP_1, phase: 20 },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_LOCKED_AFTER_LAUNCH" });
  });

  it("refuses a sequence not covering the exact operation set (422)", async () => {
    installReorderMocks({});
    const res = await request(app)
      .patch("/api/v1/production/ofs/5/operations/reorder")
      .send({
        expected_updated_at: OF_UPDATED_AT,
        operations: [{ op_id: OP_1, phase: 10 }],
      });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "OF_OPERATION_SET_MISMATCH" });
  });

  it("refuses a stale optimistic token (409 CONCURRENT_MODIFICATION)", async () => {
    installReorderMocks({});
    const res = await request(app)
      .patch("/api/v1/production/ofs/5/operations/reorder")
      .send({
        expected_updated_at: "2026-07-22T09:00:00.000+02:00",
        operations: [
          { op_id: OP_2, phase: 10 },
          { op_id: OP_1, phase: 20 },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });
});

// ---------------------------------------------------------------------------
// Aperçu + génération récursive
// ---------------------------------------------------------------------------

type TreeRowSpec = {
  key: string;
  parent_key: string | null;
  piece: string;
  code: string;
  level: number;
  per_parent: number;
  cumulee: number;
  article_id?: string | null;
  is_cycle?: boolean;
};

function treeRows(specs: TreeRowSpec[]) {
  return specs.map((s) => ({
    key: s.key,
    parent_key: s.parent_key,
    bom_line_id: s.level === 0 ? null : "99999999-9999-9999-9999-999999999999",
    parent_piece_technique_id: s.parent_key ? s.parent_key.split("/").pop() ?? null : null,
    piece_technique_id: s.piece,
    article_id: s.article_id ?? null,
    code_piece: s.code,
    designation: `Piece ${s.code}`,
    version_number: 1,
    level: s.level,
    ordre_affichage: s.level * 10,
    quantite_par_parent: s.per_parent,
    quantite_cumulee: s.cumulee,
    is_cycle: s.is_cycle ?? false,
  }));
}

const DEPTH3_TREE: TreeRowSpec[] = [
  { key: PIECE_ROOT, parent_key: null, piece: PIECE_ROOT, code: "ROOT", level: 0, per_parent: 1, cumulee: 1, article_id: "11111111-1111-1111-1111-111111111111" },
  { key: `${PIECE_ROOT}/${PIECE_A}`, parent_key: PIECE_ROOT, piece: PIECE_A, code: "A", level: 1, per_parent: 2, cumulee: 2 },
  { key: `${PIECE_ROOT}/${PIECE_A}/${PIECE_B}`, parent_key: `${PIECE_ROOT}/${PIECE_A}`, piece: PIECE_B, code: "B", level: 2, per_parent: 1.5, cumulee: 3 },
  { key: `${PIECE_ROOT}/${PIECE_A}/${PIECE_B}/${PIECE_C}`, parent_key: `${PIECE_ROOT}/${PIECE_A}/${PIECE_B}`, piece: PIECE_C, code: "C", level: 3, per_parent: 4, cumulee: 12 },
];

function installGenerationMocks(opts: { tree: TreeRowSpec[]; versionForAll?: boolean; replayRow?: { id: string; request_hash: string | null; result: unknown } | null }) {
  let ofSeq = 8;
  const state = {
    ofInserts: [] as unknown[][],
    batchInserts: [] as unknown[][],
    allInserts: [] as string[],
  };
  mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
    if (q.startsWith("INSERT INTO")) state.allInserts.push(q);
    if (q.includes("WHERE idempotency_key = $1")) {
      return { rows: opts.replayRow ? [opts.replayRow] : [] };
    }
    if (q.includes("FROM public.affaire")) {
      return { rows: [{ id: "31", client_id: "001", archived_at: null }] };
    }
    if (q.includes("FROM public.pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE")) {
      return { rows: [{ id: PIECE_ROOT }] };
    }
    if (q.includes("WITH RECURSIVE tree") && q.includes("public.pieces_techniques_nomenclature")) {
      return { rows: treeRows(opts.tree) };
    }
    if (q.includes("FROM public.piece_technique_versions v") && q.includes("v.statut = 'APPLICABLE'")) {
      if (opts.versionForAll === false) return { rows: [] };
      return { rows: [{ version_id: VERSION_ID, gamme_id: null, version_interne: 1 }] };
    }
    if (q.includes("jsonb_build_object") && q.includes("'piece'")) {
      return {
        rows: [
          {
            snapshot: {
              piece: { id: PIECE_ROOT, code: "X" },
              version: { id: VERSION_ID, version_interne: 1 },
              gamme: null,
              operations: [{ id: OP_1, phase: 10, designation: "Tournage", tp: 0.5, tf_unit: 0.1, qte: 1, coef: 1 }],
              nomenclature: [],
              achats: [{ id: "aaaa1111-0000-0000-0000-000000000001", nom: "Brut alu", quantite: 2, type_achat: "MATIERE" }],
              documents: [{ id: "dddd1111-0000-0000-0000-000000000001", name: "plan.pdf", sha256: "b".repeat(64) }],
            },
          },
        ],
      };
    }
    if (q.includes("FROM public.stock_levels")) {
      return { rows: [{ article_id: "11111111-1111-1111-1111-111111111111", available: 4 }] };
    }
    if (q.toLowerCase().includes("pg_get_serial_sequence")) {
      ofSeq += 1;
      return { rows: [{ of_id: String(ofSeq) }] };
    }
    if (q.includes("public.fn_next_issued_code_value")) return { rows: [{ v: "1" }] };
    if (q.includes("INSERT INTO public.of_generation_batches")) {
      state.batchInserts.push(Array.isArray(params) ? params : []);
      return { rows: [] };
    }
    if (q.includes("INSERT INTO public.ordres_fabrication")) {
      state.ofInserts.push(Array.isArray(params) ? params : []);
      return { rows: [] };
    }
    if (q.includes("INSERT INTO public.of_operations")) return { rows: [], rowCount: 1 };
    if (q.includes("INSERT INTO public.of_technical_snapshots")) return { rows: [] };
    if (q.includes("INSERT INTO public.of_structure_snapshot")) return { rows: [] };
    if (q.includes("UPDATE public.of_generation_batches")) return { rows: [] };
    if (q.includes("INSERT INTO erp_audit_logs")) return { rows: [{ id: "1", created_at: "2026-01-01T00:00:00.000Z" }] };
    return { rows: [] };
  });
  return state;
}

describe("#170 generation preview (POST /production/ofs/generate/preview)", () => {
  it("explodes quantities exactly for quantity 26 on a depth-3 tree, without any side effect", async () => {
    const state = installGenerationMocks({ tree: DEPTH3_TREE });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .send({ source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 } });
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ nodes: 4, roots: 1, children: 3, max_level: 3 });
    const byCode = Object.fromEntries(res.body.tree.map((n: { code_piece: string; quantite_lancee: number }) => [n.code_piece, n.quantite_lancee]));
    expect(byCode).toEqual({ ROOT: 26, A: 52, B: 78, C: 312 });
    expect(res.body.source_hash).toMatch(/^[a-f0-9]{64}$/i);
    expect(res.body.blockers).toEqual([]);
    // Aucun effet de bord : ni OF, ni batch, ni code consommé.
    expect(state.ofInserts).toHaveLength(0);
    expect(state.batchInserts).toHaveLength(0);
  });

  it("reports VERSION_NOT_APPLICABLE as a blocker instead of generating", async () => {
    installGenerationMocks({ tree: DEPTH3_TREE, versionForAll: false });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .send({ source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 5 } });
    expect(res.status).toBe(200);
    expect(res.body.source_hash).toBeNull();
    expect(res.body.blockers.some((b: { code: string }) => b.code === "VERSION_NOT_APPLICABLE")).toBe(true);
    expect(res.body.readiness.production_ready).toBe(false);
  });

  it("refuses a nomenclature cycle with its full path (blocker BOM_CYCLE_DETECTED)", async () => {
    const cyclic: TreeRowSpec[] = [
      ...DEPTH3_TREE,
      { key: `${PIECE_ROOT}/${PIECE_A}/${PIECE_ROOT}`, parent_key: `${PIECE_ROOT}/${PIECE_A}`, piece: PIECE_ROOT, code: "ROOT", level: 2, per_parent: 1, cumulee: 2, is_cycle: true },
    ];
    installGenerationMocks({ tree: cyclic });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .send({ source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 1 } });
    expect(res.status).toBe(200);
    const blocker = res.body.blockers.find((b: { code: string }) => b.code === "BOM_CYCLE_DETECTED");
    expect(blocker).toBeTruthy();
    expect(blocker.structure_path).toContain(PIECE_ROOT);
    expect(res.body.readiness.production_ready).toBe(false);
  });

  it("is denied without the generate capability (403)", async () => {
    const res = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .set("x-test-role", "Operateur Atelier")
      .send({ source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 1 } });
    expect(res.status).toBe(403);
  });
});

describe("#170 recursive generation (POST /production/ofs/generate)", () => {
  it("requires an Idempotency-Key (400)", async () => {
    const res = await request(app)
      .post("/api/v1/production/ofs/generate")
      .send({
        source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 },
        expected_source_hash: "c".repeat(64),
        confirm: true,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("generates the full depth-3 tree (one OF per occurrence) and persists batch hashes — no BL, no invoice", async () => {
    // 1) aperçu pour capturer le hash source exact (mêmes mocks déterministes)
    installGenerationMocks({ tree: DEPTH3_TREE });
    const preview = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .send({ source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 } });
    expect(preview.status).toBe(200);
    const sourceHash = preview.body.source_hash as string;

    // 2) confirmation
    const state = installGenerationMocks({ tree: DEPTH3_TREE });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate")
      .set("Idempotency-Key", "of-170-generate-1")
      .send({
        source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 },
        expected_source_hash: sourceHash,
        confirm: true,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total_nodes: 4, max_level: 3, idempotent_replay: false });
    expect(res.body.of_ids).toHaveLength(4);
    expect(res.body.root_of_ids).toHaveLength(1);
    expect(res.body.child_of_ids).toHaveLength(3);
    expect(res.body.source_hash).toBe(sourceHash);
    // besoins d'achat figés, jamais de commande fournisseur/BL/facture
    expect(res.body.purchase_requirements.length).toBeGreaterThan(0);
    expect(state.allInserts.some((q) => q.toLowerCase().includes("bon_livraison"))).toBe(false);
    expect(state.allInserts.some((q) => q.toLowerCase().includes("facture"))).toBe(false);
    expect(state.allInserts.some((q) => q.toLowerCase().includes("commande_fournisseur"))).toBe(false);
    // le batch porte clé d'idempotence + request_hash + source_hash
    const batchParams = state.batchInserts[0] ?? [];
    expect(batchParams[8]).toBe("of-170-generate-1");
    expect(String(batchParams[9])).toMatch(/^[a-f0-9]{64}$/i);
    expect(String(batchParams[10])).toBe(sourceHash);
  });

  it("refuses a stale preview hash with 409 OF_PREVIEW_STALE (full rollback)", async () => {
    installGenerationMocks({ tree: DEPTH3_TREE });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate")
      .set("Idempotency-Key", "of-170-generate-2")
      .send({
        source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 },
        expected_source_hash: "d".repeat(64),
        confirm: true,
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_PREVIEW_STALE" });
  });

  it("replays the persisted batch on an identical retry (200 idempotent_replay)", async () => {
    // 1) génération initiale pour capturer le request_hash exact
    installGenerationMocks({ tree: DEPTH3_TREE });
    const preview = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .send({ source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 } });
    const sourceHash = preview.body.source_hash as string;
    const first = installGenerationMocks({ tree: DEPTH3_TREE });
    await request(app)
      .post("/api/v1/production/ofs/generate")
      .set("Idempotency-Key", "of-170-generate-3")
      .send({
        source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 },
        expected_source_hash: sourceHash,
        confirm: true,
      });
    const requestHash = String(first.batchInserts[0]?.[9] ?? "");
    expect(requestHash).toMatch(/^[a-f0-9]{64}$/i);

    // 2) retry identique : le batch persistant est rejoué tel quel
    installGenerationMocks({
      tree: DEPTH3_TREE,
      replayRow: {
        id: "batch-1",
        request_hash: requestHash,
        result: { root_of_id: 9, of_ids: [9, 10, 11, 12], root_of_ids: [9], child_of_ids: [10, 11, 12], total_nodes: 4, max_level: 3, source_hash: sourceHash, purchase_requirements: [] },
      },
    });
    const replay = await request(app)
      .post("/api/v1/production/ofs/generate")
      .set("Idempotency-Key", "of-170-generate-3")
      .send({
        source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 26 },
        expected_source_hash: sourceHash,
        confirm: true,
      });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ batch_id: "batch-1", idempotent_replay: true, of_ids: [9, 10, 11, 12] });
  });

  it("refuses reusing the key with a different payload (409 IDEMPOTENCY_KEY_REUSED)", async () => {
    installGenerationMocks({
      tree: DEPTH3_TREE,
      replayRow: { id: "batch-1", request_hash: "e".repeat(64), result: {} },
    });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate")
      .set("Idempotency-Key", "of-170-generate-4")
      .send({
        source: { type: "MANUAL", piece_technique_id: PIECE_ROOT, quantity: 27 },
        expected_source_hash: "c".repeat(64),
        confirm: true,
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("generates from an affaire source with the affaire locked and linked", async () => {
    installGenerationMocks({ tree: DEPTH3_TREE });
    const preview = await request(app)
      .post("/api/v1/production/ofs/generate/preview")
      .send({ source: { type: "AFFAIRE", affaire_id: 31, piece_technique_id: PIECE_ROOT, quantity: 2 } });
    expect(preview.status).toBe(200);
    const state = installGenerationMocks({ tree: DEPTH3_TREE });
    const res = await request(app)
      .post("/api/v1/production/ofs/generate")
      .set("Idempotency-Key", "of-170-generate-5")
      .send({
        source: { type: "AFFAIRE", affaire_id: 31, piece_technique_id: PIECE_ROOT, quantity: 2 },
        expected_source_hash: preview.body.source_hash,
        confirm: true,
      });
    expect(res.status).toBe(201);
    // le batch référence l'affaire ($5 = affaire_id)
    expect(state.batchInserts[0]?.[4]).toBe(31);
  });
});

describe("#170 bounded production receipt", () => {
  function installReceiptMocks(params: { statut: string; quantite_bonne: number; already: number }) {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM public.ordres_fabrication") && q.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              numero: "OF-2026-000005",
              piece_technique_id: PIECE_ROOT,
              article_id: "11111111-1111-1111-1111-111111111111",
              commande_ligne_id: null,
              quantite_bonne: params.quantite_bonne,
              statut: params.statut,
            },
          ],
        };
      }
      if (q.includes("FROM public.of_output_lots")) {
        return { rows: [{ received: params.already }] };
      }
      return { rows: [] };
    });
  }

  it("rejects a receipt exceeding the remaining quantity (422 OF_RECEIPT_EXCEEDS_RECEIVABLE)", async () => {
    installReceiptMocks({ statut: "EN_COURS", quantite_bonne: 10, already: 8 });
    const res = await request(app)
      .post("/api/v1/production/ofs/5/receipt")
      .set("x-test-role", "Responsable Production")
      .send({ qty_ok: 5, location_id: "88888888-8888-8888-8888-888888888888", lot_mode: "NEW" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "OF_RECEIPT_EXCEEDS_RECEIVABLE" });
  });

  it("rejects a receipt on a cancelled OF (409 OF_RECEIPT_STATUS_INVALID)", async () => {
    installReceiptMocks({ statut: "ANNULE", quantite_bonne: 10, already: 0 });
    const res = await request(app)
      .post("/api/v1/production/ofs/5/receipt")
      .set("x-test-role", "Responsable Production")
      .send({ qty_ok: 1, location_id: "88888888-8888-8888-8888-888888888888", lot_mode: "NEW" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "OF_RECEIPT_STATUS_INVALID" });
  });

  it("denies receipts to roles without the receipt capability (403)", async () => {
    const res = await request(app)
      .post("/api/v1/production/ofs/5/receipt")
      .set("x-test-role", "Comptabilite")
      .send({ qty_ok: 1, location_id: "88888888-8888-8888-8888-888888888888", lot_mode: "NEW" });
    expect(res.status).toBe(403);
  });

  it("gates traceability behind the traceability capability", async () => {
    const denied = await request(app).get("/api/v1/production/ofs/5/traceability").set("x-test-role", "Employe");
    expect(denied.status).toBe(403);
    const allowed = await request(app).get("/api/v1/production/ofs/5/traceability").set("x-test-role", "Qualite");
    expect(allowed.status).toBe(200);
  });
});
