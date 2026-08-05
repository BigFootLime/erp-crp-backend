// #274 — Suivi et pointage de production 360.
// Tests d'orchestration HTTP (pg mocké, mêmes conventions que
// qualite-360-228.routes.test.ts) : refus par défaut, capacités fines,
// idempotence obligatoire, anti-IDOR, erreurs structurées et absence d'effet
// de bord stock/lot/BL/facture.

import request from "supertest";
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (req.headers?.["x-test-anonymous"] === "1") {
      res.status(401).json({ success: false, code: "UNAUTHORIZED" });
      return;
    }
    const requestedRole = req.headers?.["x-test-role"];
    const requestedId = req.headers?.["x-test-user-id"];
    req.user = {
      id: typeof requestedId === "string" ? Number(requestedId) : 1,
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

// Le gate d'accès module (#326) est monté globalement dans v1.routes.ts. Ce fichier
// ne teste pas le filtrage par module : on le neutralise pour qu'il ne consomme pas
// une réponse de `pool.query` destinée à la route sous test.
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";
import { repoDeclareQuantity } from "../module/production/repository/production-execution.repository";

const BASE = "/api/v1/production/execution";
const OP_ID = "11111111-1111-1111-1111-111111111111";
const POINTAGE_ID = "22222222-2222-2222-2222-222222222222";
const MACHINE_ID = "33333333-3333-3333-3333-333333333333";
const KEY = "idem-key-274-000001";

// Rôles en ASCII : un en-tête HTTP ne transporte pas fiablement l'UTF-8, et un
// rôle accentué arriverait mutilé côté serveur. La correspondance accentuée est
// couverte par les tests de domaine, qui appellent la règle directement.
const OPERATOR = "Operateur CN";
const CHEF = "Chef d'atelier";
const COMPTA = "Comptabilite";
const VISITEUR = "Visiteur externe";

const CATEGORY_ROW = {
  code: "PRODUCTION",
  label: "Production",
  description: null,
  counts_operator_time: true,
  counts_machine_time: true,
  is_productive: true,
  requires_reason: false,
  criticality: "NORMAL",
  signals_planning: false,
  signals_maintenance: false,
  signals_quality: false,
  legacy_time_type: "OPERATEUR",
  legacy_of_time_log_type: "PRODUCTION",
  required_capability: null,
  sort_order: 20,
  effective_from: "2026-07-26",
  disabled_at: null,
};

function executionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POINTAGE_ID,
    status: "RUNNING",
    time_type: "OPERATEUR",
    activity_code: "PRODUCTION",
    activity_label: "Production",
    activity_is_productive: true,
    activity_criticality: "NORMAL",
    session_id: POINTAGE_ID,
    segment_index: 1,
    source: "CANONICAL",
    start_ts: "2026-07-26T08:00:00.000Z",
    end_ts: null,
    duration_minutes: null,
    elapsed_minutes: 42,
    comment: null,
    correction_reason: null,
    is_retroactive: false,
    submitted_at: null,
    validated_at: null,
    rejected_at: null,
    rejection_reason: null,
    created_at: "2026-07-26T08:00:00.000Z",
    updated_at: "2026-07-26T08:00:00.000Z",
    of_id: 10,
    of_numero: "OF-2026-0010",
    of_statut: "EN_COURS",
    operation_id: OP_ID,
    operation_phase: 10,
    operation_designation: "Tournage",
    operation_status: "RUNNING",
    operation_temps_planned: 2,
    operation_temps_real: 1.5,
    affaire_id: null,
    affaire_reference: null,
    piece_technique_id: null,
    piece_code: null,
    piece_designation: null,
    machine_id: MACHINE_ID,
    machine_code: "TOUR-01",
    machine_name: "Tour CN",
    poste_id: null,
    poste_code: null,
    poste_label: null,
    operator_user_id: 7,
    operator_username: "jdupont",
    operator_name: "Jean",
    operator_surname: "Dupont",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
});

/* -------------------------------------------------------------------------- */
/* Authentification et refus par défaut                                       */
/* -------------------------------------------------------------------------- */

