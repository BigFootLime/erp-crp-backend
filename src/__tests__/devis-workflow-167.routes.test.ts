import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import path from "node:path";

process.env.CERP_DOCUMENTS_ROOT = path.resolve("uploads", "docs");

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
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

// RBAC réel testé : le rôle vient de l'en-tête `x-test-role` (défaut : administrateur).
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void
  ) => {
    const roleHeader =
      typeof req.headers["x-test-role"] === "string" ? (req.headers["x-test-role"] as string) : "administrateur";
    req.user = { id: 1, username: "test", email: "test@example.test", role: roleHeader };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

/** Dispatcher SQL par contenu — voir devis.routes.test.ts (même pattern #172). */
const defaultState = () => ({
  columns: { code_piece: true, position: true, total_ht: true, total_ttc: true } as Record<string, boolean>,
  idempotenceTable: true,
  idemRow: null as null | { action: string; payload_hash: string; resultat: Record<string, unknown> },
  updateCurrent: null as null | Record<string, unknown>,
  deleteCurrent: null as null | Record<string, unknown>,
  commandeHeader: null as null | Record<string, unknown>,
  existingCommande: null as null | { id: string; numero: string },
  hasPrep: false,
  nextVersion: 2,
  devisSeqId: "7",
  insertDevisReturnId: "7",
  ligneSeq: 1,
  convertLineCount: 1,
  versionRoot: "7",
  versionRows: [] as Record<string, unknown>[],
});

let state = defaultState();

function dispatch(sqlRaw: unknown, params?: unknown[]): { rows: unknown[]; rowCount?: number } {
  const sql = String(sqlRaw);

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };

  if (/information_schema\.columns/.test(sql)) {
    const column = String(params?.[1] ?? "");
    return { rows: [{ exists: state.columns[column] === true }] };
  }
  if (/information_schema\.tables/.test(sql)) return { rows: [{ exists: state.idempotenceTable }] };

  if (/FROM public\.devis_idempotence WHERE cle/.test(sql)) return { rows: state.idemRow ? [state.idemRow] : [] };
  if (/INSERT INTO public\.devis_idempotence/.test(sql)) return { rows: [] };

  if (/erp_audit_logs/i.test(sql)) return { rows: [{ id: "99", created_at: "2026-07-22T08:00:00.000Z" }] };
  if (/pg_notify/i.test(sql)) return { rows: [] };

  if (/INSERT INTO devis_ligne/.test(sql)) {
    const id = String(state.ligneSeq);
    state.ligneSeq += 1;
    return { rows: [{ id }], rowCount: 1 };
  }
  if (/INSERT INTO devis_documents/.test(sql)) return { rows: [] };
  if (/INSERT INTO documents_clients/.test(sql)) return { rows: [] };
  if (/INSERT INTO commande_ligne/.test(sql)) return { rows: [], rowCount: state.convertLineCount };
  if (/INSERT INTO commande_client/.test(sql)) return { rows: [] };
  if (/INSERT INTO devis\s*\(/.test(sql)) return { rows: [{ id: state.insertDevisReturnId }] };
  if (/INSERT INTO (public\.)?(article_devis|dossier_technique_piece_devis)/.test(sql)) {
    return { rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }] };
  }
  if (/UPDATE public\.articles/.test(sql)) return { rows: [] };
  if (/UPDATE devis\s+SET/i.test(sql)) return { rows: [{ id: "7" }], rowCount: 1 };
  if (/DELETE FROM (public\.)?(devis_ligne|article_devis|dossier_technique_piece_devis)/.test(sql)) {
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM devis/.test(sql)) return { rows: [], rowCount: 1 };

  if (/devis_id_seq/.test(sql)) return { rows: [{ id: state.devisSeqId }] };
  if (/commande_client_id_seq/.test(sql)) return { rows: [{ id: "55" }] };
  if (/fn_next(_issued)?_code_value/.test(sql)) return { rows: [{ v: "1" }] };
  if (/MAX\(version_number\)/i.test(sql)) return { rows: [{ next_version: state.nextVersion }] };

  if (/AS converted/.test(sql)) return { rows: state.deleteCurrent ? [state.deleteCurrent] : [] };
  if (/FOR UPDATE OF d/.test(sql)) return { rows: state.updateCurrent ? [state.updateCurrent] : [] };
  if (/FROM devis\s+WHERE id = \$1\s+FOR UPDATE/.test(sql)) {
    return { rows: state.commandeHeader ? [state.commandeHeader] : [] };
  }
  if (/->>'created_at'/.test(sql) && /FROM devis d/.test(sql)) {
    return { rows: state.commandeHeader ? [state.commandeHeader] : [] };
  }
  if (/AS has_prep/.test(sql)) return { rows: [{ has_prep: state.hasPrep }] };
  if (/FROM commande_client cc\s+WHERE cc\.devis_id/.test(sql)) {
    return { rows: state.existingCommande ? [state.existingCommande] : [] };
  }
  if (/COALESCE\(root_devis_id, id\)/.test(sql)) return { rows: [{ root_devis_id: state.versionRoot }] };
  if (/COALESCE\(d\.root_devis_id, d\.id\)/.test(sql)) return { rows: state.versionRows };
  if (/SELECT quantite/.test(sql) && /FROM devis_ligne/.test(sql)) return { rows: [] };

  return { rows: [] };
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  state = defaultState();
  mocks.poolQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => dispatch(sql, params));
  mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => dispatch(sql, params));
});

