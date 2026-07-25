// #228 — Qualité industrielle 360.
// Tests d'orchestration HTTP (pg mocké, mêmes conventions que
// production-of-170.routes.test.ts) : RBAC par capacité, refus par défaut,
// validation Zod mappée par champ, 401/403/404/422, absence de `storage_path`.

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
    // `x-test-anonymous` simule une requête non authentifiée.
    if (req.headers?.["x-test-anonymous"] === "1") {
      res.status(401).json({ success: false, code: "UNAUTHORIZED" });
      return;
    }
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

const BASE = "/api/v1/qualite/v2";
const PLAN_ID = "11111111-1111-1111-1111-111111111111";
const CONTROL_ID = "22222222-2222-2222-2222-222222222222";
const DEROGATION_ID = "33333333-3333-3333-3333-333333333333";
const NC_ID = "44444444-4444-4444-4444-444444444444";
const LOT_ID = "55555555-5555-5555-5555-555555555555";
const PIECE_ID = "66666666-6666-6666-6666-666666666666";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
});

function validPlanBody() {
  return {
    label: "Contrôle final bride",
    trigger_type: "FINAL",
    piece_technique_id: PIECE_ID,
    sampling: { rule: "FIXED", value: 3, justification: "Plan client" },
    characteristics: [
      {
        characteristic_key: "DIM-01",
        position: 1,
        label: "Diamètre",
        characteristic_type: "DIMENSIONAL",
        value_kind: "NUMERIC",
        unit: "mm",
        nominal: 20,
        tolerance_min: -0.05,
        tolerance_max: 0.05,
        criticality: "MAJOR",
        sampling: { rule: "FIXED", value: 3, justification: null },
        trigger: "FINAL",
      },
    ],
  };
}

/* ========================================================================== */
/* Authentification                                                           */
/* ========================================================================== */