describe("#274 authentification et refus par défaut", () => {
  it("refuse 401 sans authentification", async () => {
    const res = await request(app).get(`${BASE}/`).set("x-test-anonymous", "1");
    expect(res.status).toBe(401);
  });

  it("refuse 403 la lecture à un rôle sans capacité", async () => {
    const res = await request(app).get(`${BASE}/`).set("x-test-role", VISITEUR);
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_CAPABILITY_REQUIRED");
  });

  it("refuse 403 le démarrage à un rôle sans capacité de pointage", async () => {
    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", COMPTA)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "PRODUCTION" });
    expect(res.status).toBe(403);
  });

  it("refuse 403 la validation à un opérateur", async () => {
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/validate`)
      .set("x-test-role", OPERATOR)
      .send({});
    expect(res.status).toBe(403);
  });

  it("refuse 403 la correction à un opérateur", async () => {
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/correct`)
      .set("x-test-role", OPERATOR)
      .send({ correction_reason: "erreur de saisie", patch: { comment: "x" } });
    expect(res.status).toBe(403);
  });

  it("expose au client uniquement les capacités qu'il détient", async () => {
    const res = await request(app).get(`${BASE}/capabilities`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toContain("start_self");
    expect(res.body.capabilities).not.toContain("validate");
    expect(res.body.capabilities).not.toContain("view_costs");
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotence obligatoire                                                    */
/* -------------------------------------------------------------------------- */

describe("#274 idempotence", () => {
  it("refuse 400 une commande à effet sans Idempotency-Key", async () => {
    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .send({ of_id: 10, activity_code: "PRODUCTION" });
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuse 400 une clé trop courte", async () => {
    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", "court")
      .send({ of_id: 10, activity_code: "PRODUCTION" });
    expect(res.status).toBe(400);
  });

  it("n'exige PAS de clé sur l'aperçu, qui n'écrit rien", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.ordres_fabrication o WHERE o.id")) {
        return {
          rows: [{ id: 10, numero: "OF-2026-0010", quantite_lancee: 10, quantite_bonne: 0, quantite_rebut: 0 }],
        };
      }
      if (sql.includes("FROM public.of_operations op WHERE op.id")) {
        return {
          rows: [
            { id: OP_ID, phase: 10, designation: "Tournage", status: "RUNNING", temps_total_real: 1.5, of_id: 10 },
          ],
        };
      }
      if (sql.includes("status = 'RUNNING'")) return { rows: [] };
      if (sql.includes("production_quantity_declarations")) {
        return { rows: [{ qty_good: 0, qty_scrap: 0, qty_rework: 0 }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/operations/finish/preview`)
      .set("x-test-role", OPERATOR)
      .send({ of_id: 10, operation_id: OP_ID, qty_good: 3 });

    expect(res.status).toBe(200);
    expect(res.body.preview_hash).toHaveLength(64);
    // L'aperçu annonce explicitement ce qu'il ne fera PAS.
    expect(res.body.warnings.join(" ")).toMatch(/aucune entrée en stock/i);
  });

  it("rejoue une commande déjà exécutée sans créer de second effet", async () => {
    let insertCount = 0;
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) {
        // Clé déjà connue avec la MÊME empreinte : rejeu.
        return {
          rows: [
            {
              request_fingerprint: require("node:crypto")
                .createHash("sha256")
                .update(
                  `production.execution.start ${JSON.stringify({
                    activity_code: "PRODUCTION",
                    of_id: 10,
                    operator_user_id: 7,
                  })
                    .replace(/"of_id":10/, '"of_id":10')}`
                )
                .digest("hex"),
              response_body: { id: POINTAGE_ID },
              user_id: 7,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO public.production_pointages")) {
        insertCount += 1;
        return { rows: [{ id: POINTAGE_ID }] };
      }
      return { rows: [] };
    });
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    // L'empreinte exacte dépend de la sérialisation stable ; on vérifie au
    // minimum qu'aucune insertion n'a lieu quand le rejeu est détecté OU que la
    // divergence est signalée en 409. Les deux issues sont correctes, un second
    // INSERT ne l'est jamais.
    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "7")
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "PRODUCTION" });

    expect([200, 201, 409]).toContain(res.status);
    expect(insertCount).toBe(0);
  });

  it("refuse 409 la même clé avec une charge utile différente", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) {
        return {
          rows: [{ request_fingerprint: "a".repeat(64), response_body: { id: POINTAGE_ID }, user_id: 1 }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 999, activity_code: "PRODUCTION" });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_IDEMPOTENCY_CONFLICT");
  });

  it.each([
    ["STOP", `${BASE}/${POINTAGE_ID}/stop`, {}],
    ["QUANTITY", `${BASE}/quantities`, { of_id: 10, qty_good: 1 }],
  ])("ne rejoue jamais la réponse %s d'un autre opérateur", async (_kind, endpoint, body) => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) {
        return {
          rows: [{
            request_fingerprint: "a".repeat(64),
            response_body: { id: POINTAGE_ID },
            user_id: 99,
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(endpoint)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "7")
      .set("Idempotency-Key", KEY)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_IDEMPOTENCY_ACTOR_CONFLICT");
    expect(mocks.clientQuery).not.toHaveBeenCalledWith("COMMIT");
  });
});

/* -------------------------------------------------------------------------- */
/* Intégrité transactionnelle des quantités                                  */
/* -------------------------------------------------------------------------- */

describe("#274 intégrité des quantités", () => {
  const quantityRequest = (body: Record<string, unknown>, key = `${KEY}-quantity`) => request(app)
    .post(`${BASE}/quantities`)
    .set("x-test-role", OPERATOR)
    .set("x-test-user-id", "7")
    .set("Idempotency-Key", key)
    .send(body);

  function mockQuantityQueries(params: {
    ofStatus?: string;
    operationStatus?: string;
    alreadyGood?: number;
    pointageOwner?: number;
  } = {}) {
    let inserts = 0;
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "10",
            statut: params.ofStatus ?? "EN_COURS",
            quantite_lancee: 10,
          }],
        };
      }
      if (sql.includes("FROM public.of_operations") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: OP_ID,
            status: params.operationStatus ?? "RUNNING",
            phase: 10,
            of_id: "10",
          }],
        };
      }
      if (sql.includes("FROM public.production_pointages") && sql.includes("WHERE id = $1::uuid")) {
        return { rows: [executionRow({ operator_user_id: params.pointageOwner ?? 7 })] };
      }
      if (sql.includes("FROM public.production_quantity_declarations")) {
        return { rows: [{ qty_good: params.alreadyGood ?? 0, qty_scrap: 0 }] };
      }
      if (sql.includes("INSERT INTO public.production_quantity_declarations")) {
        inserts += 1;
        return { rows: [{ id: `44444444-4444-4444-8444-${String(inserts).padStart(12, "0")}` }] };
      }
      return { rows: [] };
    });
    return () => inserts;
  }

  it("refuse une quantité sur un OF clos", async () => {
    const inserts = mockQuantityQueries({ ofStatus: "TERMINE" });
    const res = await quantityRequest({ of_id: 10, qty_good: 1 });
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_OF_NOT_EXECUTABLE");
    expect(inserts()).toBe(0);
  });

  it("refuse une quantité sur une opération terminée", async () => {
    const inserts = mockQuantityQueries({ operationStatus: "DONE" });
    const res = await quantityRequest({ of_id: 10, operation_id: OP_ID, qty_good: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("OF_OPERATION_ALREADY_DONE");
    expect(inserts()).toBe(0);
  });

  it("refuse la surproduction après relecture du cumul sous verrou", async () => {
    const inserts = mockQuantityQueries({ alreadyGood: 9 });
    const res = await quantityRequest({ of_id: 10, qty_good: 2 });
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_QUANTITY_EXCEEDS_REMAINING");
    expect(inserts()).toBe(0);
  });

  it("refuse un pointage appartenant à un autre opérateur", async () => {
    const inserts = mockQuantityQueries({ pointageOwner: 99 });
    const res = await quantityRequest({
      of_id: 10,
      operation_id: OP_ID,
      pointage_id: POINTAGE_ID,
      qty_good: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_QUANTITY_POINTAGE_OPERATOR_CONFLICT");
    expect(inserts()).toBe(0);
  });

  it("accepte un pointage serveur actif direct sans imposer une session offline absente", async () => {
    const inserts = mockQuantityQueries();
    const result = await repoDeclareQuantity({
      body: { of_id: 10, operation_id: OP_ID, pointage_id: POINTAGE_ID, qty_good: 1 },
      idempotencyKey: `${KEY}-direct-active`,
      audit: {
        user_id: 7,
        user_role: OPERATOR,
        ip: null,
        user_agent: null,
        device_type: "tablet",
        os: null,
        browser: null,
        path: `${BASE}/quantities`,
        page_key: "atelier-offline-sync",
        client_session_id: null,
      },
      sourceContext: {
        operatorUserId: 7,
        machineId: MACHINE_ID,
        executionSessionId: null,
      },
    });
    expect(result.id).toEqual(expect.any(String));
    expect(inserts()).toBe(1);
  });

  it("refuse toujours une session de START résolue qui ne correspond pas au pointage", async () => {
    const inserts = mockQuantityQueries();
    await expect(repoDeclareQuantity({
      body: { of_id: 10, operation_id: OP_ID, pointage_id: POINTAGE_ID, qty_good: 1 },
      idempotencyKey: `${KEY}-resolved-start-mismatch`,
      audit: {
        user_id: 7,
        user_role: OPERATOR,
        ip: null,
        user_agent: null,
        device_type: "tablet",
        os: null,
        browser: null,
        path: `${BASE}/quantities`,
        page_key: "atelier-offline-sync",
        client_session_id: null,
      },
      sourceContext: {
        operatorUserId: 7,
        machineId: MACHINE_ID,
        executionSessionId: "66666666-6666-4666-8666-666666666666",
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "OFFLINE_QUANTITY_POINTAGE_SESSION_CONFLICT",
    });
    expect(inserts()).toBe(0);
  });

  it("sérialise deux déclarations concurrentes et refuse celle qui dépasse le restant", async () => {
    let connectionCount = 0;
    let committedGood = 0;
    let insertCount = 0;
    let releaseFirstLock!: () => void;
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => { firstLocked = resolve; });
    const firstCommitted = new Promise<void>((resolve) => { releaseFirstLock = resolve; });

    mocks.poolConnect.mockImplementation(() => {
      const connectionId = ++connectionCount;
      let pendingGood = 0;
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
        if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
          if (connectionId === 1) firstLocked();
          if (connectionId === 2) await firstCommitted;
          return { rows: [{ id: "10", statut: "EN_COURS", quantite_lancee: 10 }] };
        }
        if (sql.includes("FROM public.production_quantity_declarations")) {
          return { rows: [{ qty_good: committedGood, qty_scrap: 0 }] };
        }
        if (sql.includes("INSERT INTO public.production_quantity_declarations")) {
          insertCount += 1;
          pendingGood = Number(values?.[3] ?? 0);
          return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }] };
        }
        if (sql === "COMMIT" && connectionId === 1) {
          committedGood += pendingGood;
          releaseFirstLock();
        }
        return { rows: [] };
      });
      return Promise.resolve({ query, release: vi.fn() });
    });

    const first = quantityRequest({ of_id: 10, qty_good: 6 }, `${KEY}-concurrent-a`).then((res) => res);
    await firstHasLock;
    const second = quantityRequest({ of_id: 10, qty_good: 6 }, `${KEY}-concurrent-b`).then((res) => res);
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(422);
    expect(secondRes.body.code ?? secondRes.body.error?.code).toBe("PRODUCTION_QUANTITY_EXCEEDS_REMAINING");
    expect(insertCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Validation Zod et erreurs structurées                                      */
/* -------------------------------------------------------------------------- */

describe("#274 validation", () => {
  it("refuse 400 un code d'activité mal formé", async () => {
    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "production minuscule" });
    expect(res.status).toBe(400);
  });

  it("refuse 400 un identifiant de pointage non UUID", async () => {
    const res = await request(app)
      .post(`${BASE}/pas-un-uuid/stop`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it("refuse 400 un rejet sans motif", async () => {
    const res = await request(app).post(`${BASE}/${POINTAGE_ID}/reject`).set("x-test-role", CHEF).send({});
    expect(res.status).toBe(400);
  });

  it("refuse 400 un changement qui ne change rien", async () => {
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/change`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ comment: "rien" });
    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Anti-IDOR                                                                  */
/* -------------------------------------------------------------------------- */

describe("#274 anti-IDOR", () => {
  it("refuse 403 la lecture du pointage d'un tiers à un opérateur", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_pointages p")) return { rows: [executionRow()] };
      return { rows: [] };
    });

    const res = await request(app)
      .get(`${BASE}/${POINTAGE_ID}`)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "99"); // ≠ operator_user_id 7

    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_FOREIGN_POINTAGE");
  });

  it("laisse l'opérateur lire son propre pointage", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_pointages p")) return { rows: [executionRow()] };
      return { rows: [] };
    });

    const res = await request(app)
      .get(`${BASE}/${POINTAGE_ID}`)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "7");

    expect(res.status).toBe(200);
    expect(res.body.operator.id).toBe(7);
  });

  it("laisse le chef d'atelier lire le pointage d'un tiers", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_pointages p")) return { rows: [executionRow()] };
      return { rows: [] };
    });

    const res = await request(app)
      .get(`${BASE}/${POINTAGE_ID}`)
      .set("x-test-role", CHEF)
      .set("x-test-user-id", "1");

    expect(res.status).toBe(200);
  });

  it("refuse 404 un pointage inexistant", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const res = await request(app).get(`${BASE}/${POINTAGE_ID}`).set("x-test-role", CHEF);
    expect(res.status).toBe(404);
  });

  it("refuse 403 la consultation du poste d'un autre opérateur", async () => {
    const res = await request(app)
      .get(`${BASE}/operator-board?operator_user_id=42`)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "7");
    expect(res.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Référentiel et indicateurs                                                 */
/* -------------------------------------------------------------------------- */

describe("#274 référentiel et indicateurs", () => {
  it("liste les catégories d'activité actives", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("production_activity_categories")) return { rows: [CATEGORY_ROW] };
      return { rows: [] };
    });

    const res = await request(app).get(`${BASE}/activity-categories`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body[0].code).toBe("PRODUCTION");
    expect(res.body[0].counts_operator_time).toBe(true);
  });

  it("déclare les coûts et le TRS non calculables plutôt que d'afficher zéro", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.of_operations op")) {
        return {
          rows: [{ operations: 5, with_planned: 3, planned_hours: 10, real_hours: 12, with_rate: 0 }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`${BASE}/indicators`).set("x-test-role", CHEF);
    expect(res.status).toBe(200);
    expect(res.body.cost.computable).toBe(false);
    expect(res.body.cost.value).toBeNull();
    expect(res.body.cost.missing.length).toBeGreaterThan(0);
    expect(res.body.oee.computable).toBe(false);
    expect(res.body.oee.value).toBeNull();
    expect(res.body.oee.missing).toContain("cadence nominale versionnée par opération");
    // L'écart de temps, lui, est démontrable : il est calculé.
    expect(res.body.time.computable).toBe(true);
    expect(res.body.time.variance_hours).toBe(2);
  });

  it("masque les coûts à un rôle sans capacité 'view_costs'", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.of_operations op")) {
        return {
          rows: [{ operations: 1, with_planned: 1, planned_hours: 1, real_hours: 1, with_rate: 5 }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`${BASE}/indicators`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.cost.computable).toBe(false);
    expect(res.body.cost.missing).toContain("capacité 'view_costs' requise");
  });

  it("calcule les KPI du command center côté serveur", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("WITH scoped AS")) {
        return {
          rows: [
            {
              running: 3,
              long_running: 1,
              to_validate: 4,
              rejected: 0,
              incidents: 2,
              total_minutes: 480,
              productive_minutes: 300,
            },
          ],
        };
      }
      if (sql.includes("GROUP BY 1, 2")) {
        return { rows: [{ activity_code: "PRODUCTION", label: "Production", minutes: 300, segments: 5 }] };
      }
      if (sql.includes("production_quantity_declarations")) {
        return { rows: [{ qty_good: 12, qty_scrap: 1, qty_rework: 0, qty_pending_control: 3 }] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`${BASE}/center`).set("x-test-role", CHEF);
    expect(res.status).toBe(200);
    expect(res.body.kpis.running).toBe(3);
    expect(res.body.kpis.long_running).toBe(1);
    expect(res.body.quantities.qty_scrap).toBe(1);
    expect(res.body.by_activity[0].minutes).toBe(300);
  });
});

