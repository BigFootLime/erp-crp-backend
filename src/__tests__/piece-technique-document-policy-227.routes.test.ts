/**
 * #227 — routes : RBAC réel de la validation d'indice, idempotence de création,
 * dossier documentaire et brouillons privés.
 *
 * Seul `authenticateToken` est simulé (il faut bien injecter un rôle) : `authorizeRole`
 * est le VRAI middleware, sinon le test ne prouverait rien du refus.
 */
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
  const pool = { on: emitter.on.bind(emitter), query: mocks.poolQuery, connect: mocks.poolConnect };
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

/**
 * Les rôles CERP portent des accents (« Responsable Qualité », « Études-Méthodes ») et un
 * en-tête HTTP est de l'ISO-8859-1 : transporté brut, « Qualité » arrive en « QualitÃ© »
 * et le test accuserait le RBAC d'un défaut qui n'existe pas. En production le rôle vient
 * du JWT (JSON, UTF-8), jamais d'un en-tête. On encode donc le rôle pour le test.
 */
const roleHeader = (role: string) => encodeURIComponent(role);

// `authorizeRole` reste le vrai middleware — c'est lui qui est sous test.
vi.mock("../module/auth/middlewares/auth.middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/auth/middlewares/auth.middleware")>();
  return {
    ...actual,
    authenticateToken: (
      req: { user?: unknown; headers: Record<string, unknown> },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void
    ) => {
      const raw = typeof req.headers["x-test-role"] === "string" ? (req.headers["x-test-role"] as string) : "";
      if (!raw) {
        res.status(401).json({ error: "Token manquant ou invalide" });
        return;
      }
      const role = decodeURIComponent(raw);
      const extra = typeof req.headers["x-test-roles"] === "string" ? (req.headers["x-test-roles"] as string) : "";
      req.user = {
        id: 42,
        username: "t.martin",
        email: "t@crp.test",
        role,
        roles: extra
          ? extra
              .split(",")
              .map((r) => decodeURIComponent(r.trim()))
              .filter(Boolean)
          : undefined,
      };
      next();
    },
  };
});

vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";
import { authoritativePdfQueueDbMock } from "./helpers/authoritative-pdf-queue-db-mock";

const PIECE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("#227 — validation d'un indice : qui passe, qui est refusé", () => {
  const url = `/api/v1/pieces-techniques/${PIECE_ID}/versions/${VERSION_ID}/status`;

  it.each([
    ["Directeur"],
    ["Responsable Qualité"],
    ["Responsable Programmation"],
    ["Administrateur Systeme et Reseau"],
  ])("n'oppose plus « Accès interdit » à un %s", async (role) => {
    const res = await request(app)
      .patch(url)
      .set("x-test-role", roleHeader(role))
      .send({ next_statut: "EN_VALIDATION" });

    // La suite du traitement dépend de la base simulée ; ce qui est prouvé ici, c'est
    // que le garde RBAC n'a PAS coupé la requête.
    expect(res.status).not.toBe(403);
  });

  it.each([["Employee"], ["Secretaire"], ["Responsable RH"]])("refuse un %s avec 403", async (role) => {
    const res = await request(app)
      .patch(url)
      .set("x-test-role", roleHeader(role))
      .send({ next_statut: "EN_VALIDATION" });

    expect(res.status).toBe(403);
  });

  it("refuse un rôle inventé contenant « admin » — plus de comparaison par sous-chaîne", async () => {
    const res = await request(app)
      .patch(url)
      .set("x-test-role", roleHeader("Stagiaire admin"))
      .send({ next_statut: "EN_VALIDATION" });

    expect(res.status).toBe(403);
  });

  it("accepte un rôle complémentaire (#315) sur un rôle principal non habilité", async () => {
    const res = await request(app)
      .patch(url)
      .set("x-test-role", roleHeader("Employee"))
      .set("x-test-roles", roleHeader("Qualité"))
      .send({ next_statut: "EN_VALIDATION" });

    expect(res.status).not.toBe(403);
  });

  it("refuse un utilisateur non authentifié avec 401, pas 403", async () => {
    const res = await request(app).patch(url).send({ next_statut: "EN_VALIDATION" });
    expect(res.status).toBe(401);
  });
});