describe("#228 authentification", () => {
  it.each([
    ["get", "/center"],
    ["get", "/plans"],
    ["get", "/executions"],
    ["get", "/derogations"],
  ] as const)("renvoie 401 sans authentification (%s %s)", async (method, path) => {
    const res = await request(app)[method](`${BASE}${path}`).set("x-test-anonymous", "1");
    expect(res.status).toBe(401);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* RBAC : refus par défaut                                                    */
/* ========================================================================== */

describe("#228 RBAC par capacité", () => {
  const forbiddenReads: Array<[string, string]> = [
    ["get", "/center"],
    ["get", "/plans"],
    ["get", `/plans/${PLAN_ID}`],
    ["get", "/executions"],
    ["get", `/executions/${CONTROL_ID}`],
    ["get", "/derogations"],
    ["get", `/derogations/${DEROGATION_ID}`],
  ];

  it.each(forbiddenReads)("refuse la lecture qualité à un rôle non habilité (%s %s)", async (method, path) => {
    const res = await request(app)
      [method as "get"](`${BASE}${path}`)
      .set("x-test-role", "Comptabilite");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("QUALITY_CAPABILITY_REQUIRED");
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("laisse l'atelier lire la qualité", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 });
    const res = await request(app).get(`${BASE}/plans`).set("x-test-role", "Chef d'atelier");
    expect(res.status).not.toBe(403);
  });

  it("refuse à l'atelier la publication d'un plan", async () => {
    const res = await request(app)
      .post(`${BASE}/plans/${PLAN_ID}/transitions`)
      .set("x-test-role", "Chef d'atelier")
      .send({ target_status: "PUBLISHED", expected_updated_at: "2026-07-25T10:00:00.000Z" });
    expect(res.status).toBe(403);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("refuse à l'atelier la décision de libération", async () => {
    const res = await request(app)
      .post(`${BASE}/executions/${CONTROL_ID}/decision`)
      .set("x-test-role", "Operateur Atelier")
      .send({});
    expect(res.status).toBe(403);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("refuse à l'atelier la création d'un plan", async () => {
    const res = await request(app)
      .post(`${BASE}/plans`)
      .set("x-test-role", "Operateur Atelier")
      .send(validPlanBody());
    expect(res.status).toBe(403);
  });

  it("autorise l'atelier à saisir une mesure", async () => {
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post(`${BASE}/executions/${CONTROL_ID}/measurements`)
      .set("x-test-role", "Chef d'atelier")
      .send({});
    // La capacité passe : c'est la validation Zod qui refuse un corps vide.
    expect(res.status).toBe(422);
  });

  it("exige la capacité d'approbation pour approuver une dérogation", async () => {
    const res = await request(app)
      .post(`${BASE}/derogations/${DEROGATION_ID}/transitions`)
      .set("x-test-role", "Responsable Methodes")
      .send({ target_status: "APPROVED", expected_updated_at: "2026-07-25T10:00:00.000Z" });
    expect(res.status).toBe(403);
  });

  it("laisse les méthodes soumettre une dérogation", async () => {
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post(`${BASE}/derogations/${DEROGATION_ID}/transitions`)
      .set("x-test-role", "Responsable Methodes")
      .send({ target_status: "SUBMITTED", expected_updated_at: "2026-07-25T10:00:00.000Z" });
    expect(res.status).not.toBe(403);
  });
});

/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */

describe("#228 validation Zod stricte et mappée par champ", () => {
  const role = "Responsable Qualite";

  it("refuse un plan sans axe produit", async () => {
    const body = validPlanBody();
    delete (body as Record<string, unknown>).piece_technique_id;
    const res = await request(app).post(`${BASE}/plans`).set("x-test-role", role).send(body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("QUALITY_VALIDATION_ERROR");
    expect(Object.keys(res.body.details.fields).length).toBeGreaterThan(0);
  });

  it("refuse un champ inconnu (schéma strict)", async () => {
    const res = await request(app)
      .post(`${BASE}/plans`)
      .set("x-test-role", role)
      .send({ ...validPlanBody(), injected: "x" });
    expect(res.status).toBe(422);
  });

  it("refuse un plan sans caractéristique", async () => {
    const res = await request(app)
      .post(`${BASE}/plans`)
      .set("x-test-role", role)
      .send({ ...validPlanBody(), characteristics: [] });
    expect(res.status).toBe(422);
  });

  it.each([
    ["quantité négative", { population: -5 }],
    ["quantité nulle", { population: 0 }],
    ["source inconnue", { source_type: "INVENTED" }],
    ["source vide", { source_id: "" }],
    ["unité vide", { unite: "" }],
    ["déclencheur inconnu", { trigger: "MAGIC" }],
  ])("refuse un aperçu d'exécution invalide (%s)", async (_label, override) => {
    const res = await request(app)
      .post(`${BASE}/executions/preview`)
      .set("x-test-role", role)
      .send({
        source_type: "LOT",
        source_id: LOT_ID,
        trigger: "FINAL",
        population: 10,
        unite: "pce",
        piece_technique_id: PIECE_ID,
        ...override,
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("QUALITY_VALIDATION_ERROR");
  });

  it("refuse une décision sans empreinte d'aperçu", async () => {
    const res = await request(app)
      .post(`${BASE}/executions/${CONTROL_ID}/decision`)
      .set("x-test-role", role)
      .send({
        expected_updated_at: "2026-07-25T10:00:00.000Z",
        decision: "FULL",
        qty: 10,
        unite: "pce",
        object_type: "LOT",
        object_id: LOT_ID,
      });
    expect(res.status).toBe(422);
    expect(res.body.details.fields).toHaveProperty("preview_sha256");
  });

  it.each(["not-a-hash", "ABC", "a".repeat(63), "z".repeat(64)])(
    "refuse une empreinte d'aperçu malformée (%s)",
    async (hash) => {
      const res = await request(app)
        .post(`${BASE}/executions/${CONTROL_ID}/decision`)
        .set("x-test-role", role)
        .send({
          expected_updated_at: "2026-07-25T10:00:00.000Z",
          preview_sha256: hash,
          decision: "FULL",
          qty: 10,
          unite: "pce",
          object_type: "LOT",
          object_id: LOT_ID,
        });
      expect(res.status).toBe(422);
    }
  );

  it("refuse un identifiant de route non UUID", async () => {
    const res = await request(app).get(`${BASE}/plans/not-a-uuid`).set("x-test-role", role);
    expect(res.status).toBe(422);
  });

  it("refuse une dérogation sans périmètre", async () => {
    const res = await request(app)
      .post(`${BASE}/derogations`)
      .set("x-test-role", role)
      .send({
        derogation_type: "CONCESSION",
        requirement: "Cote 12H7",
        deviation: "Écart de 0,03 mm au-dessus de la tolérance haute",
      });
    expect(res.status).toBe(422);
  });

  it("refuse une quantité maximale de dérogation sans unité", async () => {
    const res = await request(app)
      .post(`${BASE}/derogations`)
      .set("x-test-role", role)
      .send({
        derogation_type: "CONCESSION",
        lot_id: LOT_ID,
        requirement: "Cote 12H7",
        deviation: "Écart de 0,03 mm",
        max_qty: 10,
      });
    expect(res.status).toBe(422);
    expect(res.body.details.fields).toHaveProperty("unite");
  });

  it("refuse un refus de dérogation sans motif", async () => {
    const res = await request(app)
      .post(`${BASE}/derogations/${DEROGATION_ID}/transitions`)
      .set("x-test-role", role)
      .send({ target_status: "REJECTED", expected_updated_at: "2026-07-25T10:00:00.000Z" });
    expect(res.status).toBe(422);
    expect(res.body.details.fields).toHaveProperty("reason");
  });

  it("refuse une analyse 5 Why hors bornes", async () => {
    const res = await request(app)
      .put(`${BASE}/non-conformities/${NC_ID}/analysis`)
      .set("x-test-role", role)
      .send({
        expected_updated_at: "2026-07-25T10:00:00.000Z",
        method: "FIVE_WHY",
        steps: [
          { method: "FIVE_WHY", step_code: "WHY1", position: 99, question: "Pourquoi ?", answer: "Parce que" },
        ],
      });
    expect(res.status).toBe(422);
  });

  it("borne la pagination des listes", async () => {
    const res = await request(app).get(`${BASE}/plans?pageSize=5000`).set("x-test-role", role);
    expect(res.status).toBe(422);
  });

  it.each(["RESERVE", "SHIP", "INVOICE"])("accepte le but d'éligibilité %s", async (purpose) => {
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app)
      .get(`${BASE}/eligibility?purpose=${purpose}&object_type=LOT&object_id=${LOT_ID}&qty=5`)
      .set("x-test-role", role);
    expect(res.status).not.toBe(422);
  });

  it("refuse un but d'éligibilité inconnu", async () => {
    const res = await request(app)
      .get(`${BASE}/eligibility?purpose=STEAL&object_type=LOT&object_id=${LOT_ID}&qty=5`)
      .set("x-test-role", role);
    expect(res.status).toBe(422);
  });
});

/* ========================================================================== */
/* 404 et DTO                                                                 */
/* ========================================================================== */

describe("#228 ressources absentes et DTO", () => {
  const role = "Responsable Qualite";

  it("renvoie 404 pour un plan inconnu", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get(`${BASE}/plans/${PLAN_ID}`).set("x-test-role", role);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("renvoie 404 pour un contrôle inconnu", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get(`${BASE}/executions/${CONTROL_ID}`).set("x-test-role", role);
    expect(res.status).toBe(404);
  });

  it("renvoie 404 pour une dérogation inconnue", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get(`${BASE}/derogations/${DEROGATION_ID}`).set("x-test-role", role);
    expect(res.status).toBe(404);
  });

  it("ne fait jamais fuiter storage_path ni chemin local dans un DTO qualité", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ total: 1 }], rowCount: 1 });
      return Promise.resolve({
        rows: [
          {
            id: PLAN_ID,
            code: "PC-2026-000001",
            version: 1,
            label: "Contrôle final",
            status: "PUBLISHED",
            trigger_type: "FINAL",
            article_id: null,
            piece_technique_id: PIECE_ID,
            piece_version_id: null,
            famille_id: null,
            operation_code: null,
            fournisseur_id: null,
            sampling_rule: "ALL",
            sampling_value: null,
            sampling_justification: null,
            owner_user_id: null,
            revision_reason: null,
            effective_from: null,
            effective_to: null,
            supersedes_plan_id: null,
            published_at: "2026-07-01T00:00:00.000Z",
            published_by: 2,
            archived_at: null,
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
            created_by: 1,
            updated_by: 1,
            characteristic_count: 1,
          },
        ],
        rowCount: 1,
      });
    });

    const res = await request(app).get(`${BASE}/plans`).set("x-test-role", role);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/storage_path/i);
    expect(serialized).not.toMatch(/stored_name/i);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toMatch(/\/var\/cerp/i);
  });

  it("n'expose ni SQL ni stack dans une erreur serveur", async () => {
    mocks.poolQuery.mockRejectedValue(new Error('relation "public.quality_control_plan" does not exist'));
    const res = await request(app).get(`${BASE}/plans`).set("x-test-role", role);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|does not exist|stack/i);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});

/* ========================================================================== */
/* Le routeur historique reste intact                                         */
/* ========================================================================== */

describe("#228 compatibilité du routeur Qualité historique", () => {
  it("conserve le garde global du routeur historique", async () => {
    const res = await request(app).get("/api/v1/qualite/controls").set("x-test-role", "Comptabilite");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("ne capture pas les routes historiques avec le préfixe v2", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 });
    const res = await request(app).get("/api/v1/qualite/kpis").set("x-test-role", "Responsable Qualite");
    expect(res.status).not.toBe(404);
  });
});