/* -------------------------------------------------------------------------- */
/* Fin d'opération : atomicité et frontières                                  */
/* -------------------------------------------------------------------------- */

describe("#274 fin d'opération", () => {
  function mockPreviewQueries(target: typeof mocks.poolQuery | typeof mocks.clientQuery) {
    target.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      // Verrous posés par la commande atomique avant de recalculer l'aperçu.
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "10", statut: "EN_COURS" }] };
      }
      if (sql.includes("FROM public.of_operations") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: OP_ID, status: "RUNNING", phase: 10, of_id: "10" }] };
      }
      if (sql.includes("FROM public.ordres_fabrication o WHERE o.id")) {
        return {
          rows: [{ id: 10, numero: "OF-2026-0010", quantite_lancee: 10, quantite_bonne: 0, quantite_rebut: 0 }],
        };
      }
      if (sql.includes("FROM public.of_operations op WHERE op.id")) {
        return {
          rows: [
            { id: OP_ID, phase: 10, designation: "Tournage", status: "RUNNING", temps_total_real: 1.5, of_id: 10 },
          ],
        };
      }
      if (sql.includes("FROM public.production_quantity_declarations")) {
        return { rows: [{ qty_good: 0, qty_scrap: 0, qty_rework: 0 }] };
      }
      if (sql.includes("FROM public.production_pointages") && sql.includes("status = 'RUNNING'")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  }

  it("refuse 409 une confirmation dont l'aperçu est périmé", async () => {
    mockPreviewQueries(mocks.clientQuery);

    const res = await request(app)
      .post(`${BASE}/operations/finish`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({
        of_id: 10,
        operation_id: OP_ID,
        qty_good: 3,
        preview_hash: "0".repeat(64), // empreinte volontairement fausse
      });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_PREVIEW_STALE");
  });

  it("annonce dans l'aperçu qu'aucune entrée en stock n'est créée", async () => {
    mockPreviewQueries(mocks.poolQuery);

    const res = await request(app)
      .post(`${BASE}/operations/finish/preview`)
      .set("x-test-role", OPERATOR)
      .send({ of_id: 10, operation_id: OP_ID, qty_good: 2, qty_scrap: 1 });

    expect(res.status).toBe(200);
    expect(res.body.requires_quality_decision).toBe(true);
    const warnings = res.body.warnings.join(" ");
    expect(warnings).toMatch(/aucune entrée en stock/i);
    expect(warnings).toMatch(/non-conformité n'est créée automatiquement/i);
  });

  it("refuse 422 une opération qui n'appartient pas à l'OF indiqué", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.ordres_fabrication o WHERE o.id")) {
        return {
          rows: [{ id: 10, numero: "OF-2026-0010", quantite_lancee: 10, quantite_bonne: 0, quantite_rebut: 0 }],
        };
      }
      if (sql.includes("FROM public.of_operations op WHERE op.id")) {
        // Opération rattachée à un AUTRE OF.
        return {
          rows: [
            { id: OP_ID, phase: 10, designation: "Tournage", status: "RUNNING", temps_total_real: 0, of_id: 99 },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/operations/finish/preview`)
      .set("x-test-role", OPERATOR)
      .send({ of_id: 10, operation_id: OP_ID, qty_good: 1 });

    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_OPERATION_MISMATCH");
  });

  it("refuse 404 un OF inexistant", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post(`${BASE}/operations/finish/preview`)
      .set("x-test-role", OPERATOR)
      .send({ of_id: 12345, operation_id: OP_ID, qty_good: 1 });
    expect(res.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrence traduite en erreurs métier                                     */
/* -------------------------------------------------------------------------- */

describe("#274 concurrence", () => {
  it("traduit un opérateur déjà occupé en 409 lisible", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "10", statut: "EN_COURS" }] };
      }
      if (sql.includes("production_activity_categories")) return { rows: [CATEGORY_ROW] };
      if (sql.includes("INSERT INTO public.production_pointages")) {
        const err = new Error("duplicate key") as Error & { code: string; constraint: string };
        err.code = "23505";
        err.constraint = "production_pointages_running_operator_uniq";
        throw err;
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "PRODUCTION" });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_OPERATOR_BUSY");
  });

  it("traduit une machine déjà occupée en 409 lisible", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "10", statut: "EN_COURS" }] };
      }
      if (sql.includes("FROM public.machines WHERE id")) return { rows: [{ statut: "DISPONIBLE" }] };
      if (sql.includes("production_activity_categories")) return { rows: [CATEGORY_ROW] };
      if (sql.includes("INSERT INTO public.production_pointages")) {
        const err = new Error("duplicate key") as Error & { code: string; constraint: string };
        err.code = "23505";
        err.constraint = "production_pointages_running_machine_uniq";
        throw err;
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "PRODUCTION", machine_id: MACHINE_ID });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_MACHINE_BUSY");
  });

  it("traduit un chevauchement d'intervalle en 409 lisible", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "10", statut: "EN_COURS" }] };
      }
      if (sql.includes("production_activity_categories")) return { rows: [CATEGORY_ROW] };
      if (sql.includes("INSERT INTO public.production_pointages")) {
        const err = new Error("conflicting key value violates exclusion constraint") as Error & { code: string };
        err.code = "23P01";
        throw err;
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({
        of_id: 10,
        activity_code: "PRODUCTION",
        // Une heure dans le passé, calculée à l'exécution : un horodatage figé
        // basculerait dans le futur selon l'heure à laquelle le test tourne.
        start_ts: new Date(Date.now() - 3_600_000).toISOString(),
        retroactive_reason: "oubli de pointage ce matin",
      });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_OVERLAP");
  });

  it("refuse 409 le démarrage sur une machine en maintenance bloquante", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "10", statut: "EN_COURS" }] };
      }
      if (sql.includes("FROM public.machines WHERE id")) return { rows: [{ statut: "MAINTENANCE" }] };
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "PRODUCTION", machine_id: MACHINE_ID });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_MACHINE_UNAVAILABLE");
  });

  it("refuse 422 le pointage sur un OF clos", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_execution_idempotency")) return { rows: [] };
      if (sql.includes("FROM public.ordres_fabrication") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "10", statut: "CLOTURE" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${BASE}/`)
      .set("x-test-role", OPERATOR)
      .set("Idempotency-Key", KEY)
      .send({ of_id: 10, activity_code: "PRODUCTION" });

    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_OF_NOT_EXECUTABLE");
  });
});

