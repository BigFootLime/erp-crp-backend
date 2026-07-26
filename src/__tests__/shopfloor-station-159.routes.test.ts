// #159 — Poste opérateur tablette : orchestration HTTP.
//
// `pg` est mocké, comme dans `production-execution-274.routes.test.ts`. Ces
// tests prouvent ce que le domaine seul ne peut pas prouver : le câblage des
// gardes, la propagation des codes d'erreur, le cookie de session, l'idempotence
// et l'ABSENCE d'effet de bord hors du périmètre.

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

import app from "../config/app";

const BASE = "/api/v1/production/station";

const DEVICE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MACHINE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_MACHINE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OPERATION_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const HANDOVER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const SESSION_TOKEN = "jeton-de-session-opaque-pour-les-tests";
const KEY = "idem-key-159-000001";

// Rôles en ASCII : un en-tête HTTP ne transporte pas fiablement l'UTF-8.
const OPERATOR = "Operateur CN";
const CHEF = "Chef d'atelier";
const VISITEUR = "Visiteur externe";

const FUTURE = new Date(Date.now() + 3_600_000);
const NOW = new Date();

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    public_code: "TAB-0001",
    label: "Tablette tour 1",
    site: "CRP",
    workshop_zone: "USINAGE",
    assignment_mode: "MOBILE",
    machine_id: null,
    status: "ACTIVE",
    auto_lock_seconds: 180,
    session_max_seconds: 28800,
    last_seen_at: NOW,
    last_seen_app_version: "1.0.0",
    enrolled_at: NOW,
    revoked_at: null,
    revoke_reason: null,
    created_at: NOW,
    updated_at: NOW,
    machine_code: null,
    machine_name: null,
    ...overrides,
  };
}

function sessionJoinRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    device_id: DEVICE_ID,
    user_id: 7,
    machine_id: MACHINE_ID,
    identification_method: "BADGE",
    state: "ACTIVE",
    started_at: NOW,
    last_activity_at: NOW,
    expires_at: FUTURE,
    locked_at: null,
    closed_at: null,
    close_reason: null,
    correlation_id: "99999999-9999-9999-9999-999999999999",
    username: "jdupont",
    name: "Jean",
    surname: "Dupont",
    role: OPERATOR,
    ...overrides,
  };
}

/**
 * Simulateur de base minimal : il répond en fonction du SQL reçu. Il permet de
 * prouver le câblage sans base réelle, et de vérifier qu'AUCUNE requête ne
 * touche une table interdite.
 */
type Handler = (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } | null;

let handlers: Handler[] = [];
let executedSql: string[] = [];