describe("#227 — politique documentaire : écriture réservée", () => {
  it("refuse la pose d'une politique à un Responsable Programmation", async () => {
    const res = await request(app)
      .put("/api/v1/pieces-techniques/document-policy/045")
      .set("x-test-role", roleHeader("Responsable Programmation"))
      .send({ policy: "REQUIRED_FOR_ALL_LINKED_PT", selected_type_codes: [] });

    expect(res.status).toBe(403);
  });

  it("laisse passer un Responsable Qualité", async () => {
    const res = await request(app)
      .put("/api/v1/pieces-techniques/document-policy/045")
      .set("x-test-role", roleHeader("Responsable Qualité"))
      .send({ policy: "REQUIRED_FOR_ALL_LINKED_PT", selected_type_codes: [] });

    expect(res.status).not.toBe(403);
  });

  it("rejette une politique inconnue avec 400 — pas de valeur libre", async () => {
    const res = await request(app)
      .put("/api/v1/pieces-techniques/document-policy/045")
      .set("x-test-role", roleHeader("Directeur"))
      .send({ policy: "DOCUMENTS_COMPLETS" });

    expect(res.status).toBe(400);
  });

  it("la lecture de la politique reste ouverte aux lecteurs du module", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        {
          client_id: "045",
          company_name: "ACME",
          document_policy: "PER_PT_CRITICAL",
          document_policy_updated_at: "2026-07-29T10:00:00.000Z",
          document_policy_updated_by: 1,
          selected: ["PLAN"],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/api/v1/pieces-techniques/document-policy/045")
      .set("x-test-role", roleHeader("Employee"));

    expect(res.status).toBe(200);
    expect(res.body.policy).toBe("PER_PT_CRITICAL");
    expect(res.body.policy_label).toBeTruthy();
  });
});

describe("#227 — référentiel des types de documents", () => {
  it("expose les types actifs et les trois politiques nommées", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        { code: "PLAN", label: "Plan", description: null, ged_class_key: "PLAN_CLIENT", is_system: true, is_active: true, sort_order: 10 },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/api/v1/pieces-techniques/document-types").set("x-test-role", roleHeader("Employee"));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.policies.map((p: { value: string }) => p.value)).toEqual([
      "NONE",
      "REQUIRED_FOR_ALL_LINKED_PT",
      "PER_PT_CRITICAL",
    ]);
  });

  it("une base sans le référentiel renvoie une liste vide, pas une 500", async () => {
    const undefinedTable = Object.assign(new Error('relation "public.piece_document_types" does not exist'), {
      code: "42P01",
    });
    mocks.poolQuery.mockRejectedValue(undefinedTable);

    const res = await request(app).get("/api/v1/pieces-techniques/document-types").set("x-test-role", roleHeader("Employee"));

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("refuse la création d'un type à un rôle non habilité", async () => {
    const res = await request(app)
      .post("/api/v1/pieces-techniques/document-types")
      .set("x-test-role", roleHeader("Responsable Programmation"))
      .send({ code: "CERTIF_SOUDURE", label: "Certificat de soudure" });

    expect(res.status).toBe(403);
  });

  it("rejette un code de type mal formé", async () => {
    const res = await request(app)
      .post("/api/v1/pieces-techniques/document-types")
      .set("x-test-role", roleHeader("Directeur"))
      .send({ code: "certif soudure", label: "Certificat de soudure" });

    expect(res.status).toBe(400);
  });
});

