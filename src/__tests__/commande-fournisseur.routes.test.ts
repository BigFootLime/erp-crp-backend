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
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

// Auth mock : rôle injecté via l'en-tête `x-test-role` (refus par défaut testé avec Employee).
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void
  ) => {
    const roleHeader =
      typeof req.headers["x-test-role"] === "string" ? (req.headers["x-test-role"] as string) : "Administrateur Systeme et Reseau";
    req.user = { id: 1, username: "test", email: "test@example.test", role: roleHeader };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const UUID = "3b9f2a44-6d3e-4f7a-9c2d-1e5b8a7c6d90";

/** État configurable du dispatcher SQL (mock pg robuste par contenu de requête). */
const state = {
  header: {
    id: UUID,
    code: "BCF-2026-0001",
    statut: "BROUILLON",
    fournisseur_id: UUID,
    devise: "EUR",
    version_document: 0,
    frais_port_ht: "0",
    tva_frais_pct: "20",
    updated_at_token: "2026-07-21 10:00:00+00",
  },
  fournisseur: { id: UUID, code: "FOU-001", nom: "Aciers Rhône", status: "actif", actif: true },
  idemRow: null as null | { action: string; resultat: Record<string, unknown> },
  qtyRecue: "0",
};

function dispatch(sqlRaw: unknown): { rows: unknown[]; rowCount?: number } {
  const sql = String(sqlRaw);
  if (/fn_next_issued_code_value/.test(sql)) return { rows: [{ v: "7" }] };
  if (/FROM public\.commande_fournisseur_idempotence WHERE cle/.test(sql)) {
    return { rows: state.idemRow ? [state.idemRow] : [] };
  }
  if (/INSERT INTO public\.commande_fournisseur_idempotence/.test(sql)) return { rows: [] };
  if (/FROM public\.commande_fournisseur\s+WHERE id = \$1::uuid\s+FOR UPDATE/.test(sql)) {
    return { rows: [state.header] };
  }
  if (/INSERT INTO public\.commande_fournisseur_ligne_besoin/.test(sql)) return { rows: [] };
  if (/INSERT INTO public\.commande_fournisseur_ligne/.test(sql)) return { rows: [{ id: "11111111-2222-4333-8444-555555555555" }] };
  if (/INSERT INTO public\.commande_fournisseur_transition/.test(sql)) return { rows: [] };
  if (/INSERT INTO public\.commande_fournisseur/.test(sql)) return { rows: [{ id: UUID }] };
  if (/SELECT quantite::text, prix_unitaire_ht::text/.test(sql)) return { rows: [] };
  if (/SELECT frais_port_ht::text, tva_frais_pct::text FROM public\.commande_fournisseur/.test(sql)) {
    return { rows: [{ frais_port_ht: state.header.frais_port_ht, tva_frais_pct: state.header.tva_frais_pct }] };
  }
  if (/count\(\*\) AS n FROM public\.commande_fournisseur_ligne/.test(sql)) return { rows: [{ n: "2" }] };
  if (/COALESCE\(sum\(rl\.qty_received\), 0\) AS q/.test(sql)) return { rows: [{ q: state.qtyRecue }] };
  if (/FROM public\.fournisseurs WHERE id/.test(sql)) return { rows: [state.fournisseur] };
  if (/FROM public\.fournisseur_adresses/.test(sql)) return { rows: [] };
  if (/UPDATE public\.commande_fournisseur_document/.test(sql)) return { rows: [], rowCount: 0 };
  if (/UPDATE public\.commande_fournisseur/.test(sql)) return { rows: [], rowCount: 1 };
  if (/erp_audit_logs/i.test(sql)) return { rows: [{ id: 99 }] };
  if (/pg_notify/i.test(sql)) return { rows: [] };
  return { rows: [] };
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.poolQuery.mockImplementation(async (sql: unknown) => dispatch(sql));
  mocks.clientQuery.mockImplementation(async (sql: unknown) => dispatch(sql));
  state.header = {
    id: UUID,
    code: "BCF-2026-0001",
    statut: "BROUILLON",
    fournisseur_id: UUID,
    devise: "EUR",
    version_document: 0,
    frais_port_ht: "0",
    tva_frais_pct: "20",
    updated_at_token: "2026-07-21 10:00:00+00",
  };
  state.fournisseur = { id: UUID, code: "FOU-001", nom: "Aciers Rhône", status: "actif", actif: true };
  state.idemRow = null;
  state.qtyRecue = "0";
});