const draftCurrent = (over: Record<string, unknown> = {}) => ({
  id: "7",
  numero: "DEV-2026-0007",
  statut: "BROUILLON",
  remise_globale: 0,
  updated_at: "2026-07-22T08:00:00+00:00",
  has_children: false,
  ...over,
});

const acceptedHeader = (over: Record<string, unknown> = {}) => ({
  id: "7",
  numero: "DEV-2026-0007",
  client_id: "001",
  contact_id: null,
  adresse_facturation_id: null,
  adresse_livraison_id: null,
  mode_reglement_id: null,
  conditions_paiement_id: null,
  biller_id: null,
  compte_vente_id: null,
  commentaires: null,
  remise_globale: 0,
  total_ht: 100,
  total_ttc: 120,
  statut: "ACCEPTE",
  updated_at: "2026-07-22T08:00:00+00:00",
  created_at: "2026-07-21T08:00:00+00:00",
  ...over,
});

const patchDevis = (body: Record<string, unknown>, role?: string) => {
  let req = request(app).patch("/api/v1/devis/7");
  if (role) req = req.set("x-test-role", role);
  return req.field("data", JSON.stringify({ user_id: 1, ...body }));
};

describe("#167 — RBAC devis refus par défaut", () => {
  it("Employee ne lit pas les devis (403) — les prix sont une donnée sensible", async () => {
    const res = await request(app).get("/api/v1/devis").set("x-test-role", "Employee");
    expect(res.status).toBe(403);
  });

  it("un rôle inconnu est refusé sur toutes les surfaces d'écriture", async () => {
    for (const call of [
      request(app).post("/api/v1/devis").set("x-test-role", "Stagiaire").field("data", "{}"),
      request(app).post("/api/v1/devis/7/convert-to-commande").set("x-test-role", "Stagiaire").send({}),
      request(app).post("/api/v1/devis/7/revise").set("x-test-role", "Stagiaire").field("data", "{}"),
      request(app).delete("/api/v1/devis/7").set("x-test-role", "Stagiaire"),
      request(app).get("/api/v1/devis/7/documents/33333333-3333-3333-3333-333333333333/file").set("x-test-role", "Stagiaire"),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
    }
  });

  it("Responsable Qualité lit mais ne crée pas (403 create)", async () => {
    const read = await request(app).get("/api/v1/devis/7/versions").set("x-test-role", "Responsable Qualité");
    expect(read.status).not.toBe(403);
    const write = await request(app)
      .post("/api/v1/devis")
      .set("x-test-role", "Responsable Qualité")
      .field("data", JSON.stringify({ client_id: "001", user_id: 1, lignes: [] }));
    expect(write.status).toBe(403);
  });

  it("la Secrétaire ne décide pas l'issue commerciale (403 FORBIDDEN_TRANSITION au niveau fin)", async () => {
    state.updateCurrent = draftCurrent({ statut: "ENVOYE" });
    const res = await patchDevis({ statut: "ACCEPTE" }, "Secretaire");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_TRANSITION");
  });

  it("la suppression est réservée (403 route pour Secretaire)", async () => {
    const res = await request(app).delete("/api/v1/devis/7").set("x-test-role", "Secretaire");
    expect(res.status).toBe(403);
  });
});

describe("#167 — automate de statuts appliqué au write-path", () => {
  it("BROUILLON → ACCEPTE est refusé (409 DEVIS_INVALID_TRANSITION + transitions autorisées)", async () => {
    state.updateCurrent = draftCurrent();
    const res = await patchDevis({ statut: "ACCEPTE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_INVALID_TRANSITION");
    expect(res.body.details).toMatchObject({ from: "BROUILLON", to: "ACCEPTE", allowed: ["ENVOYE", "ANNULE"] });
  });

  it("BROUILLON → ENVOYE passe (200) et la transition est auditée", async () => {
    state.updateCurrent = draftCurrent();
    const res = await patchDevis({ statut: "ENVOYE" });
    expect(res.status).toBe(200);
    const auditCall = mocks.clientQuery.mock.calls.find((c) => /erp_audit_logs/i.test(String(c[0])));
    expect(auditCall).toBeTruthy();
    expect(String((auditCall?.[1] as unknown[])?.[2])).toBe("devis.statut_transition");
  });

  it("ENVOYE → ACCEPTE (statut seul) passe même sur devis engagé", async () => {
    state.updateCurrent = draftCurrent({ statut: "ENVOYE" });
    const res = await patchDevis({ statut: "ACCEPTE" });
    expect(res.status).toBe(200);
  });

  it("un devis ne naît pas ACCEPTE (422 DEVIS_INITIAL_STATUT_INVALID)", async () => {
    const res = await request(app)
      .post("/api/v1/devis")
      .field(
        "data",
        JSON.stringify({
          client_id: "001",
          user_id: 1,
          statut: "ACCEPTE",
          lignes: [{ description: "L", quantite: 1, prix_unitaire_ht: 10 }],
        })
      );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DEVIS_INITIAL_STATUT_INVALID");
  });

  it("une révision ne naît pas ACCEPTE (422 DEVIS_REVISION_STATUT_INVALID)", async () => {
    state.commandeHeader = acceptedHeader({ root_devis_id: "7", statut: "ACCEPTE" });
    const res = await request(app)
      .post("/api/v1/devis/7/revise")
      .field("data", JSON.stringify({ user_id: 1, statut: "ACCEPTE" }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DEVIS_REVISION_STATUT_INVALID");
  });

  it("une révision d'un devis engagé repart en BROUILLON par défaut", async () => {
    state.commandeHeader = acceptedHeader({ root_devis_id: "7", statut: "ACCEPTE" });
    state.devisSeqId = "8";
    state.insertDevisReturnId = "8";
    const res = await request(app).post("/api/v1/devis/7/revise").field("data", JSON.stringify({ user_id: 1 }));
    expect(res.status).toBe(201);
    const insertDevisCall = mocks.clientQuery.mock.calls.find((c) => /INSERT INTO devis\s*\(/.test(String(c[0])));
    expect((insertDevisCall?.[1] as unknown[])?.[14]).toBe("BROUILLON");
  });
});

describe("#167 — immutabilité des versions engagées / remplacées", () => {
  it("le contenu d'un devis ENVOYE ne s'écrase pas (409 DEVIS_ENGAGED_IMMUTABLE)", async () => {
    state.updateCurrent = draftCurrent({ statut: "ENVOYE" });
    const res = await patchDevis({ commentaires: "nouveau texte" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_ENGAGED_IMMUTABLE");
  });

  it("une version remplacée par une révision est immuable (409 DEVIS_VERSION_SUPERSEDED)", async () => {
    state.updateCurrent = draftCurrent({ has_children: true });
    const res = await patchDevis({ commentaires: "V1 modifiée ?" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_VERSION_SUPERSEDED");
  });

  it("le numéro serveur est immuable (409 DEVIS_CODE_IMMUTABLE)", async () => {
    state.updateCurrent = draftCurrent();
    const res = await patchDevis({ numero: "DEV-2026-9999" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_CODE_IMMUTABLE");
  });

  it("un devis converti ne se supprime pas (409 DEVIS_CONVERTED_UNDELETABLE)", async () => {
    state.deleteCurrent = { numero: "DEV-2026-0007", statut: "ACCEPTE", has_children: false, converted: true };
    const res = await request(app).delete("/api/v1/devis/7");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_CONVERTED_UNDELETABLE");
  });

  it("un devis engagé ne se supprime pas (409 DEVIS_ENGAGED_UNDELETABLE)", async () => {
    state.deleteCurrent = { numero: "DEV-2026-0007", statut: "ENVOYE", has_children: false, converted: false };
    const res = await request(app).delete("/api/v1/devis/7");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_ENGAGED_UNDELETABLE");
  });

  it("un devis avec révisions ne se supprime pas (409 DEVIS_HAS_REVISIONS)", async () => {
    state.deleteCurrent = { numero: "DEV-2026-0007", statut: "BROUILLON", has_children: true, converted: false };
    const res = await request(app).delete("/api/v1/devis/7");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_HAS_REVISIONS");
  });
});

describe("#167 — verrou optimiste expected_updated_at", () => {
  it("PATCH avec jeton périmé → 409 DEVIS_STALE + updated_at courant", async () => {
    state.updateCurrent = draftCurrent();
    const res = await patchDevis({ commentaires: "x", expected_updated_at: "2026-07-21T00:00:00+00:00" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_STALE");
    expect(res.body.details).toMatchObject({ current_updated_at: "2026-07-22T08:00:00+00:00" });
  });

  it("PATCH avec jeton exact → 200 (formats texte/JSONB tolérés)", async () => {
    state.updateCurrent = draftCurrent();
    // Format ::text (espace) vs JSONB (T) : même instant → accepté.
    const res = await patchDevis({ commentaires: "x", expected_updated_at: "2026-07-22 08:00:00+00" });
    expect(res.status).toBe(200);
  });

  it("révision avec jeton périmé → 409 DEVIS_STALE", async () => {
    state.commandeHeader = acceptedHeader({ root_devis_id: "7" });
    const res = await request(app)
      .post("/api/v1/devis/7/revise")
      .field("data", JSON.stringify({ user_id: 1, expected_updated_at: "2026-01-01T00:00:00+00:00" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_STALE");
  });
});

describe("#167 — idempotence création / révision / conversion", () => {
  const createPayload = {
    client_id: "001",
    user_id: 1,
    lignes: [{ description: "Ligne", quantite: 1, prix_unitaire_ht: 100 }],
  };

  it("création : 1er appel 201 + clé enregistrée ; rejeu même clé+payload → 200 sans double insertion", async () => {
    const first = await request(app)
      .post("/api/v1/devis")
      .set("Idempotency-Key", "devis-create-0001")
      .field("data", JSON.stringify(createPayload));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: 7, idempotent_replay: false });

    const recordCall = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO public.devis_idempotence")
    );
    expect(recordCall).toBeTruthy();
    const [cle, action, , payloadHash, resultat] = recordCall?.[1] as [string, string, unknown, string, string];
    expect(cle).toBe("devis-create-0001");
    expect(action).toBe("CREATE");

    // Rejeu : la clé est désormais en base -> même résultat, aucune nouvelle insertion devis.
    state.idemRow = { action: "CREATE", payload_hash: payloadHash, resultat: JSON.parse(resultat) };
    mocks.clientQuery.mockClear();
    const replay = await request(app)
      .post("/api/v1/devis")
      .set("Idempotency-Key", "devis-create-0001")
      .field("data", JSON.stringify(createPayload));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: 7, idempotent_replay: true });
    expect(mocks.clientQuery.mock.calls.some((c) => /INSERT INTO devis\s*\(/.test(String(c[0])))).toBe(false);
  });

  it("même clé + payload différent → 409 IDEMPOTENCY_PAYLOAD_MISMATCH", async () => {
    state.idemRow = { action: "CREATE", payload_hash: "autre-empreinte", resultat: { id: 7 } };
    const res = await request(app)
      .post("/api/v1/devis")
      .set("Idempotency-Key", "devis-create-0001")
      .field("data", JSON.stringify(createPayload));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  it("même clé + autre action → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    state.idemRow = { action: "CONVERT", payload_hash: "peu-importe", resultat: { id: 55 } };
    const res = await request(app)
      .post("/api/v1/devis")
      .set("Idempotency-Key", "devis-create-0001")
      .field("data", JSON.stringify(createPayload));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("conversion : rejeu de la même clé → 200 avec le même résultat, sans nouvelle commande", async () => {
    state.commandeHeader = acceptedHeader();
    const first = await request(app)
      .post("/api/v1/devis/7/convert-to-commande")
      .set("Idempotency-Key", "devis-convert-0001")
      .send({});
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: 55, already_converted: false, idempotent_replay: false });

    const recordCall = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO public.devis_idempotence")
    );
    const [, , , payloadHash, resultat] = recordCall?.[1] as [string, string, unknown, string, string];

    state.idemRow = { action: "CONVERT", payload_hash: payloadHash, resultat: JSON.parse(resultat) };
    mocks.clientQuery.mockClear();
    const replay = await request(app)
      .post("/api/v1/devis/7/convert-to-commande")
      .set("Idempotency-Key", "devis-convert-0001")
      .send({});
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: 55, numero: "CMD-2026-0001", idempotent_replay: true });
    expect(mocks.clientQuery.mock.calls.some((c) => /INSERT INTO commande_client/.test(String(c[0])))).toBe(false);
  });
});

describe("#167 — conversion contrôlée devis → commande", () => {
  it("une commande existe déjà → 200 + la commande existante, jamais de doublon", async () => {
    state.commandeHeader = acceptedHeader();
    state.existingCommande = { id: "42", numero: "CMD-2026-0042" };
    const res = await request(app).post("/api/v1/devis/7/convert-to-commande").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 42, numero: "CMD-2026-0042", already_converted: true });
    expect(mocks.clientQuery.mock.calls.some((c) => /INSERT INTO commande_client/.test(String(c[0])))).toBe(false);
  });

  it("version source modifiée depuis l'aperçu → 409 DEVIS_DRAFT_STALE", async () => {
    state.commandeHeader = acceptedHeader();
    const res = await request(app)
      .post("/api/v1/devis/7/convert-to-commande")
      .send({ expected_updated_at: "2026-07-20T00:00:00+00:00" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_DRAFT_STALE");
  });

  it("statut non accepté → 400 DEVIS_NOT_ACCEPTED", async () => {
    state.commandeHeader = acceptedHeader({ statut: "ENVOYE" });
    const res = await request(app).post("/api/v1/devis/7/convert-to-commande").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEVIS_NOT_ACCEPTED");
  });

  it("données préparatoires présentes → 409 DEVIS_REQUIRES_PREPARED_CONVERSION (parcours préparé)", async () => {
    state.commandeHeader = acceptedHeader();
    state.hasPrep = true;
    const res = await request(app).post("/api/v1/devis/7/convert-to-commande").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEVIS_REQUIRES_PREPARED_CONVERSION");
  });

  it("devis sans ligne → 400 DEVIS_EMPTY (transaction annulée)", async () => {
    state.commandeHeader = acceptedHeader();
    state.convertLineCount = 0;
    const res = await request(app).post("/api/v1/devis/7/convert-to-commande").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEVIS_EMPTY");
    const commits = mocks.clientQuery.mock.calls.filter((c) => String(c[0]).trim() === "COMMIT");
    expect(commits.length).toBe(0);
  });
});

describe("#167 — historique des versions", () => {
  it("GET /:id/versions retourne la lignée V1→Vn avec is_current / is_latest / has_commande", async () => {
    state.versionRows = [
      {
        id: "7",
        numero: "DEV-2026-0007",
        version_number: 1,
        parent_devis_id: null,
        statut: "ACCEPTE",
        date_creation: "2026-07-20",
        updated_at: "2026-07-21T08:00:00+00:00",
        total_ht: 100,
        total_ttc: 120,
        commande_id: "42",
        commande_numero: "CMD-2026-0042",
      },
      {
        id: "8",
        numero: "DEV-2026-0007-V2",
        version_number: 2,
        parent_devis_id: "7",
        statut: "BROUILLON",
        date_creation: "2026-07-22",
        updated_at: "2026-07-22T08:00:00+00:00",
        total_ht: 110,
        total_ttc: 132,
        commande_id: null,
        commande_numero: null,
      },
    ];

    const res = await request(app).get("/api/v1/devis/8/versions");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items[0]).toMatchObject({
      id: 7,
      version_number: 1,
      is_current: false,
      is_latest: false,
      has_commande: true,
      commande_id: 42,
      commande_numero: "CMD-2026-0042",
    });
    expect(res.body.items[1]).toMatchObject({
      id: 8,
      version_number: 2,
      is_current: true,
      is_latest: true,
      has_commande: false,
    });
  });
});