describe("#227 — idempotence de création : le double clic ne crée pas deux pièces", () => {
  const body = {
    client_id: "045",
    famille_id: "33333333-3333-4333-8333-333333333333",
    name_piece: "Carter",
    designation: "Carter aluminium",
    plan_reference: "10233",
    indice_externe: "000",
    prix_unitaire: 0,
    statut: "DRAFT",
    en_fabrication: false,
    ensemble: false,
  };

  const replayBom = {
    id: "44444444-4444-4444-8444-444444444444",
    child_piece_id: "55555555-5555-4555-8555-555555555555",
    rang: 10,
    quantite: 2,
    repere: "R1",
    designation: "Sous-ensemble",
  };
  const replayOperation = {
    id: "66666666-6666-4666-8666-666666666666",
    phase: 10,
    designation: "Usinage",
    designation_2: null,
    cf_id: null,
    prix: 0,
    coef: 1,
    tp: 1,
    tf_unit: 2,
    qte: 1,
    taux_horaire: 50,
    temps_total: 3,
    cout_mo: 150,
  };
  const replayAchat = {
    id: "77777777-7777-4777-8777-777777777777",
    phase: 10,
    type_achat: "MATIERE",
    famille_piece_id: null,
    nom: "Aluminium",
    fournisseur_id: null,
    fournisseur_nom: null,
    fournisseur_code: null,
    quantite: 1,
    quantite_brut_mm: null,
    longueur_mm: null,
    coefficient_chute: null,
    quantite_pieces: null,
    prix_par_quantite: null,
    tarif: null,
    prix: 10,
    unite_prix: "kg",
    pu_achat: 10,
    tva_achat: 20,
    total_achat_ht: 10,
    total_achat_ttc: 12,
    designation: "Aluminium",
    designation_2: null,
    designation_3: null,
  };

  it("rejette une clé d'idempotence malformée", async () => {
    const res = await request(app)
      .post("/api/v1/pieces-techniques")
      .set("x-test-role", roleHeader("Directeur"))
      .set("Idempotency-Key", "abc")
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error).toBeTruthy();
  });

  it("rejoue la même clé et renvoie la pièce déjà créée, en 200 et non en 201", async () => {
    // 1er appel du contrôleur : lecture de la table d'idempotence -> rejeu trouvé.
    // Le hash doit correspondre à celui du corps validé, on le calcule comme le serveur.
    const { createPieceTechniqueSchema } = await import(
      "../module/pieces-techniques/validators/pieces-techniques.validators"
    );
    const parsed = createPieceTechniqueSchema.parse({ body });
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(JSON.stringify(parsed.body)).digest("hex");

    mocks.poolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("piece_technique_create_idempotence")) {
        return Promise.resolve({
          rows: [{ piece_technique_id: PIECE_ID, request_hash: hash }],
          rowCount: 1,
        });
      }
      if (String(sql).includes("FROM pieces_techniques_nomenclature")) {
        return Promise.resolve({ rows: [replayBom], rowCount: 1 });
      }
      if (String(sql).includes("FROM pieces_techniques_operations")) {
        return Promise.resolve({ rows: [replayOperation], rowCount: 1 });
      }
      if (String(sql).includes("FROM pieces_techniques_achats")) {
        return Promise.resolve({ rows: [replayAchat], rowCount: 1 });
      }
      if (String(sql).includes("FROM pieces_techniques p") || String(sql).includes("FROM public.pieces_techniques p")) {
        return Promise.resolve({
          rows: [
            {
              id: PIECE_ID,
              article_id: null,
              root_piece_technique_id: PIECE_ID,
              parent_piece_technique_id: null,
              version_number: 1,
              created_at: "2026-07-29T10:00:00.000Z",
              updated_at: "2026-07-29T10:00:00.000Z",
              client_id: "045",
              created_by: 42,
              updated_by: 42,
              famille_id: body.famille_id,
              name_piece: "Carter",
              code_piece: "045-10233-000",
              designation: "Carter aluminium",
              designation_2: null,
              prix_unitaire: 0,
              statut: "DRAFT",
              en_fabrication: 0,
              cycle: null,
              cycle_fabrication: null,
              code_client: null,
              client_name: null,
              ensemble: false,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .post("/api/v1/pieces-techniques")
      .set("x-test-role", roleHeader("Directeur"))
      .set("Idempotency-Key", "wizard-375-abcdef01")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PIECE_ID);
    expect(res.body.bom).toEqual([expect.objectContaining({ id: replayBom.id })]);
    expect(res.body.operations).toEqual([expect.objectContaining({ id: replayOperation.id })]);
    expect(res.body.achats).toEqual([expect.objectContaining({ id: replayAchat.id })]);
    // Aucune connexion transactionnelle : la pièce n'a PAS été recréée.
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("refuse la réutilisation d'une clé avec un contenu différent", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("piece_technique_create_idempotence")) {
        return Promise.resolve({
          rows: [{ piece_technique_id: PIECE_ID, request_hash: "f".repeat(64) }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .post("/api/v1/pieces-techniques")
      .set("x-test-role", roleHeader("Directeur"))
      .set("Idempotency-Key", "wizard-375-abcdef01")
      .send(body);

    expect(res.status).toBe(409);
  });

  it.each([
    {
      caseName: "rejoue en 200 deux créations concurrentes identiques",
      secondBody: body,
      expectedCode: null,
    },
    {
      caseName: "refuse en 409 deux créations concurrentes de payloads différents",
      secondBody: { ...body, designation: "Carter aluminium révisé" },
      expectedCode: "IDEMPOTENCY_KEY_REUSED",
    },
  ])("#309 — $caseName", async ({ secondBody, expectedCode }) => {
    const idempotencyKey = "wizard-309-concurrent-01";
    let earlyReadCount = 0;
    let releaseEarlyReads: (() => void) | undefined;
    const bothEarlyReads = new Promise<void>((resolve) => {
      releaseEarlyReads = resolve;
    });
    let stored:
      | { key: string; requestHash: string; pieceId: string; core: Record<string, unknown> }
      | null = null;
    const transactionQueries: string[][] = [];
    const releases: ReturnType<typeof vi.fn>[] = [];
    let advisoryTail = Promise.resolve();

    // Force les DEUX contrôleurs à observer « aucune clé » avant de laisser les
    // transactions avancer : c'est exactement la fenêtre de course de la régression.
    mocks.poolQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("piece_technique_create_idempotence")) {
        earlyReadCount += 1;
        if (earlyReadCount <= 2) {
          if (earlyReadCount === 2) releaseEarlyReads?.();
          await bothEarlyReads;
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: stored
            ? [{ piece_technique_id: stored.pieceId, request_hash: stored.requestHash }]
            : [],
          rowCount: stored ? 1 : 0,
        };
      }
      if (query.includes("FROM pieces_techniques p") && stored) {
        return { rows: [stored.core], rowCount: 1 };
      }
      if (query.includes("FROM pieces_techniques_nomenclature")) {
        return { rows: [replayBom], rowCount: 1 };
      }
      if (query.includes("FROM pieces_techniques_operations")) {
        return { rows: [replayOperation], rowCount: 1 };
      }
      if (query.includes("FROM pieces_techniques_achats")) {
        return { rows: [replayAchat], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    mocks.poolConnect.mockImplementation(async () => {
      const queries: string[] = [];
      transactionQueries.push(queries);
      let localCore: Record<string, unknown> | null = null;
      let releaseAdvisory: (() => void) | null = null;
      const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
        const statement = String(sql);
        queries.push(statement);
        const authoritativePdf = authoritativePdfQueueDbMock(sql, params);
        if (authoritativePdf) return authoritativePdf;
        if (statement === "BEGIN") {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("pg_advisory_xact_lock")) {
          const previous = advisoryTail;
          advisoryTail = new Promise<void>((resolve) => {
            releaseAdvisory = resolve;
          });
          await previous;
          return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
        }
        if (statement === "COMMIT" || statement === "ROLLBACK") {
          const release = releaseAdvisory;
          releaseAdvisory = null;
          release?.();
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("piece_technique_create_idempotence") && statement.includes("FOR UPDATE")) {
          return {
            rows: stored
              ? [{ piece_technique_id: stored.pieceId, request_hash: stored.requestHash }]
              : [],
            rowCount: stored ? 1 : 0,
          };
        }
        if (statement.includes("SELECT client_code FROM public.clients")) {
          return { rows: [{ client_code: "045" }], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO pieces_techniques (")) {
          const pieceId = String(params?.[0]);
          localCore = {
            id: pieceId,
            article_id: null,
            root_piece_technique_id: pieceId,
            parent_piece_technique_id: null,
            version_number: 1,
            created_at: "2026-08-04T00:00:00.000Z",
            updated_at: "2026-08-04T00:00:00.000Z",
            client_id: "045",
            created_by: 42,
            updated_by: 42,
            famille_id: null,
            name_piece: String(params?.[9]),
            code_piece: "045-10233-000",
            designation: String(params?.[11]),
            designation_2: null,
            prix_unitaire: 0,
            statut: "DRAFT",
            en_fabrication: 0,
            cycle: null,
            cycle_fabrication: null,
            code_client: null,
            client_name: "ACME",
            ensemble: false,
          };
          return { rows: [localCore], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO pieces_techniques_historique")) {
          return {
            rows: [{ id: "history-1", date_action: "2026-08-04T00:00:00.000Z" }],
            rowCount: 1,
          };
        }
        if (statement.includes("INSERT INTO public.piece_technique_create_idempotence")) {
          if (stored) {
            throw Object.assign(new Error("duplicate key"), {
              code: "23505",
              constraint: "piece_technique_create_idempotence_pkey",
            });
          }
          stored = {
            key: String(params?.[0]),
            requestHash: String(params?.[1]),
            pieceId: String(params?.[2]),
            core: localCore ?? {},
          };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const release = vi.fn();
      releases.push(release);
      return { query, release };
    });

    const makeRequest = (requestBody: typeof body) =>
      request(app)
        .post("/api/v1/pieces-techniques")
        .set("x-test-role", roleHeader("Directeur"))
        .set("Idempotency-Key", idempotencyKey)
        .send(requestBody);

    const [first, second] = await Promise.all([makeRequest(body), makeRequest(secondBody)]);

    expect([first.status, second.status].sort()).toEqual(expectedCode ? [201, 409] : [200, 201]);
    if (expectedCode) {
      const conflict = [first, second].find((response) => response.status === 409);
      expect(conflict?.body.code).toBe(expectedCode);
      expect(conflict?.body.code).not.toBe("CODE_ALREADY_EXISTS");
    } else {
      expect(first.body.id).toBe(second.body.id);
      const replay = [first, second].find((response) => response.status === 200);
      expect(replay?.body.bom).toEqual([expect.objectContaining({ id: replayBom.id })]);
      expect(replay?.body.operations).toEqual([expect.objectContaining({ id: replayOperation.id })]);
      expect(replay?.body.achats).toEqual([expect.objectContaining({ id: replayAchat.id })]);
    }
    expect(stored?.key).toBe(idempotencyKey);
    const flattened = transactionQueries.flat();
    expect(flattened.filter((query) => query === "COMMIT")).toHaveLength(1);
    expect(flattened.filter((query) => query === "ROLLBACK").length).toBeGreaterThanOrEqual(1);
    expect(flattened.filter((query) => query.includes("INSERT INTO erp_audit_logs"))).toHaveLength(1);
    expect(releases).toHaveLength(2);
    releases.forEach((release) => expect(release).toHaveBeenCalledTimes(1));
  });
});

describe("#227 — brouillons : strictement privés à leur auteur", () => {
  it("un brouillon d'un autre compte est introuvable, pas interdit", async () => {
    // Le filtre propriétaire est dans la requête : la base ne renvoie rien.
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get(`/api/v1/pieces-techniques/drafts/${VERSION_ID}`)
      .set("x-test-role", roleHeader("Directeur"));

    expect(res.status).toBe(404);
    const sql = String(mocks.poolQuery.mock.calls.at(-1)?.[0] ?? "");
    expect(sql).toContain("owner_user_id");
  });

  it("une base sans la table renvoie 503 explicite, pas une 500 muette", async () => {
    const undefinedTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    mocks.poolQuery.mockRejectedValue(undefinedTable);

    const res = await request(app).get("/api/v1/pieces-techniques/drafts").set("x-test-role", roleHeader("Directeur"));

    expect(res.status).toBe(503);
  });

  it("refuse un brouillon au-delà de la borne de taille", async () => {
    const res = await request(app)
      .post("/api/v1/pieces-techniques/drafts")
      .set("x-test-role", roleHeader("Directeur"))
      .send({ payload: { blob: "x".repeat(300 * 1024) } });

    expect(res.status).toBe(400);
  });
});