describe("/api/v1/commandes-fournisseurs — RBAC refus par défaut", () => {
  it("Employee ne lit pas les commandes fournisseurs (403)", async () => {
    const res = await request(app).get("/api/v1/commandes-fournisseurs").set("x-test-role", "Employee");
    expect(res.status).toBe(403);
  });

  it("un rôle inconnu est refusé par défaut sur toutes les surfaces", async () => {
    for (const call of [
      request(app).get("/api/v1/commandes-fournisseurs").set("x-test-role", "Stagiaire"),
      request(app).post("/api/v1/commandes-fournisseurs").set("x-test-role", "Stagiaire").send({}),
      request(app).post(`/api/v1/commandes-fournisseurs/${UUID}/transition`).set("x-test-role", "Stagiaire").send({ to: "A_VALIDER" }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
    }
  });

  it("Responsable Qualité lit mais ne crée pas (403 create)", async () => {
    const read = await request(app).get("/api/v1/commandes-fournisseurs/kpis").set("x-test-role", "Responsable Qualité");
    expect(read.status).toBe(200);
    const write = await request(app)
      .post("/api/v1/commandes-fournisseurs")
      .set("x-test-role", "Responsable Qualité")
      .send({ fournisseur_id: UUID, lignes: [] });
    expect(write.status).toBe(403);
  });

  it("l'approbation par la Secrétaire est refusée au niveau fin (403 FORBIDDEN_TRANSITION)", async () => {
    state.header.statut = "A_VALIDER";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .set("x-test-role", "Secretaire")
      .send({ to: "APPROUVEE" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_TRANSITION");
  });
});

describe("/api/v1/commandes-fournisseurs — création", () => {
  it("crée un brouillon avec code BCF serveur (201) et refuse le code client", async () => {
    const res = await request(app)
      .post("/api/v1/commandes-fournisseurs")
      .send({ fournisseur_id: UUID, lignes: [{ type: "LIBRE_CONTROLEE", designation: "Prestation contrôle 3D", quantite: 1, prix_unitaire_ht: 120 }] });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^BCF-\d{4}-0007$/);
    expect(res.body.idempotent_replay).toBe(false);

    const forbidden = await request(app)
      .post("/api/v1/commandes-fournisseurs")
      .send({ fournisseur_id: UUID, code: "BCF-2026-9999", lignes: [] });
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.error).toBe("VALIDATION_ERROR");
  });

  it("rejoue une création idempotente sans dupliquer (200 + idempotent_replay)", async () => {
    state.idemRow = { action: "CREATE", resultat: { id: UUID, code: "BCF-2026-0001" } };
    const res = await request(app)
      .post("/api/v1/commandes-fournisseurs")
      .set("Idempotency-Key", "cle-idempotente-0001")
      .send({ fournisseur_id: UUID, lignes: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: UUID, code: "BCF-2026-0001", idempotent_replay: true });
  });

  it("refuse la réutilisation d'une clé d'idempotence sur une autre action (409)", async () => {
    state.idemRow = { action: "GENERATE", resultat: {} };
    const res = await request(app)
      .post("/api/v1/commandes-fournisseurs")
      .set("Idempotency-Key", "cle-idempotente-0001")
      .send({ fournisseur_id: UUID, lignes: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuse un fournisseur inactif (422 FOURNISSEUR_INACTIF)", async () => {
    state.fournisseur = { ...state.fournisseur, actif: false, status: "inactif" };
    const res = await request(app)
      .post("/api/v1/commandes-fournisseurs")
      .send({ fournisseur_id: UUID, lignes: [] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("FOURNISSEUR_INACTIF");
  });
});

describe("/api/v1/commandes-fournisseurs — verrou optimiste & brouillon", () => {
  it("PATCH avec jeton périmé → 409 CONCURRENT_MODIFICATION", async () => {
    const res = await request(app)
      .patch(`/api/v1/commandes-fournisseurs/${UUID}`)
      .send({ expected_updated_at: "2026-07-20T09:00:00.000+00:00", note_interne: "maj" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MODIFICATION");
  });

  it("PATCH hors brouillon → 422 DRAFT_ONLY", async () => {
    state.header.statut = "ENVOYEE";
    const res = await request(app).patch(`/api/v1/commandes-fournisseurs/${UUID}`).send({ note_interne: "maj" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DRAFT_ONLY");
  });
});

describe("/api/v1/commandes-fournisseurs — machine d'état", () => {
  it("transition interdite → 422 INVALID_TRANSITION avec {from,to,allowed}", async () => {
    state.header.statut = "CLOTUREE";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .send({ to: "ENVOYEE" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_TRANSITION");
    expect(res.body.details).toMatchObject({ from: "CLOTUREE", to: "ENVOYEE", allowed: [] });
  });

  it("soumission sans ligne active → 422 COMMANDE_SANS_LIGNE", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      if (/count\(\*\) AS n FROM public\.commande_fournisseur_ligne/.test(String(sql))) return { rows: [{ n: "0" }] };
      return dispatch(sql);
    });
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .send({ to: "A_VALIDER" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("COMMANDE_SANS_LIGNE");
  });

  it("envoi sans version documentaire figée → 422 DOCUMENT_VERSION_REQUISE", async () => {
    state.header.statut = "APPROUVEE";
    state.header.version_document = 0;
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .set("x-test-role", "Directeur")
      .send({ to: "ENVOYEE" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DOCUMENT_VERSION_REQUISE");
  });

  it("l'envoi fige snapshot + date (200) quand une version documentaire existe", async () => {
    state.header.statut = "APPROUVEE";
    state.header.version_document = 1;
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .set("x-test-role", "Directeur")
      .send({ to: "ENVOYEE" });
    expect(res.status).toBe(200);
    expect(res.body.statut).toBe("ENVOYEE");
  });

  it("les statuts de réception ne se posent jamais à la main → 422 RECEPTION_DERIVED_STATUS", async () => {
    state.header.statut = "ENVOYEE";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .send({ to: "RECUE" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("RECEPTION_DERIVED_STATUS");
  });

  it("annulation motivée obligatoire → 422 MOTIF_REQUIS puis 200 avec motif", async () => {
    const sans = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .set("x-test-role", "Directeur")
      .send({ to: "ANNULEE" });
    expect(sans.status).toBe(422);
    expect(sans.body.code).toBe("MOTIF_REQUIS");

    const avec = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .set("x-test-role", "Directeur")
      .send({ to: "ANNULEE", motif: "Erreur de saisie fournisseur" });
    expect(avec.status).toBe(200);
    expect(avec.body.statut).toBe("ANNULEE");
  });

  it("annulation impossible si des quantités sont déjà reçues → 422", async () => {
    state.header.statut = "ENVOYEE";
    state.qtyRecue = "5";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .set("x-test-role", "Directeur")
      .send({ to: "ANNULEE", motif: "tentative" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("ANNULATION_IMPOSSIBLE_RECEPTIONNEE");
  });

  it("double-clic : retransitionner vers l'état courant est un replay sans écriture (200)", async () => {
    state.header.statut = "A_VALIDER";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/transition`)
      .send({ to: "A_VALIDER" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ statut: "A_VALIDER", idempotent_replay: true });
  });
});

describe("/api/v1/commandes-fournisseurs — accusé & 404", () => {
  it("l'accusé exige une commande envoyée (422 sinon)", async () => {
    state.header.statut = "BROUILLON";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/accuse`)
      .send({ reference_fournisseur: "AR-2233" });
    expect(res.status).toBe(422);
  });

  it("enregistre l'accusé fournisseur sur une commande envoyée (200)", async () => {
    state.header.statut = "ENVOYEE";
    const res = await request(app)
      .post(`/api/v1/commandes-fournisseurs/${UUID}/accuse`)
      .send({ reference_fournisseur: "AR-2233", date_promesse: "2026-08-30" });
    expect(res.status).toBe(200);
    expect(res.body.statut).toBe("ACCUSE_RECU");
  });

  it("GET détail introuvable → 404 sans fuite d'information", async () => {
    mocks.poolQuery.mockImplementation(async (sql: unknown) => {
      if (/FROM public\.commande_fournisseur cf/.test(String(sql))) return { rows: [] };
      return dispatch(sql);
    });
    const res = await request(app).get(`/api/v1/commandes-fournisseurs/${UUID}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/sql|stack|SELECT/i);
  });

  it("id non-UUID → 400 VALIDATION_ERROR (pas de fuite SQL)", async () => {
    const res = await request(app).get("/api/v1/commandes-fournisseurs/1;DROP");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });
});

describe("/api/v1/commandes-fournisseurs — totaux serveur", () => {
  it("simule les totaux côté serveur (HT/TVA/TTC arrondis)", async () => {
    const res = await request(app)
      .post("/api/v1/commandes-fournisseurs/totaux/simulate")
      .send({
        frais_port_ht: 25,
        tva_frais_pct: 20,
        lignes: [{ quantite: 2, prix_unitaire_ht: 100, remise_pct: 10, tva_pct: 20, frais_ht: 0 }],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total_ht: 205, total_remise: 20, total_tva: 41, total_ttc: 246 });
  });
});
