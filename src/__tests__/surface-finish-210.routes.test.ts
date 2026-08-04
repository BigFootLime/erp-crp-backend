// Surface HTTP « Bibliothèque de finitions » (#210) : RBAC refusé par défaut,
// aperçu strictement en lecture, confirmation atomique et idempotente, et
// preuve qu'aucune commande fournisseur ni aucun mouvement de stock n'est créé.

import request from "supertest";
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  currentRole: { value: "administrateur" as string | null },
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
    req: { user?: { id: number; username: string; email: string; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    req.user = {
      id: 42,
      username: "tester",
      email: "tester@example.test",
      role: mocks.currentRole.value,
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const FIN_BASE = "/api/v1/finitions";
const GAMME_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const PIECE_ID = "55555555-5555-4555-8555-555555555555";
const FINISH_ID = "66666666-6666-4666-8666-666666666666";
const ARTICLE_ID = "77777777-7777-4777-8777-777777777777";
const LINE_ID = "88888888-8888-4888-8888-888888888888";
const IDEMPOTENCY = "finition-confirm-key-0001";

const OP_BASE = `/api/v1/gammes/${GAMME_ID}/operations/${OPERATION_ID}/finition`;

type Row = Record<string, unknown>;

const contextRow = (overrides: Row = {}): Row => ({
  piece_technique_id: PIECE_ID,
  code_piece: "CAP-100",
  designation_piece: "Capot moteur",
  piece_technique_version_id: VERSION_ID,
  indice: "C",
  plan_reference: "PL-4521",
  gamme_id: GAMME_ID,
  gamme_code: "GAMME-SERIE",
  gamme_nom: "Gamme série",
  gamme_statut: "BROUILLON",
  gamme_updated_at: "2026-07-28T08:00:00.000Z",
  operation_id: OPERATION_ID,
  numero_operation: 40,
  designation_operation: "Traitement de surface",
  type_operation: "SOUS_TRAITANCE",
  operation_updated_at: "2026-07-28T08:00:00.000Z",
  operation_gamme_id: GAMME_ID,
  ...overrides,
});

const revisionRow = (overrides: Row = {}): Row => ({
  id: REVISION_ID,
  finish_id: FINISH_ID,
  revision: 2,
  statut: "ACTIVE",
  norme: "ISO 7599",
  reference_client: null,
  classe: "AA20",
  substrat: "Aluminium",
  epaisseur_min: 15,
  epaisseur_nominale: 20,
  epaisseur_max: 25,
  epaisseur_unite: "um",
  couleur: "Noir",
  teinte_ral: "RAL 9005",
  aspect: "Mat",
  brillance: null,
  rugosite: null,
  durete: null,
  exigence_corrosion: null,
  pretraitement: "Dégraissage alcalin",
  posttraitement: "Colmatage",
  zones_defaut: [],
  regles_masquage: [],
  criteres_acceptation: "Aspect homogène, sans coulure",
  controles: ["EPAISSEUR", "ASPECT"],
  certificat_requis: true,
  certificat_type: "3.1",
  conditionnement_retour: "Bac plastique cloisonné",
  unite_achat: "PCE",
  designation_template: null,
  commentaire_template: null,
  template_version: 1,
  date_effet: "2026-01-01",
  approbateur_user_id: 7,
  approved_at: "2026-01-02T09:00:00.000Z",
  created_at: "2026-01-01T09:00:00.000Z",
  updated_at: "2026-01-02T09:00:00.000Z",
  finish_uuid: FINISH_ID,
  finish_code: "FIN-000012",
  finish_designation: "Anodisation noire",
  finish_family: "ANODISATION",
  finish_procede: "Anodisation sulfurique",
  finish_statut: "ACTIVE",
  ...overrides,
});

const requirementRow = (overrides: Row = {}): Row => ({
  id: "99999999-9999-4999-8999-999999999999",
  gamme_id: GAMME_ID,
  gamme_operation_id: OPERATION_ID,
  piece_technique_version_id: VERSION_ID,
  finish_revision_id: REVISION_ID,
  finish_id: FINISH_ID,
  finish_code: "FIN-000012",
  finish_designation: "Anodisation noire",
  revision: 2,
  revision_statut: "ACTIVE",
  perimetre: "PIECE_ENTIERE",
  zones: [],
  masquages: [],
  instructions: null,
  spec_fingerprint: "a".repeat(64),
  article_id: ARTICLE_ID,
  article_code: "ART-TRT-000123",
  article_designation: "ST — CAP-100 ind. C — Anodisation noire RAL 9005 20 µm cl. AA20",
  achat_ligne_id: LINE_ID,
  generated_designation: "ST — CAP-100 ind. C — Anodisation noire RAL 9005 20 µm cl. AA20",
  generated_comment: "Sous-traitance issue de la gamme GAMME-SERIE.",
  designation_override: null,
  comment_override: null,
  updated_at: "2026-07-28T08:05:00.000Z",
  ...overrides,
});

/** Journal de toutes les requêtes vues : sert de preuve d'absence d'effet de bord. */
let sqlLog: string[] = [];

type Scenario = {
  context?: Row;
  revision?: Row;
  exactMatch?: Row | null;
  existingRequirement?: Row | null;
  receipt?: { request_hash: string; result: unknown } | null;
  failOnPurchaseLine?: boolean;
};

function installQueryRouter(scenario: Scenario = {}) {
  const handler = async (sql: string): Promise<{ rows: Row[]; rowCount: number }> => {
    sqlLog.push(sql);
    const empty = { rows: [] as Row[], rowCount: 0 };
    const one = (row: Row) => ({ rows: [row], rowCount: 1 });

    if (/surface_finish_command_receipts/.test(sql) && /^\s*SELECT/i.test(sql)) {
      return scenario.receipt ? one(scenario.receipt as Row) : empty;
    }
    if (/FROM public\.pieces_techniques pt/.test(sql) && /JOIN public\.piece_technique_versions ptv/.test(sql)) {
      return one({
        piece_technique_id: PIECE_ID,
        code_piece: "CAP-100",
        designation_piece: "Capot moteur",
        piece_technique_version_id: VERSION_ID,
        indice: "C",
        plan_reference: "PL-4521",
        version_updated_at: "2026-07-28T08:00:00.000Z",
      });
    }
    if (/FROM public\.gammes g/.test(sql)) {
      return one(scenario.context ?? contextRow());
    }
    if (/FROM public\.surface_finish_revisions r/.test(sql) && /JOIN public\.surface_finishes f/.test(sql)) {
      return one(scenario.revision ?? revisionRow());
    }
    if (/FROM public\.articles_traitement t/.test(sql) && /spec_fingerprint = \$1/.test(sql)) {
      return scenario.exactMatch ? one(scenario.exactMatch) : empty;
    }
    if (/FROM public\.articles_traitement t/.test(sql)) return empty; // near matches
    if (/FROM public\.fournisseur_catalogue c/.test(sql)) return empty;
    if (/FROM public\.gamme_operation_finitions fin/.test(sql)) {
      return scenario.existingRequirement === null
        ? empty
        : one(scenario.existingRequirement ?? requirementRow());
    }
    if (/fn_next_issued_code_value/.test(sql)) return one({ v: "123" });
    if (/FROM public\.units/.test(sql)) return one({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", code: "u" });
    if (/INSERT INTO public\.articles\b/.test(sql)) return one({ id: ARTICLE_ID });
    if (/INSERT INTO erp_audit_logs/.test(sql)) {
      return one({ id: "audit-1", created_at: "2026-07-28T08:05:00.000Z" });
    }
    if (/INSERT INTO public\.pieces_techniques_achats/.test(sql)) {
      if (scenario.failOnPurchaseLine) {
        throw Object.assign(new Error("insert failed"), { code: "23502" });
      }
      return one({ id: LINE_ID, quantite: "1" });
    }
    if (/FROM public\.pieces_techniques_achats/.test(sql)) return empty;
    return empty;
  };

  mocks.poolQuery.mockImplementation((sql: string) => handler(sql));
  mocks.clientQuery.mockImplementation((sql: string) => handler(sql));
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
}

async function fetchPreview(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app)
    .post(`${OP_BASE}/preview`)
    .send({ finish_revision_id: REVISION_ID, quantite: 1 });
  return { status: res.status, body: res.body };
}

async function fetchStockPreview(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app)
    .post(`${FIN_BASE}/stock-article/preview`)
    .send({
      piece_technique_id: PIECE_ID,
      piece_technique_version_id: VERSION_ID,
      finish_revision_id: REVISION_ID,
    });
  return { status: res.status, body: res.body };
}

function confirmPayload(preview: Record<string, unknown>, overrides: Row = {}) {
  return {
    finish_revision_id: REVISION_ID,
    quantite: 1,
    decision: "CREATE",
    preview_hash: preview.preview_hash,
    spec_fingerprint: preview.spec_fingerprint,
    expected_gamme_updated_at: "2026-07-28T08:00:00.000Z",
    expected_operation_updated_at: "2026-07-28T08:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  sqlLog = [];
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.currentRole.value = "administrateur";
  installQueryRouter();
});

/* -------------------------------------------------------------------------- */
/* Authentification et RBAC                                                    */
/* -------------------------------------------------------------------------- */

describe("#210 authentification et RBAC", () => {
  it("refuse un appel non authentifié", async () => {
    mocks.currentRole.value = null;
    const res = await request(app).get(`${FIN_BASE}?page=1`);
    expect(res.status).toBe(401);
  });

  it("refuse la lecture de la bibliothèque à un rôle sans capacité", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${FIN_BASE}?page=1`);
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error).toBeDefined();
  });

  it("laisse les Achats lire mais pas créer un brouillon de finition", async () => {
    mocks.currentRole.value = "Responsable Achats";
    const read = await request(app).get(`${FIN_BASE}?page=1&page_size=5`);
    expect(read.status).toBe(200);

    const write = await request(app)
      .post(FIN_BASE)
      .send({ family_code: "ANODISATION", procede: "Anodisation", designation_courte: "Anodisation noire" });
    expect(write.status).toBe(403);
  });

  it("refuse la configuration d'opération à un rôle Production", async () => {
    mocks.currentRole.value = "Operateur production";
    const res = await request(app).delete(OP_BASE).send({ motif: "Erreur de saisie", expected_updated_at: "x" });
    expect(res.status).toBe(403);
  });

  it("laisse les Achats prévisualiser sans pouvoir confirmer", async () => {
    mocks.currentRole.value = "Responsable Achats";
    const preview = await fetchPreview();
    expect(preview.status).toBe(200);

    const confirm = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview.body));
    expect(confirm.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

describe("#210 validation d'entrée", () => {
  it("refuse un identifiant de route non-UUID", async () => {
    const res = await request(app)
      .post(`/api/v1/gammes/not-a-uuid/operations/${OPERATION_ID}/finition/preview`)
      .send({ finish_revision_id: REVISION_ID });
    expect(res.status).toBe(422);
  });

  it("refuse une confirmation sans décision ni aperçu", async () => {
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send({ finish_revision_id: REVISION_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("refuse une page_size hors bornes", async () => {
    const res = await request(app).get(`${FIN_BASE}?page_size=5000`);
    expect(res.status).toBe(422);
  });

  it("refuse un document sans aucune ancre", async () => {
    const res = await request(app)
      .post(`${FIN_BASE}/revisions/${REVISION_ID}/documents`)
      .send({ libelle: "Spécification client" });
    expect(res.status).toBe(422);
  });
});

describe("#164 création d'un article de traitement depuis Stock", () => {
  it("exige la PT et sa version dans le contrat Stock", async () => {
    const withoutPt = await request(app)
      .post(`${FIN_BASE}/stock-article/preview`)
      .send({ finish_revision_id: REVISION_ID });
    expect(withoutPt.status).toBe(422);

    const withoutVersion = await request(app)
      .post(`${FIN_BASE}/stock-article/preview`)
      .send({ piece_technique_id: PIECE_ID, finish_revision_id: REVISION_ID });
    expect(withoutVersion.status).toBe(422);
  });

  it("réutilise le moteur canonique et génère les textes côté serveur sans écrire pendant l'aperçu", async () => {
    const preview = await fetchStockPreview();
    expect(preview.status).toBe(200);
    expect(preview.body.spec_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.body.generated_designation).toBe(
      "ST — CAP-100 ind. C — Anodisation noire RAL 9005 20 µm cl. AA20"
    );
    expect(String(preview.body.generated_comment)).toContain("Norme / spécification : ISO 7599");
    expect(mocks.poolConnect).not.toHaveBeenCalled();
    expect(sqlLog.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
  });

  it("crée un brouillon sans ligne d'achat, mouvement ou mutation de gamme", async () => {
    const { body: preview } = await fetchStockPreview();
    sqlLog = [];
    const result = await request(app)
      .post(`${FIN_BASE}/stock-article/confirm`)
      .set("Idempotency-Key", "stock-finish-confirm-164-0001")
      .send({
        piece_technique_id: PIECE_ID,
        piece_technique_version_id: VERSION_ID,
        finish_revision_id: REVISION_ID,
        decision: "CREATE",
        preview_hash: preview.preview_hash,
        spec_fingerprint: preview.spec_fingerprint,
      });

    expect(result.status).toBe(201);
    expect(result.body.result).toBe("CREATED");
    expect(result.body.article.status).toBe("EN_DEVIS");
    expect(result.body.article.article_category).toBe("traitement");
    expect(sqlLog.some((sql) => /UPDATE public\.articles_traitement/.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /INSERT INTO public\.pieces_techniques_achats/.test(sql))).toBe(false);
    expect(sqlLog.some((sql) => /gamme_operation_finitions/.test(sql))).toBe(false);
    expect(sqlLog.some((sql) => /stock_movement/i.test(sql))).toBe(false);
  });

  it("refuse la confirmation Stock à un rôle qui n'a que le droit de prévisualiser", async () => {
    mocks.currentRole.value = "Responsable Achats";
    const { body: preview } = await fetchStockPreview();
    const result = await request(app)
      .post(`${FIN_BASE}/stock-article/confirm`)
      .set("Idempotency-Key", "stock-finish-confirm-164-0002")
      .send({
        piece_technique_id: PIECE_ID,
        piece_technique_version_id: VERSION_ID,
        finish_revision_id: REVISION_ID,
        decision: "CREATE",
        preview_hash: preview.preview_hash,
        spec_fingerprint: preview.spec_fingerprint,
      });
    expect(result.status).toBe(403);
  });

  it("rejoue une double soumission identique sans recréer d'article", async () => {
    const { body: preview } = await fetchStockPreview();
    const payload = {
      piece_technique_id: PIECE_ID,
      piece_technique_version_id: VERSION_ID,
      finish_revision_id: REVISION_ID,
      decision: "CREATE",
      preview_hash: preview.preview_hash,
      spec_fingerprint: preview.spec_fingerprint,
    };
    await request(app)
      .post(`${FIN_BASE}/stock-article/confirm`)
      .set("Idempotency-Key", "stock-finish-confirm-164-0003")
      .send(payload);
    const receiptInsert = mocks.clientQuery.mock.calls.find(([sql]) =>
      /INSERT INTO public\.surface_finish_command_receipts/.test(String(sql))
    );
    expect(receiptInsert).toBeDefined();
    const storedHash = String((receiptInsert as unknown as [string, unknown[]])[1][2]);
    const stored = {
      result: "CREATED",
      article: {
        id: ARTICLE_ID,
        code: "ART-TRT-000123",
        designation: "Traitement",
        status: "EN_DEVIS",
      },
      next_actions: [],
    };
    installQueryRouter({ receipt: { request_hash: storedHash, result: stored } });
    sqlLog = [];
    const replay = await request(app)
      .post(`${FIN_BASE}/stock-article/confirm`)
      .set("Idempotency-Key", "stock-finish-confirm-164-0003")
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(stored);
    expect(sqlLog.some((sql) => /INSERT INTO public\.articles\b/.test(sql))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Aperçu — lecture pure                                                       */
/* -------------------------------------------------------------------------- */

describe("#210 aperçu", () => {
  it("renvoie la spécification, l'empreinte et les textes générés côté serveur", async () => {
    const { status, body } = await fetchPreview();
    expect(status).toBe(200);
    expect(body.spec_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.generated_designation).toBe("ST — CAP-100 ind. C — Anodisation noire RAL 9005 20 µm cl. AA20");
    expect(String(body.generated_comment)).toContain("Norme / spécification : ISO 7599");
    expect(String(body.generated_comment)).not.toMatch(/null|undefined/i);
  });

  // Régression : une valeur ABSENTE hérite de la révision ; une valeur
  // explicitement `null` l'efface. Confondre les deux vidait la désignation.
  it("hérite des valeurs de la révision quand l'opération ne les surcharge pas", async () => {
    const { body } = await fetchPreview();
    const spec = body.spec_canonical as Record<string, unknown>;
    expect(spec.teinte_ral).toBe("RAL 9005");
    expect(spec.norme).toBe("ISO 7599");
    expect(spec.epaisseur_nominale_um).toBe(20);
    expect(spec.controles).toEqual(["ASPECT", "EPAISSEUR"]);
  });

  it("efface une valeur héritée quand l'opération envoie explicitement null", async () => {
    const res = await request(app)
      .post(`${OP_BASE}/preview`)
      .send({ finish_revision_id: REVISION_ID, overrides: { teinte_ral: null, couleur: null } });
    expect(res.status).toBe(200);
    const spec = res.body.spec_canonical as Record<string, unknown>;
    expect(spec.teinte_ral).toBeNull();
    expect(spec.couleur).toBeNull();
    expect(res.body.generated_designation).toBe("ST — CAP-100 ind. C — Anodisation noire 20 µm cl. AA20");
  });

  it("annonce la classification CAT sans jamais inventer le code article", async () => {
    const { body } = await fetchPreview();
    const classification = body.classification as Record<string, unknown>;
    expect(classification.article_type).toBe("PURCHASED");
    expect(classification.article_category).toBe("traitement");
    expect(classification.article_categories).toEqual(["traitement_surface"]);
    expect(classification.stock_managed).toBe(false);
    expect(classification.lot_tracking).toBe(false);
    expect(String(classification.code_hint)).toContain("…");
  });

  it("N'ÉCRIT RIEN : aucune transaction, aucun INSERT, aucun UPDATE", async () => {
    await fetchPreview();
    expect(mocks.poolConnect).not.toHaveBeenCalled();
    const mutating = sqlLog.filter((sql) => /\b(INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b/i.test(sql));
    expect(mutating).toEqual([]);
  });

  it("prévient quand la gamme n'est plus modifiable, sans refuser la lecture", async () => {
    installQueryRouter({ context: contextRow({ gamme_statut: "APPLICABLE" }) });
    const { status, body } = await fetchPreview();
    expect(status).toBe(200);
    const codes = (body.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toContain("GAMME_NOT_EDITABLE");
    expect((body.context as Record<string, unknown>).gamme_editable).toBe(false);
  });

  it("prévient quand la révision n'est pas active", async () => {
    installQueryRouter({ revision: revisionRow({ statut: "SUSPENDUE" }) });
    const { body } = await fetchPreview();
    const codes = (body.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toContain("FINISH_REVISION_INACTIVE");
  });

  it("propose la réutilisation quand un article exact actif existe", async () => {
    const { body: first } = await fetchPreview();
    installQueryRouter({
      exactMatch: {
        article_id: ARTICLE_ID,
        code: "ART-TRT-000123",
        designation: "ST — CAP-100 ind. C — Anodisation noire RAL 9005 20 µm cl. AA20",
        is_active: true,
        status: "VALIDE",
        spec_fingerprint: first.spec_fingerprint,
        spec_canonical: null,
        finish_revision_id: REVISION_ID,
        piece_technique_version_id: VERSION_ID,
        created_at: "2026-05-01T10:00:00.000Z",
      },
    });
    const { body } = await fetchPreview();
    expect((body.exact_match as Record<string, unknown>).code).toBe("ART-TRT-000123");
    expect(body.allowed_decisions).toContain("REUSE");
    expect(body.allowed_decisions).not.toContain("CREATE");
  });

  it("refuse l'aperçu sur une opération qui n'est pas de la sous-traitance", async () => {
    installQueryRouter({ context: contextRow({ type_operation: "TOURNAGE" }) });
    const res = await fetchPreview();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("OPERATION_NOT_SUBCONTRACTING");
  });

  it("refuse l'aperçu sur une opération d'une autre gamme", async () => {
    installQueryRouter({ context: contextRow({ operation_gamme_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) });
    const res = await fetchPreview();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPERATION_GAMME_MISMATCH");
  });
});

/* -------------------------------------------------------------------------- */
/* Confirmation                                                                */
/* -------------------------------------------------------------------------- */

describe("#210 confirmation", () => {
  it("exige une clé d'idempotence", async () => {
    const { body: preview } = await fetchPreview();
    const res = await request(app).post(`${OP_BASE}/confirm`).send(confirmPayload(preview));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("refuse un aperçu périmé", async () => {
    const { body: preview } = await fetchPreview();
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview, { preview_hash: "b".repeat(64) }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PREVIEW_STALE");
  });

  it("refuse une empreinte qui ne correspond plus à la spécification recalculée", async () => {
    const { body: preview } = await fetchPreview();
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview, { spec_fingerprint: "c".repeat(64) }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PREVIEW_STALE");
  });

  it("refuse une gamme non modifiable", async () => {
    const { body: preview } = await fetchPreview();
    installQueryRouter({ context: contextRow({ gamme_statut: "APPLICABLE" }) });
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GAMME_NOT_EDITABLE");
  });

  it("refuse une révision de finition inactive", async () => {
    const { body: preview } = await fetchPreview();
    installQueryRouter({ revision: revisionRow({ statut: "OBSOLETE" }) });
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FINISH_REVISION_INACTIVE");
  });

  it("refuse un verrou optimiste périmé sur la gamme", async () => {
    const { body: preview } = await fetchPreview();
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview, { expected_gamme_updated_at: "2026-07-01T00:00:00.000Z" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MODIFICATION");
  });

  it("crée l'article, l'exigence et la ligne d'achat en UNE transaction", async () => {
    const { body: preview } = await fetchPreview();
    sqlLog = [];
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));

    expect(res.status).toBe(201);
    expect(res.body.result).toBe("CREATED");
    expect(res.body.article.article_categories).toEqual(["traitement_surface"]);
    expect(res.body.article.stock_managed).toBe(false);
    expect(res.body.purchase_line.type_achat).toBe("TRAITEMENT");

    expect(sqlLog.filter((sql) => /^\s*BEGIN\s*$/i.test(sql))).toHaveLength(1);
    expect(sqlLog.filter((sql) => /^\s*COMMIT\s*$/i.test(sql))).toHaveLength(1);
    expect(sqlLog.some((sql) => /^\s*ROLLBACK\s*$/i.test(sql))).toBe(false);
  });

  it("lie la ligne d'achat à l'opération par clé étrangère, jamais par la seule phase", async () => {
    const { body: preview } = await fetchPreview();
    sqlLog = [];
    await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));

    const insert = sqlLog.find((sql) => /INSERT INTO public\.pieces_techniques_achats/.test(sql));
    expect(insert).toBeDefined();
    expect(insert).toContain("gamme_operation_id");
    expect(insert).toContain("piece_technique_version_id");
    expect(insert).toContain("type_achat");
  });

  it("ne crée NI commande fournisseur, NI réception, NI mouvement de stock, NI règlement", async () => {
    const { body: preview } = await fetchPreview();
    sqlLog = [];
    await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));

    const forbidden = [
      /INSERT INTO public\.commande_fournisseur/i,
      /INSERT INTO public\.commandes_fournisseurs/i,
      /INSERT INTO public\.reception/i,
      /INSERT INTO public\.stock_mouvements/i,
      /INSERT INTO public\.stock_movements/i,
      /INSERT INTO public\.paiements/i,
      /INSERT INTO public\.fournisseur_catalogue/i,
    ];
    for (const pattern of forbidden) {
      expect(sqlLog.some((sql) => pattern.test(sql))).toBe(false);
    }
  });

  it("journalise la décision, l'empreinte et l'aperçu dans l'audit", async () => {
    const { body: preview } = await fetchPreview();
    sqlLog = [];
    await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));

    const auditCalls = mocks.clientQuery.mock.calls.filter(([sql]) => /INSERT INTO erp_audit_logs/.test(String(sql)));
    expect(auditCalls.length).toBeGreaterThan(0);
    const detailsJson = JSON.stringify(auditCalls.map(([, params]) => params));
    expect(detailsJson).toContain("finitions.operation.confirm");
    expect(detailsJson).toContain(String(preview.spec_fingerprint));
    expect(detailsJson).toContain(String(preview.preview_hash));
  });

  it("rejoue une clé d'idempotence identique sans rien réécrire", async () => {
    const { body: preview } = await fetchPreview();
    const payload = confirmPayload(preview);
    const stored = { result: "CREATED", article: { id: ARTICLE_ID, code: "ART-TRT-000123" } };
    installQueryRouter({
      receipt: {
        // Le hash stocké doit correspondre EXACTEMENT à la charge rejouée.
        request_hash: "",
        result: stored,
      },
    });

    // Premier appel : reçu absent -> écriture.
    const first = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(payload);
    expect(first.status).toBe(201);

    const receiptInsert = mocks.clientQuery.mock.calls.find(([sql]) =>
      /INSERT INTO public\.surface_finish_command_receipts/.test(String(sql))
    );
    expect(receiptInsert).toBeDefined();
    const storedHash = String((receiptInsert as unknown as [string, unknown[]])[1][2]);

    // Second appel : le reçu existe avec le MÊME hash -> rejeu à l'identique.
    // Même clé + même charge doit rendre la MÊME réponse, code HTTP compris.
    installQueryRouter({ receipt: { request_hash: storedHash, result: stored } });
    sqlLog = [];
    const second = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(payload);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(stored);
    expect(sqlLog.some((sql) => /^\s*ROLLBACK\s*$/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /INSERT INTO public\.articles\b/.test(sql))).toBe(false);
  });

  it("refuse la même clé avec une charge différente", async () => {
    const { body: preview } = await fetchPreview();
    installQueryRouter({ receipt: { request_hash: "d".repeat(64), result: {} } });
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("annule TOUT si la ligne d'achat échoue", async () => {
    const { body: preview } = await fetchPreview();
    installQueryRouter({ failOnPurchaseLine: true });
    sqlLog = [];
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sqlLog.some((sql) => /^\s*ROLLBACK\s*$/i.test(sql))).toBe(true);
    expect(sqlLog.some((sql) => /^\s*COMMIT\s*$/i.test(sql))).toBe(false);
  });

  it("traduit une collision d'unicité concurrente en conflit exploitable", async () => {
    const { body: preview } = await fetchPreview();
    mocks.clientQuery.mockImplementation((sql: string) => {
      sqlLog.push(sql);
      if (/UPDATE public\.articles_traitement/.test(sql)) {
        return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
      }
      if (/surface_finish_command_receipts/.test(sql) && /^\s*SELECT/i.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/FROM public\.gammes g/.test(sql)) return Promise.resolve({ rows: [contextRow()], rowCount: 1 });
      if (/FROM public\.surface_finish_revisions r/.test(sql)) {
        return Promise.resolve({ rows: [revisionRow()], rowCount: 1 });
      }
      if (/FROM public\.articles_traitement t/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (/fn_next_issued_code_value/.test(sql)) return Promise.resolve({ rows: [{ v: "123" }], rowCount: 1 });
      if (/FROM public\.units/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", code: "u" }],
          rowCount: 1,
        });
      }
      if (/INSERT INTO public\.articles\b/.test(sql)) return Promise.resolve({ rows: [{ id: ARTICLE_ID }], rowCount: 1 });
      if (/INSERT INTO erp_audit_logs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: "a", created_at: "x" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ARTICLE_EXACT_MATCH_CHANGED");
  });

  it("refuse un article distinct sans habilitation dédiée", async () => {
    mocks.currentRole.value = "Technicien Methodes";
    const { body: preview } = await fetchPreview();
    installQueryRouter({
      exactMatch: {
        article_id: ARTICLE_ID,
        code: "ART-TRT-000123",
        designation: "ST — CAP-100 ind. C",
        is_active: true,
        status: "VALIDE",
        spec_fingerprint: preview.spec_fingerprint,
        spec_canonical: null,
        finish_revision_id: REVISION_ID,
        piece_technique_version_id: VERSION_ID,
        created_at: "2026-05-01T10:00:00.000Z",
      },
    });
    const { body: refreshed } = await fetchPreview();
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(
        confirmPayload(refreshed, {
          decision: "FORCE_CREATE",
          justification: "Le client impose une référence dédiée pour cette affaire.",
        })
      );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ARTICLE_FORCE_CREATE_FORBIDDEN");
  });

  it("refuse une création simple quand un article exact existe déjà", async () => {
    const { body: first } = await fetchPreview();
    installQueryRouter({
      exactMatch: {
        article_id: ARTICLE_ID,
        code: "ART-TRT-000123",
        designation: "ST — CAP-100 ind. C",
        is_active: true,
        status: "VALIDE",
        spec_fingerprint: first.spec_fingerprint,
        spec_canonical: null,
        finish_revision_id: REVISION_ID,
        piece_technique_version_id: VERSION_ID,
        created_at: "2026-05-01T10:00:00.000Z",
      },
    });
    const { body: preview } = await fetchPreview();
    const res = await request(app)
      .post(`${OP_BASE}/confirm`)
      .set("Idempotency-Key", IDEMPOTENCY)
      .send(confirmPayload(preview, { decision: "CREATE" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ARTICLE_SPEC_CONFLICT");
  });
});

/* -------------------------------------------------------------------------- */
/* Retrait                                                                     */
/* -------------------------------------------------------------------------- */

describe("#210 retrait de l'exigence", () => {
  it("détache la ligne d'achat sans supprimer l'article ni la ligne", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      sqlLog.push(sql);
      if (/FROM public\.gammes g/.test(sql)) return Promise.resolve({ rows: [contextRow()], rowCount: 1 });
      if (/FROM public\.gamme_operation_finitions\s*\n?\s*WHERE gamme_operation_id/.test(sql) || /FOR UPDATE/.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              id: "req-1",
              updated_at: "2026-07-28T08:05:00.000Z",
              article_id: ARTICLE_ID,
              achat_ligne_id: LINE_ID,
            },
          ],
          rowCount: 1,
        });
      }
      if (/INSERT INTO erp_audit_logs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: "a", created_at: "x" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .delete(OP_BASE)
      .send({ motif: "Finition déplacée sur une autre opération", expected_updated_at: "2026-07-28T08:05:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.detached).toBe(true);
    expect(sqlLog.some((sql) => /DELETE FROM public\.articles/.test(sql))).toBe(false);
    expect(sqlLog.some((sql) => /DELETE FROM public\.pieces_techniques_achats/.test(sql))).toBe(false);
    expect(sqlLog.some((sql) => /DELETE FROM public\.gamme_operation_finitions/.test(sql))).toBe(true);
  });
});