function installDb() {
  const run = (sql: unknown, values?: unknown) => {
    const text = String(sql ?? "");
    executedSql.push(text);
    const args = Array.isArray(values) ? values : [];
    for (const handler of handlers) {
      const result = handler(text, args);
      if (result) return Promise.resolve({ rowCount: result.rows.length, ...result });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  mocks.poolQuery.mockImplementation(run);
  mocks.clientQuery.mockImplementation(run);
}

function on(match: RegExp, rows: unknown[] | ((values: unknown[]) => unknown[])): void {
  handlers.push((sql, values) =>
    match.test(sql) ? { rows: typeof rows === "function" ? rows(values) : rows } : null
  );
}

/** Session vivante par défaut, résolue depuis le cookie ou l'en-tête. */
function withLiveSession(sessionOverrides: Record<string, unknown> = {}, deviceOverrides: Record<string, unknown> = {}) {
  on(/FROM public\.operator_device_sessions s[\s\S]*JOIN public\.users u/i, [
    sessionJoinRow(sessionOverrides),
  ]);
  on(/FROM public\.production_devices d[\s\S]*WHERE d\.id = \$1/i, [deviceRow(deviceOverrides)]);
}

function station(req: request.Test, role = OPERATOR, userId = 7) {
  return req.set("x-station-session", SESSION_TOKEN).set("x-test-role", role).set("x-test-user-id", String(userId));
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers = [];
  executedSql = [];
  installDb();
  process.env.STATION_BADGE_PEPPER = "poivre-de-test-suffisamment-long";
});

/* -------------------------------------------------------------------------- */
describe("#159 — écran verrouillé et bootstrap", () => {
  it("décrit une tablette connue sans session : c'est un état normal, pas une erreur", async () => {
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [deviceRow()]);
    on(/UPDATE public\.production_devices\s*\n\s*SET last_seen_at/i, []);

    const res = await request(app).get(`${BASE}/bootstrap?device_code=TAB-0001`).set("x-test-role", OPERATOR);

    expect(res.status).toBe(200);
    expect(res.body.device.public_code).toBe("TAB-0001");
    expect(res.body.session).toBeNull();
    expect(res.body.user).toBeNull();
    expect(typeof res.body.server_time).toBe("string");
  });

  it("refuse une tablette inconnue avec un code métier distinct", async () => {
    const res = await request(app).get(`${BASE}/bootstrap?device_code=TAB-9999`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(404);
    expect(res.body.code ?? res.body.error).toContain("STATION_DEVICE_UNKNOWN");
  });

  it("refuse une tablette révoquée et une tablette désactivée séparément", async () => {
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [
      deviceRow({ status: "REVOKED", revoked_at: NOW }),
    ]);
    const revoked = await request(app).get(`${BASE}/bootstrap?device_code=TAB-0001`).set("x-test-role", OPERATOR);
    expect(revoked.status).toBe(403);
    expect(String(revoked.body.code ?? revoked.body.error)).toContain("STATION_DEVICE_REVOKED");

    handlers = [];
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [deviceRow({ status: "DISABLED" })]);
    const disabled = await request(app).get(`${BASE}/bootstrap?device_code=TAB-0001`).set("x-test-role", OPERATOR);
    expect(disabled.status).toBe(403);
    expect(String(disabled.body.code ?? disabled.body.error)).toContain("STATION_DEVICE_DISABLED");
  });

  it("rejette un code de tablette syntaxiquement invalide", async () => {
    const res = await request(app).get(`${BASE}/bootstrap?device_code=oops!!`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(400);
  });

  it("n'expose le badge comme méthode que si le poivre est configuré", async () => {
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [deviceRow()]);
    on(/UPDATE public\.production_devices/i, []);

    delete process.env.STATION_BADGE_PEPPER;
    const withoutPepper = await request(app)
      .get(`${BASE}/bootstrap?device_code=TAB-0001`)
      .set("x-test-role", OPERATOR);
    expect(withoutPepper.body.identification_methods).toEqual(["PASSWORD"]);

    process.env.STATION_BADGE_PEPPER = "poivre-de-test-suffisamment-long";
    const withPepper = await request(app)
      .get(`${BASE}/bootstrap?device_code=TAB-0001`)
      .set("x-test-role", OPERATOR);
    expect(withPepper.body.identification_methods).toContain("BADGE");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — identification", () => {
  it("ouvre une session et pose un cookie httpOnly", async () => {
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [deviceRow()]);
    on(/FROM public\.operator_badge_credentials\s*\n\s*WHERE credential_hash/i, [
      { id: "cred-1", user_id: 7, active: true, revoked_at: null, locked_until: null },
    ]);
    on(/FROM public\.v_station_machine_occupancy/i, []);
    on(/SELECT id FROM public\.production_devices WHERE id = \$1 FOR UPDATE/i, [{ id: DEVICE_ID }]);
    on(/FROM public\.operator_device_sessions s\s*\n\s*WHERE s\.device_id/i, []);
    on(/INSERT INTO public\.operator_device_sessions/i, [
      {
        id: SESSION_ID,
        device_id: DEVICE_ID,
        user_id: 7,
        machine_id: null,
        identification_method: "BADGE",
        state: "ACTIVE",
        started_at: NOW,
        last_activity_at: NOW,
        expires_at: FUTURE,
        locked_at: null,
        closed_at: null,
        close_reason: null,
        correlation_id: "corr",
      },
    ]);
    on(/UPDATE public\.operator_badge_credentials\s*\n\s*SET last_used_at/i, []);

    const res = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "BADGE", credential: "04A1B2C3D4" });

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe(SESSION_ID);
    const cookies = String(res.headers["set-cookie"] ?? "");
    expect(cookies).toContain("cerp_station_session=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    // La séparation RH est rappelée à l'opérateur à chaque badgeage.
    expect(res.body.notice).toMatch(/aucune donnée de présence RH/i);
  });

  it("donne le MÊME message pour un badge inconnu et un badge révoqué", async () => {
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [deviceRow()]);

    const unknown = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "BADGE", credential: "INCONNU" });

    handlers = [];
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [deviceRow()]);
    on(/FROM public\.operator_badge_credentials\s*\n\s*WHERE credential_hash/i, [
      { id: "cred-2", user_id: 7, active: false, revoked_at: NOW, locked_until: null },
    ]);
    on(/UPDATE public\.operator_badge_credentials/i, []);

    const revoked = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "BADGE", credential: "REVOQUE" });

    expect(unknown.status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(unknown.body.message ?? unknown.body.error).toBe(revoked.body.message ?? revoked.body.error);
  });

  it("exige un support pour BADGE et le refuse pour PASSWORD", async () => {
    const missing = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "BADGE" });
    expect(missing.status).toBe(400);

    const extraneous = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "PASSWORD", credential: "hunter2" });
    expect(extraneous.status).toBe(400);
  });

  it("exige un horodatage pour un QR — sans lui le rejeu est indétectable", async () => {
    const res = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "QR", credential: "code-qr" });
    expect(res.status).toBe(400);
  });

  it("refuse une identification sur une tablette révoquée", async () => {
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.public_code/i, [
      deviceRow({ status: "REVOKED", revoked_at: NOW }),
    ]);
    const res = await request(app)
      .post(`${BASE}/identify`)
      .set("x-test-role", OPERATOR)
      .send({ device_code: "TAB-0001", method: "BADGE", credential: "04A1B2C3D4" });
    expect(res.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — garde de session", () => {
  it("refuse toute route de poste sans jeton", async () => {
    const res = await request(app).get(`${BASE}/worklist`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(401);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_SESSION_REQUIRED");
  });

  it("refuse un jeton inconnu", async () => {
    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.status).toBe(401);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_SESSION_UNKNOWN");
  });

  it("refuse une session expirée et le DIT sans ambiguïté", async () => {
    withLiveSession({ expires_at: new Date(Date.now() - 1000) });
    on(/UPDATE public\.operator_device_sessions/i, [sessionJoinRow({ state: "EXPIRED" })]);
    on(/INSERT INTO public\.station_audit_events/i, []);

    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.status).toBe(401);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_SESSION_EXPIRED");
    // Message crucial : l'opérateur doit savoir que son pointage n'a PAS été arrêté.
    expect(String(res.body.message)).toMatch(/pointage en cours n'a pas été arrêté/i);
  });

  it("verrouille sur inactivité et ne coupe aucun pointage", async () => {
    withLiveSession({ last_activity_at: new Date(Date.now() - 10 * 60 * 1000) });
    on(/UPDATE public\.operator_device_sessions/i, [sessionJoinRow({ state: "LOCKED" })]);
    on(/INSERT INTO public\.station_audit_events/i, []);

    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.status).toBe(401);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_SESSION_LOCKED");
    expect(String(res.body.message)).toMatch(/n'a pas été arrêté/i);
  });

  it("ferme la session dès que la tablette est révoquée — révocation immédiate", async () => {
    withLiveSession({}, { status: "REVOKED", revoked_at: NOW });
    on(/UPDATE public\.operator_device_sessions/i, [sessionJoinRow({ state: "REVOKED" })]);
    on(/INSERT INTO public\.station_audit_events/i, []);

    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.status).toBe(403);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_DEVICE_REVOKED");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — capacités appliquées côté serveur", () => {
  beforeEach(() => {
    withLiveSession({ role: VISITEUR });
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
    on(/INSERT INTO public\.station_audit_events/i, []);
  });

  it("refuse la file de travail à un rôle sans capacité", async () => {
    const res = await station(request(app).get(`${BASE}/worklist`), VISITEUR);
    expect(res.status).toBe(403);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_CAPABILITY_REQUIRED");
  });

  it("refuse le dossier opérateur à un rôle sans capacité", async () => {
    const res = await station(request(app).get(`${BASE}/dossier/1/${OPERATION_ID}`), VISITEUR);
    expect(res.status).toBe(403);
  });

  it("refuse l'enrôlement d'une tablette à un opérateur", async () => {
    const res = await request(app)
      .post(`${BASE}/devices`)
      .set("x-test-role", OPERATOR)
      .send({ label: "Tablette", assignment_mode: "MOBILE" });
    expect(res.status).toBe(403);
  });

  it("refuse l'émission d'un support d'identification au chef d'atelier", async () => {
    const res = await request(app)
      .post(`${BASE}/credentials`)
      .set("x-test-role", CHEF)
      .send({ user_id: 7, credential: "04A1B2C3D4" });
    expect(res.status).toBe(403);
  });

  it("refuse le journal d'audit à un opérateur", async () => {
    const res = await request(app).get(`${BASE}/audit`).set("x-test-role", OPERATOR);
    expect(res.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — machines", () => {
  beforeEach(() => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
    on(/INSERT INTO public\.station_audit_events/i, []);
  });

  it("liste les machines avec une raison lisible pour chaque refus", async () => {
    on(/FROM public\.v_station_machine_occupancy/i, [
      {
        id: MACHINE_ID,
        code: "TOUR-01",
        name: "Tour CN",
        status: "ACTIVE",
        is_available: true,
        workshop_zone: "USINAGE",
        active_operator_user_id: null,
        active_operator_label: null,
        active_of_id: null,
        active_of_numero: null,
        active_since: null,
      },
      {
        id: OTHER_MACHINE_ID,
        code: "FRAISE-02",
        name: "Fraiseuse",
        status: "ACTIVE",
        is_available: true,
        workshop_zone: "USINAGE",
        active_operator_user_id: 99,
        active_operator_label: "Paul Martin",
        active_of_id: 42,
        active_of_numero: "OF-2026-0042",
        active_since: NOW,
      },
    ]);

    const res = await station(request(app).get(`${BASE}/machines`));
    expect(res.status).toBe(200);
    const busy = res.body.machines.find((m: { code: string }) => m.code === "FRAISE-02");
    expect(busy.selectable).toBe(false);
    expect(busy.reason).toContain("OF-2026-0042");
    // L'opérateur ne voit PAS le nom de son collègue.
    expect(busy.occupied_by).toBe("un autre opérateur");
  });

  it("révèle l'occupant au superviseur seulement", async () => {
    handlers = [];
    withLiveSession({ role: CHEF });
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
    on(/FROM public\.v_station_machine_occupancy/i, [
      {
        id: OTHER_MACHINE_ID,
        code: "FRAISE-02",
        name: "Fraiseuse",
        status: "ACTIVE",
        is_available: true,
        workshop_zone: "USINAGE",
        active_operator_user_id: 99,
        active_operator_label: "Paul Martin",
        active_of_id: 42,
        active_of_numero: "OF-2026-0042",
        active_since: NOW,
      },
    ]);

    const res = await station(request(app).get(`${BASE}/machines`), CHEF);
    expect(res.body.machines[0].occupied_by).toBe("Paul Martin");
  });

  it("refuse une machine hors périmètre au lieu de la confirmer", async () => {
    on(/FROM public\.v_station_machine_occupancy/i, []);
    const res = await station(
      request(app).post(`${BASE}/machines/confirm`).send({ machine_id: OTHER_MACHINE_ID })
    );
    expect(res.status).toBe(403);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_MACHINE_NOT_ALLOWED");
  });

  it("refuse de confirmer une machine occupée sans décision explicite", async () => {
    on(/FROM public\.v_station_machine_occupancy/i, [
      {
        id: MACHINE_ID,
        code: "TOUR-01",
        name: "Tour CN",
        status: "ACTIVE",
        is_available: true,
        workshop_zone: "USINAGE",
        active_operator_user_id: 99,
        active_operator_label: "Paul",
        active_of_id: 42,
        active_of_numero: "OF-2026-0042",
        active_since: NOW,
      },
    ]);
    const res = await station(request(app).post(`${BASE}/machines/confirm`).send({ machine_id: MACHINE_ID }));
    expect(res.status).toBe(409);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_MACHINE_BUSY");
  });

  it("interdit le changement de machine sur une tablette fixe", async () => {
    handlers = [];
    withLiveSession({}, { assignment_mode: "FIXED", machine_id: MACHINE_ID });
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);

    const res = await station(request(app).post(`${BASE}/machines/confirm`).send({ machine_id: OTHER_MACHINE_ID }));
    expect(res.status).toBe(409);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_DEVICE_FIXED");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — file de travail", () => {
  beforeEach(() => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
    on(/INSERT INTO public\.station_audit_events/i, []);
  });

  function worklistRow(overrides: Record<string, unknown> = {}) {
    return {
      operation_id: OPERATION_ID,
      phase: 10,
      designation: "Tournage",
      operation_status: "TODO",
      temps_total_planned: 2,
      temps_total_real: 0,
      of_id: 42,
      of_numero: "OF-2026-0042",
      of_statut: "EN_COURS",
      of_priority: "NORMAL",
      date_fin_prevue: "2026-08-01",
      quantite_lancee: 10,
      quantite_bonne: 0,
      quantite_rebut: 0,
      qty_pending_control: 0,
      piece_code: "P-001",
      piece_designation: "Axe",
      affaire_id: 5,
      affaire_reference: "AFF-2026-0005",
      machine_id: MACHINE_ID,
      machine_code: "TOUR-01",
      machine_name: "Tour CN",
      machine_is_available: true,
      has_pending_predecessor: false,
      active_by_user_id: null,
      has_technical_snapshot: true,
      has_plan_document: true,
      first_article_required: false,
      first_article_passed: false,
      parent_of_id: null,
      child_of_count: 0,
      child_of_pending: 0,
      ...overrides,
    };
  }

  it("renvoie une recommandation EXPLIQUÉE et un ordre justifié", async () => {
    on(/WITH candidate_ops AS/i, [worklistRow()]);

    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.status).toBe(200);
    expect(res.body.recommended_operation_id).toBe(OPERATION_ID);
    expect(res.body.recommendation_reason).toMatch(/Prêt à démarrer/i);
    expect(res.body.ordering_explanation).toMatch(/Trié par/i);
    expect(res.body.items[0].readiness).toBe("READY");
  });

  it("masque les coûts à un opérateur", async () => {
    on(/WITH candidate_ops AS/i, [worklistRow()]);
    const res = await station(request(app).get(`${BASE}/worklist`));
    const item = res.body.items[0];
    expect(item).not.toHaveProperty("hourly_rate");
    expect(item).not.toHaveProperty("cout_mo");
    expect(JSON.stringify(item)).not.toContain("hourly_rate");
  });

  it("n'affiche pas un temps prévu à zéro comme une valeur réelle", async () => {
    on(/WITH candidate_ops AS/i, [worklistRow({ temps_total_planned: 0 })]);
    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.body.items[0].planned_hours).toBeNull();
  });

  it("écarte par défaut les opérations bloquées, sauf les siennes", async () => {
    on(/WITH candidate_ops AS/i, [
      worklistRow({ has_technical_snapshot: false }),
      worklistRow({ operation_id: "11111111-1111-1111-1111-111111111111", active_by_user_id: 7 }),
    ]);
    const res = await station(request(app).get(`${BASE}/worklist`));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].mine).toBe(true);
  });

  it("montre les opérations bloquées à la demande, avec leur cause", async () => {
    on(/WITH candidate_ops AS/i, [worklistRow({ has_technical_snapshot: false })]);
    const res = await station(request(app).get(`${BASE}/worklist?include_blocked=true`));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].readiness).toBe("BLOCKED");
    expect(res.body.items[0].readiness_reasons.map((r: { code: string }) => r.code)).toContain(
      "NO_TECHNICAL_SNAPSHOT"
    );
  });

  it("borne la taille de page demandée par le client", async () => {
    const res = await station(request(app).get(`${BASE}/worklist?limit=5000`));
    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — scan", () => {
  beforeEach(() => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
  });

  it("résout un numéro d'OF vers son opération ouverte", async () => {
    on(/FROM public\.ordres_fabrication o\s*\n\s*WHERE o\.numero/i, [
      { id: 42, numero: "OF-2026-0042", operation_id: OPERATION_ID, phase: 10 },
    ]);
    const res = await station(request(app).post(`${BASE}/scan`).send({ code: "OF-2026-0042" }));
    expect(res.status).toBe(200);
    expect(res.body.operation_id).toBe(OPERATION_ID);
  });

  it("refuse un code inconnu au lieu de deviner", async () => {
    const res = await station(request(app).post(`${BASE}/scan`).send({ code: "XX-INCONNU" }));
    expect(res.status).toBe(404);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_SCAN_UNRESOLVED");
  });

  it("signale un OF sans opération ouverte plutôt que d'ouvrir un dossier vide", async () => {
    on(/FROM public\.ordres_fabrication o\s*\n\s*WHERE o\.numero/i, [
      { id: 42, numero: "OF-2026-0042", operation_id: null, phase: null },
    ]);
    const res = await station(request(app).post(`${BASE}/scan`).send({ code: "OF-2026-0042" }));
    expect(res.status).toBe(409);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_SCAN_NO_OPEN_OPERATION");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — transmission de poste", () => {
  beforeEach(() => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
    on(/INSERT INTO public\.station_audit_events/i, []);
  });

  it("exige une clé d'idempotence", async () => {
    const res = await station(request(app).post(`${BASE}/handovers`).send({ incoming_user_id: 9 }));
    expect(res.status).toBe(400);
    expect(String(res.body.code ?? res.body.error)).toContain("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuse une transmission à soi-même", async () => {
    const res = await station(
      request(app).post(`${BASE}/handovers`).set("Idempotency-Key", KEY).send({ incoming_user_id: 7 })
    );
    expect(res.status).toBe(400);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_HANDOVER_SAME_USER");
  });

  it("crée la transmission et rappelle qu'elle n'écrit rien en RH", async () => {
    on(/SELECT id FROM public\.production_shift_handovers WHERE idempotency_key/i, []);
    on(/SELECT 1 FROM public\.users WHERE id/i, [{ "?column?": 1 }]);
    on(/INSERT INTO public\.production_shift_handovers/i, [{ id: HANDOVER_ID }]);
    on(/FROM public\.production_shift_handovers h/i, [
      {
        id: HANDOVER_ID,
        device_id: DEVICE_ID,
        machine_id: MACHINE_ID,
        machine_code: "TOUR-01",
        of_id: 42,
        of_numero: "OF-2026-0042",
        operation_id: OPERATION_ID,
        pointage_id: null,
        outgoing_user_id: 7,
        incoming_user_id: 9,
        outgoing_label: "Jean Dupont",
        incoming_label: "Paul Martin",
        machine_state: "RUNNING",
        qty_done: 4,
        defects: null,
        tooling_left: "Plaquette neuve",
        remaining_actions: "Finir la série",
        comment: null,
        created_at: NOW,
        acknowledged_at: null,
      },
    ]);

    const res = await station(
      request(app)
        .post(`${BASE}/handovers`)
        .set("Idempotency-Key", KEY)
        .send({ incoming_user_id: 9, machine_state: "RUNNING", qty_done: 4 })
    );

    expect(res.status).toBe(201);
    expect(res.body.handover.id).toBe(HANDOVER_ID);
    expect(res.body.notice).toMatch(/aucune donnée de présence RH/i);
  });

  it("rejoue la même clé sans créer de doublon", async () => {
    on(/SELECT id FROM public\.production_shift_handovers WHERE idempotency_key/i, [{ id: HANDOVER_ID }]);
    on(/FROM public\.production_shift_handovers h/i, [
      {
        id: HANDOVER_ID,
        device_id: DEVICE_ID,
        machine_id: MACHINE_ID,
        machine_code: "TOUR-01",
        of_id: 42,
        of_numero: "OF-2026-0042",
        operation_id: OPERATION_ID,
        pointage_id: null,
        outgoing_user_id: 7,
        incoming_user_id: 9,
        outgoing_label: "Jean",
        incoming_label: "Paul",
        machine_state: "RUNNING",
        qty_done: null,
        defects: null,
        tooling_left: null,
        remaining_actions: null,
        comment: null,
        created_at: NOW,
        acknowledged_at: null,
      },
    ]);

    const res = await station(
      request(app).post(`${BASE}/handovers`).set("Idempotency-Key", KEY).send({ incoming_user_id: 9 })
    );
    expect(res.status).toBe(201);
    expect(res.body.handover.id).toBe(HANDOVER_ID);
    const inserts = executedSql.filter((sql) => /INSERT INTO public\.production_shift_handovers/i.test(sql));
    expect(inserts).toHaveLength(0);
  });

  it("refuse l'accusé de lecture d'une transmission destinée à un tiers", async () => {
    on(/FROM public\.production_shift_handovers h/i, [
      {
        id: HANDOVER_ID,
        device_id: null,
        machine_id: null,
        machine_code: null,
        of_id: null,
        of_numero: null,
        operation_id: null,
        pointage_id: null,
        outgoing_user_id: 8,
        incoming_user_id: 9,
        outgoing_label: "A",
        incoming_label: "B",
        machine_state: "UNKNOWN",
        qty_done: null,
        defects: null,
        tooling_left: null,
        remaining_actions: null,
        comment: null,
        created_at: NOW,
        acknowledged_at: null,
      },
    ]);
    const res = await station(request(app).post(`${BASE}/handovers/${HANDOVER_ID}/acknowledge`).send({}));
    expect(res.status).toBe(403);
    expect(String(res.body.code ?? res.body.error)).toContain("STATION_HANDOVER_NOT_ADDRESSEE");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — session : verrouiller et fermer", () => {
  beforeEach(() => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET last_activity_at/i, []);
    on(/INSERT INTO public\.station_audit_events/i, []);
  });

  it("verrouille sans arrêter le pointage et le DIT", async () => {
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET state = \$2/i, [
      { ...sessionJoinRow({ state: "LOCKED", locked_at: NOW }) },
    ]);
    on(/FROM public\.production_pointages p\s*\n\s*LEFT JOIN public\.ordres_fabrication/i, [
      {
        id: "p1",
        of_id: 42,
        of_numero: "OF-2026-0042",
        operation_id: OPERATION_ID,
        phase: 10,
        designation: "Tournage",
        machine_id: MACHINE_ID,
        machine_code: "TOUR-01",
        machine_name: "Tour CN",
        activity_code: "PRODUCTION",
        activity_label: "Production",
        is_productive: true,
        start_ts: NOW,
        session_id: null,
        segment_index: 1,
        elapsed_minutes: 12,
      },
    ]);

    const res = await station(request(app).post(`${BASE}/sessions/lock`).send({ reason: "MANUAL" }));
    expect(res.status).toBe(200);
    expect(res.body.execution_still_running).toBe(true);
    expect(res.body.notice).toMatch(/pointage continue/i);
  });

  it("avertit à la fermeture quand un pointage tourne encore", async () => {
    on(/FROM public\.production_pointages p\s*\n\s*LEFT JOIN public\.ordres_fabrication/i, [
      {
        id: "p1",
        of_id: 42,
        of_numero: "OF-2026-0042",
        operation_id: OPERATION_ID,
        phase: 10,
        designation: "Tournage",
        machine_id: MACHINE_ID,
        machine_code: "TOUR-01",
        machine_name: "Tour CN",
        activity_code: "PRODUCTION",
        activity_label: "Production",
        is_productive: true,
        start_ts: NOW,
        session_id: null,
        segment_index: 1,
        elapsed_minutes: 12,
      },
    ]);
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET state = \$2/i, [
      { ...sessionJoinRow({ state: "CLOSED", closed_at: NOW }) },
    ]);

    const res = await station(request(app).post(`${BASE}/sessions/close`).send({ reason: "SHIFT_END" }));
    expect(res.status).toBe(200);
    expect(res.body.notice).toMatch(/toujours en cours/i);
    expect(String(res.headers["set-cookie"] ?? "")).toContain("cerp_station_session=;");
  });

  it("signale une dérive d'horloge sans jamais l'utiliser pour un calcul", async () => {
    on(/UPDATE public\.production_devices/i, []);
    const res = await station(
      request(app)
        .post(`${BASE}/sessions/heartbeat`)
        .send({ client_time: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
    );
    expect(res.status).toBe(200);
    expect(res.body.clock_drift_seconds).toBeGreaterThan(500);
    expect(res.body.clock_warning).toMatch(/décalée/i);
    expect(typeof res.body.server_time).toBe("string");
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — frontières inter-modules", () => {
  const FORBIDDEN = [
    /INSERT INTO public\.hr_/i,
    /UPDATE public\.hr_/i,
    /INSERT INTO public\.stock_movements/i,
    /INSERT INTO public\.stock_reservations/i,
    /INSERT INTO public\.lots/i,
    /INSERT INTO public\.bons_livraison/i,
    /INSERT INTO public\.factures/i,
    /INSERT INTO public\.production_pointages/i,
    /UPDATE public\.production_pointages/i,
    /INSERT INTO public\.production_quantity_declarations/i,
  ];

  it("aucun parcours de poste n'écrit hors de son périmètre", async () => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions/i, [sessionJoinRow()]);
    on(/INSERT INTO public\.station_audit_events/i, []);
    on(/WITH candidate_ops AS/i, []);
    on(/FROM public\.v_station_machine_occupancy/i, []);
    on(/FROM public\.production_shift_handovers h/i, []);
    on(/UPDATE public\.production_devices/i, []);

    await station(request(app).get(`${BASE}/worklist`));
    await station(request(app).get(`${BASE}/machines`));
    await station(request(app).get(`${BASE}/handovers`));
    await station(request(app).post(`${BASE}/sessions/heartbeat`).send({}));
    await station(request(app).post(`${BASE}/sessions/lock`).send({}));

    expect(executedSql.length).toBeGreaterThan(0);
    for (const sql of executedSql) {
      for (const pattern of FORBIDDEN) {
        expect(sql).not.toMatch(pattern);
      }
    }
  });

  it("le module ne duplique aucune commande d'exécution #274", async () => {
    withLiveSession();
    on(/UPDATE public\.operator_device_sessions/i, []);

    for (const path of ["", "/pause", "/resume", "/stop", "/quantities"]) {
      const res = await station(request(app).post(`${BASE}${path}`).set("Idempotency-Key", KEY).send({}));
      expect(res.status).toBe(404);
    }
  });
});

/* -------------------------------------------------------------------------- */
describe("#159 — administration des tablettes", () => {
  it("enrôle une tablette avec un code généré par la BASE", async () => {
    on(/SELECT public\.fn_production_device_next_public_code/i, [{ code: "TAB-0007" }]);
    on(/INSERT INTO public\.production_devices/i, [{ id: DEVICE_ID }]);
    on(/INSERT INTO public\.station_audit_events/i, []);
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.id/i, [deviceRow({ public_code: "TAB-0007" })]);

    const res = await request(app)
      .post(`${BASE}/devices`)
      .set("x-test-role", "Administrateur Systeme et Reseau")
      .send({ label: "Tablette tour 1", assignment_mode: "MOBILE" });

    expect(res.status).toBe(201);
    expect(res.body.device.public_code).toBe("TAB-0007");
    // Le client n'a JAMAIS proposé le code : il a été alloué côté base.
    const insert = executedSql.find((sql) => /INSERT INTO public\.production_devices/i.test(sql));
    expect(insert).toBeDefined();
  });

  it("refuse une tablette fixe sans machine", async () => {
    const res = await request(app)
      .post(`${BASE}/devices`)
      .set("x-test-role", "Administrateur Systeme et Reseau")
      .send({ label: "Tablette", assignment_mode: "FIXED" });
    expect(res.status).toBe(400);
  });

  it("borne le verrouillage automatique demandé", async () => {
    const res = await request(app)
      .post(`${BASE}/devices`)
      .set("x-test-role", "Administrateur Systeme et Reseau")
      .send({ label: "Tablette", assignment_mode: "MOBILE", auto_lock_seconds: 99999 });
    expect(res.status).toBe(400);
  });

  it("révoque et ferme les sessions SANS arrêter les pointages", async () => {
    on(/UPDATE public\.production_devices\s*\n\s*SET status = 'REVOKED'/i, [{ id: DEVICE_ID }]);
    on(/UPDATE public\.operator_device_sessions\s*\n\s*SET state = 'REVOKED'/i, [{ id: SESSION_ID }]);
    on(/INSERT INTO public\.station_audit_events/i, []);
    on(/FROM public\.production_devices d[\s\S]*WHERE d\.id/i, [
      deviceRow({ status: "REVOKED", revoked_at: NOW }),
    ]);

    const res = await request(app)
      .post(`${BASE}/devices/${DEVICE_ID}/revoke`)
      .set("x-test-role", "Administrateur Systeme et Reseau")
      .send({ reason: "Tablette perdue en atelier" });

    expect(res.status).toBe(200);
    expect(res.body.closed_sessions).toBe(1);
    expect(res.body.notice).toMatch(/ne sont pas arrêtés/i);
    for (const sql of executedSql) {
      expect(sql).not.toMatch(/UPDATE public\.production_pointages/i);
    }
  });

  it("exige un motif pour révoquer", async () => {
    const res = await request(app)
      .post(`${BASE}/devices/${DEVICE_ID}/revoke`)
      .set("x-test-role", "Administrateur Systeme et Reseau")
      .send({});
    expect(res.status).toBe(400);
  });

  it("n'expose jamais l'empreinte d'un support d'identification", async () => {
    on(/FROM public\.operator_badge_credentials\s*\n\s*WHERE user_id/i, [
      {
        id: "cred-1",
        credential_type: "BADGE_NFC",
        label: "Badge bleu",
        active: true,
        issued_at: NOW,
      },
    ]);
    const res = await request(app)
      .get(`${BASE}/credentials/7`)
      .set("x-test-role", "Administrateur Systeme et Reseau");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("credential_hash");
  });

  it("refuse à un opérateur de lister les supports d'un tiers", async () => {
    const res = await request(app)
      .get(`${BASE}/credentials/9`)
      .set("x-test-role", OPERATOR)
      .set("x-test-user-id", "7");
    expect(res.status).toBe(403);
  });
});