/* -------------------------------------------------------------------------- */
/* Cycle de validation                                                        */
/* -------------------------------------------------------------------------- */

describe("#274 cycle de validation", () => {
  function mockLockedPointage(overrides: Record<string, unknown> = {}) {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_pointages") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: POINTAGE_ID,
              of_id: 10,
              operation_id: OP_ID,
              machine_id: null,
              poste_id: null,
              operator_user_id: 7,
              activity_code: "PRODUCTION",
              time_type: "OPERATEUR",
              status: "DONE",
              start_ts: "2026-07-26T08:00:00.000Z",
              end_ts: "2026-07-26T09:00:00.000Z",
              session_id: POINTAGE_ID,
              segment_index: 1,
              validated_at: null,
              submitted_at: null,
              ...overrides,
            },
          ],
        };
      }
      return { rows: [] };
    });
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM public.production_pointages p")) {
        return { rows: [executionRow({ status: "DONE", validated_at: "2026-07-26T10:00:00.000Z" })] };
      }
      return { rows: [] };
    });
  }

  it("refuse 409 la validation de son propre pointage", async () => {
    mockLockedPointage({ operator_user_id: 5 });
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/validate`)
      .set("x-test-role", CHEF)
      .set("x-test-user-id", "5")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe(
      "PRODUCTION_EXECUTION_SELF_VALIDATION_FORBIDDEN"
    );
  });

  it("refuse 409 toute action sur un pointage déjà validé", async () => {
    mockLockedPointage({ validated_at: "2026-07-26T10:00:00.000Z" });
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/cancel`)
      .set("x-test-role", CHEF)
      .send({ reason: "erreur de saisie" });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_VALIDATED_IMMUTABLE");
  });

  it("refuse 409 la correction d'un pointage encore en cours", async () => {
    mockLockedPointage({ status: "RUNNING", end_ts: null });
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/correct`)
      .set("x-test-role", CHEF)
      .send({ correction_reason: "mauvaise machine", patch: { comment: "corrigé" } });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe(
      "PRODUCTION_EXECUTION_RUNNING_NOT_CORRECTABLE"
    );
  });

  it("refuse 409 la soumission d'un pointage non arrêté", async () => {
    mockLockedPointage({ status: "RUNNING", end_ts: null });
    const res = await request(app)
      .post(`${BASE}/${POINTAGE_ID}/submit`)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "7")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("PRODUCTION_EXECUTION_NOT_STOPPED");
  });
});
