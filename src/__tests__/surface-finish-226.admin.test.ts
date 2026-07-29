// Administration de la bibliothèque (#226) : contrôle des doublons, favoris,
// archivage et historique.
//
// Ce que ces tests prouvent, et qui n'était couvert nulle part :
//   - le doublon strict est refusé par la BASE, et traduit en 409 lisible ;
//   - un favori est PERSONNEL et idempotent (double-clic = pas de 409) ;
//   - archiver exige `library_retire`, un motif écrit, et refuse tant qu'une
//     gamme modifiable utilise la finition ;
//   - l'historique exige `audit_read` et n'invente jamais d'évènement ;
//   - `/similaires` est déclarée AVANT `/:finishId` (régression de routage).

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
    req.user = { id: 42, username: "tester", email: "tester@example.test", role: mocks.currentRole.value };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const FIN_BASE = "/api/v1/finitions";
const FINISH_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_FINISH_ID = "99999999-9999-4999-8999-999999999999";
const GAMME_ID = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;
const rows = (list: Row[]) => ({ rows: list, rowCount: list.length });
const empty = () => rows([]);

const finishRow = (overrides: Row = {}): Row => ({
  id: FINISH_ID,
  code: "FIN-000001",
  family_code: "ANODISATION",
  family_label: "Anodisation",
  procede: "Anodisation sulfurique",
  designation_courte: "Anodisation noire 20 µm",
  designation_longue: null,
  description: null,
  synonymes: ["alu noir"],
  statut: "ACTIVE",
  current_revision_id: null,
  created_at: "2026-07-01T08:00:00.000Z",
  updated_at: "2026-07-20T08:00:00.000Z",
  archived_at: null,
  archive_reason: null,
  favori: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole.value = "administrateur";
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
});

/* -------------------------------------------------------------------------- */

describe("#226 routage", () => {
  it("expose /finitions/similaires sans le confondre avec une finition", async () => {
    // Si `/:finishId` gagnait, la requête partirait en `repoGetFinish` et
    // renverrait 404 (ou 400 sur l'UUID) au lieu d'une liste.
    // `mockResolvedValue` et non `…Once` : la toute première requête du fichier
    // peut consommer un appel d'initialisation du pool.
    mocks.poolQuery.mockResolvedValue(empty());

    const res = await request(app)
      .get(`${FIN_BASE}/similaires`)
      .query({ designation_courte: "anodisation noire", family_code: "ANODISATION" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("expose /stock/articles/similaires sans le confondre avec un article", async () => {
    mocks.poolQuery.mockResolvedValueOnce(empty());

    const res = await request(app).get("/api/v1/stock/articles/similaires").query({ designation: "vis chc m6" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });
});

describe("#226 contrôle des doublons", () => {
  it("classe un triplet identique en IDENTIQUE et l'explique", async () => {
    mocks.poolQuery.mockResolvedValueOnce(
      rows([
        {
          ...finishRow(),
          score: "0.98",
          exact_identity: true,
          same_family: true,
          synonym_hit: false,
          norme_hit: false,
          couleur_hit: false,
          epaisseur_hit: false,
          rev_json: null,
        },
      ])
    );

    const res = await request(app).get(`${FIN_BASE}/similaires`).query({
      designation_courte: "Anodisation noire 20 µm",
      procede: "Anodisation sulfurique",
      family_code: "ANODISATION",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].level).toBe("IDENTIQUE");
    expect(res.body[0].reasons).toContain("Même famille, même procédé, même désignation");
  });

  it("écarte un candidat dont le score reste sous le plancher", async () => {
    // Le SQL a pu le retenir via un synonyme ; la politique tranche et
    // l'écarte, pour ne pas noyer l'écran de faux voisins.
    mocks.poolQuery.mockResolvedValueOnce(
      rows([
        {
          ...finishRow({ designation_courte: "Zingage blanc" }),
          score: "0.05",
          exact_identity: false,
          same_family: false,
          synonym_hit: false,
          norme_hit: false,
          couleur_hit: false,
          epaisseur_hit: false,
          rev_json: null,
        },
      ])
    );

    const res = await request(app).get(`${FIN_BASE}/similaires`).query({ designation_courte: "anodisation noire" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("n'interroge pas la base quand il n'y a rien à comparer", async () => {
    const res = await request(app).get(`${FIN_BASE}/similaires`).query({ family_code: "ANODISATION" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("traduit la violation d'unicité de la base en 409 exploitable", async () => {
    // C'est l'index `surface_finishes_identity_uq` qui parle ici, pas le code.
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("surface_finish_families")) return Promise.resolve(rows([{ ok: 1 }]));
      // Le code FIN-NNNNNN est alloué par le générateur autoritaire avant
      // l'INSERT : sans cette réponse, le test échouerait AVANT le doublon.
      if (text.includes("fn_next_issued_code_value")) return Promise.resolve(rows([{ v: "1" }]));
      if (text.includes("INSERT INTO public.surface_finishes")) {
        return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
      }
      return Promise.resolve(empty());
    });
    mocks.poolQuery.mockResolvedValue(rows([{ v: "1" }]));

    const res = await request(app).post(FIN_BASE).send({
      family_code: "ANODISATION",
      procede: "Anodisation sulfurique",
      designation_courte: "Anodisation noire 20 µm",
    });

    expect(res.status).toBe(409);
  });
});

describe("#226 favoris", () => {
  it("pose un favori pour l'utilisateur du jeton", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce(rows([{ ok: 1 }])) // la finition existe
      .mockResolvedValueOnce(empty()); // INSERT ... ON CONFLICT DO NOTHING

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/favori`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ finish_id: FINISH_ID, favori: true });

    const insert = mocks.poolQuery.mock.calls[1];
    expect(String(insert[0])).toContain("ON CONFLICT (user_id, finish_id) DO NOTHING");
    // L'identité vient du jeton (42), jamais du corps de la requête.
    expect(insert[1]).toEqual([42, FINISH_ID]);
  });

  it("reste idempotent : reposer le même favori ne produit pas d'erreur", async () => {
    mocks.poolQuery.mockResolvedValue(rows([{ ok: 1 }]));

    const first = await request(app).post(`${FIN_BASE}/${FINISH_ID}/favori`);
    const second = await request(app).post(`${FIN_BASE}/${FINISH_ID}/favori`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.favori).toBe(true);
  });

  it("retirer un favori absent n'est pas une erreur", async () => {
    mocks.poolQuery.mockResolvedValueOnce(rows([{ ok: 1 }])).mockResolvedValueOnce(empty());

    const res = await request(app).delete(`${FIN_BASE}/${FINISH_ID}/favori`);

    expect(res.status).toBe(200);
    expect(res.body.favori).toBe(false);
  });

  it("404 sur une finition inexistante plutôt qu'un favori fantôme", async () => {
    mocks.poolQuery.mockResolvedValueOnce(empty());

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/favori`);

    expect(res.status).toBe(404);
  });

  it("laisse la production poser un favori : lire suffit, écrire n'est pas requis", async () => {
    mocks.currentRole.value = "production";
    mocks.poolQuery.mockResolvedValueOnce(rows([{ ok: 1 }])).mockResolvedValueOnce(empty());

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/favori`);

    expect(res.status).toBe(200);
  });
});

describe("#226 archivage", () => {
  const archiveBody = {
    motif: "Remplacée par la révision 25 µm",
    expected_updated_at: "2026-07-20T08:00:00.000Z",
  };

  it("refuse l'archivage sans la capacité library_retire", async () => {
    mocks.currentRole.value = "achats";

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/archive`).send(archiveBody);

    expect(res.status).toBe(403);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("refuse un motif trop court : sortir du référentiel s'explique", async () => {
    const res = await request(app)
      .post(`${FIN_BASE}/${FINISH_ID}/archive`)
      .send({ motif: "obsolète", expected_updated_at: "2026-07-20T08:00:00.000Z" });

    // 422 : le `validate` du module rend une entité non traitable, pas un 400.
    expect(res.status).toBe(422);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("refuse d'archiver une finition utilisée par une gamme encore modifiable", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.startsWith("BEGIN") || text.startsWith("ROLLBACK")) return Promise.resolve(empty());
      if (text.includes("FROM public.surface_finishes WHERE id")) {
        return Promise.resolve(
          rows([{ id: FINISH_ID, statut: "ACTIVE", updated_at: "2026-07-20T08:00:00.000Z", code: "FIN-000001" }])
        );
      }
      if (text.includes("gamme_operation_finitions")) {
        return Promise.resolve(
          rows([{ gamme_id: GAMME_ID, piece_code: "CAP-100", indice: "C", gamme_statut: "BROUILLON" }])
        );
      }
      return Promise.resolve(empty());
    });

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/archive`).send(archiveBody);

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error).toBe("SURFACE_FINISH_IN_USE");
    // Rien n'a été écrit.
    const wrote = mocks.clientQuery.mock.calls.some((call) =>
      String(call[0]).includes("SET statut = 'ARCHIVEE'")
    );
    expect(wrote).toBe(false);
  });

  it("refuse d'archiver deux fois", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.surface_finishes WHERE id")) {
        return Promise.resolve(
          rows([{ id: FINISH_ID, statut: "ARCHIVEE", updated_at: "2026-07-20T08:00:00.000Z", code: "FIN-000001" }])
        );
      }
      return Promise.resolve(empty());
    });

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/archive`).send(archiveBody);

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error).toBe("SURFACE_FINISH_ALREADY_ARCHIVED");
  });

  it("refuse d'archiver sur une version périmée (verrou optimiste)", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.surface_finishes WHERE id")) {
        return Promise.resolve(
          rows([{ id: FINISH_ID, statut: "ACTIVE", updated_at: "2026-07-28T12:00:00.000Z", code: "FIN-000001" }])
        );
      }
      return Promise.resolve(empty());
    });

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/archive`).send(archiveBody);

    expect(res.status).toBe(409);
  });

  it("archive avec motif, journalise, et ne touche à aucune gamme", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.surface_finishes WHERE id")) {
        return Promise.resolve(
          rows([{ id: FINISH_ID, statut: "ACTIVE", updated_at: "2026-07-20T08:00:00.000Z", code: "FIN-000001" }])
        );
      }
      return Promise.resolve(empty());
    });
    // Relecture après commit.
    mocks.poolQuery
      .mockResolvedValueOnce(rows([finishRow({ statut: "ARCHIVEE", archived_at: "2026-07-29T10:00:00.000Z" })]))
      .mockResolvedValueOnce(empty());

    const res = await request(app).post(`${FIN_BASE}/${FINISH_ID}/archive`).send(archiveBody);

    expect(res.status).toBe(200);
    expect(res.body.statut).toBe("ARCHIVEE");

    const sqlSeen = mocks.clientQuery.mock.calls.map((call) => String(call[0]));
    expect(sqlSeen.some((sql) => sql.includes("SET statut = 'ARCHIVEE'"))).toBe(true);
    expect(sqlSeen.some((sql) => sql.includes("COMMIT"))).toBe(true);
    // Aucune exigence de gamme, aucun article, aucune ligne d'achat n'est touché.
    expect(sqlSeen.some((sql) => /DELETE FROM public\.gamme_operation_finitions/.test(sql))).toBe(false);
    expect(sqlSeen.some((sql) => /UPDATE public\.articles\b/.test(sql))).toBe(false);
  });

  it("réactive en recalculant le statut depuis les révisions", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.surface_finishes WHERE id")) {
        return Promise.resolve(
          rows([{ id: FINISH_ID, statut: "ARCHIVEE", updated_at: "2026-07-20T08:00:00.000Z", code: "FIN-000001" }])
        );
      }
      // Aucune révision ACTIVE → retour en BROUILLON, pas en ACTIVE.
      if (text.includes("statut = 'ACTIVE' LIMIT 1")) return Promise.resolve(empty());
      return Promise.resolve(empty());
    });
    mocks.poolQuery.mockResolvedValueOnce(rows([finishRow({ statut: "BROUILLON" })])).mockResolvedValueOnce(empty());

    const res = await request(app)
      .post(`${FIN_BASE}/${FINISH_ID}/reactivate`)
      .send({ motif: "Reprise du procédé chez un nouveau sous-traitant", expected_updated_at: "2026-07-20T08:00:00.000Z" });

    expect(res.status).toBe(200);
    const update = mocks.clientQuery.mock.calls.find((call) => String(call[0]).includes("archived_at = NULL"));
    expect(update).toBeDefined();
    expect(update?.[1]).toContain("BROUILLON");
  });

  it("refuse la réactivation si l'identité a été reprise entre-temps", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.surface_finishes WHERE id")) {
        return Promise.resolve(
          rows([{ id: FINISH_ID, statut: "ARCHIVEE", updated_at: "2026-07-20T08:00:00.000Z", code: "FIN-000001" }])
        );
      }
      if (text.includes("archived_at = NULL")) {
        return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
      }
      return Promise.resolve(empty());
    });

    const res = await request(app)
      .post(`${FIN_BASE}/${FINISH_ID}/reactivate`)
      .send({ motif: "Reprise du procédé historique", expected_updated_at: "2026-07-20T08:00:00.000Z" });

    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error).toBe("SURFACE_FINISH_IDENTITY_TAKEN");
  });
});

describe("#226 historique", () => {
  it("exige audit_read", async () => {
    mocks.currentRole.value = "achats";

    const res = await request(app).get(`${FIN_BASE}/${FINISH_ID}/historique`);

    expect(res.status).toBe(403);
  });

  it("renvoie une liste vide sans inventer d'évènement", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce(rows([{ ok: 1 }])) // la finition existe
      .mockResolvedValueOnce(empty()); // aucun log

    const res = await request(app).get(`${FIN_BASE}/${FINISH_ID}/historique`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rend l'identifiant bigint en nombre et n'expose pas l'e-mail", async () => {
    mocks.poolQuery.mockResolvedValueOnce(rows([{ ok: 1 }])).mockResolvedValueOnce(
      rows([
        {
          id: "9007199254740000",
          created_at: "2026-07-29T09:00:00.000Z",
          action: "finitions.archive",
          entity_type: "surface_finish",
          entity_id: FINISH_ID,
          user_id: 42,
          user_label: "Jean Méthodes",
          details: { motif: "Remplacée" },
        },
      ])
    );

    const res = await request(app).get(`${FIN_BASE}/${FINISH_ID}/historique`);

    expect(res.status).toBe(200);
    expect(typeof res.body[0].id).toBe("number");
    expect(res.body[0].user_label).toBe("Jean Méthodes");
    expect(JSON.stringify(res.body)).not.toContain("@");
  });

  it("404 sur une finition inexistante", async () => {
    mocks.poolQuery.mockResolvedValueOnce(empty());

    const res = await request(app).get(`${FIN_BASE}/${OTHER_FINISH_ID}/historique`);

    expect(res.status).toBe(404);
  });
});

describe("#226 recherche de bibliothèque", () => {
  it("exclut les archives par défaut et joint le favori sur l'utilisateur du jeton", async () => {
    mocks.poolQuery.mockResolvedValueOnce(rows([{ total: 0 }])).mockResolvedValueOnce(empty());

    const res = await request(app).get(FIN_BASE);

    expect(res.status).toBe(200);
    const countSql = String(mocks.poolQuery.mock.calls[0][0]);
    expect(countSql).toContain("f.statut <> 'ARCHIVEE'");
    expect(countSql).toContain("surface_finish_favorites");
    expect(mocks.poolQuery.mock.calls[0][1]).toContain(42);
  });

  it("montre les archives quand on les demande explicitement", async () => {
    mocks.poolQuery.mockResolvedValueOnce(rows([{ total: 0 }])).mockResolvedValueOnce(empty());

    await request(app).get(FIN_BASE).query({ include_archived: "true" });

    expect(String(mocks.poolQuery.mock.calls[0][0])).not.toContain("f.statut <> 'ARCHIVEE'");
  });

  it("filtre sur mes favoris seulement", async () => {
    mocks.poolQuery.mockResolvedValueOnce(rows([{ total: 0 }])).mockResolvedValueOnce(empty());

    await request(app).get(FIN_BASE).query({ only_favorites: "true" });

    expect(String(mocks.poolQuery.mock.calls[0][0])).toContain("fav.user_id IS NOT NULL");
  });
});

describe("#226 articles similaires", () => {
  it("ignore totalement le stock : « manquant » = absent du référentiel", async () => {
    mocks.poolQuery.mockResolvedValueOnce(empty());

    await request(app).get("/api/v1/stock/articles/similaires").query({ designation: "vis chc m6" });

    const sql = String(mocks.poolQuery.mock.calls[0][0]);
    expect(sql).not.toMatch(/stock_balance|qty_available|quantite/i);
  });

  it("remonte un article archivé et dit qu'il faut le réactiver, pas le recréer", async () => {
    mocks.poolQuery.mockResolvedValueOnce(
      rows([
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          code: "ART-ACHATP-000312",
          designation: "VIS CHC M6X20 INOX A2",
          designation_secondary: null,
          article_category: "achat",
          article_categories: ["achat_revente"],
          family_code: "ACHATP",
          piece_technique_id: null,
          piece_code: null,
          status: "VALIDE",
          is_active: false,
          archived_at: "2026-05-02T08:00:00.000Z",
          score: "0.71",
          exact_designation: false,
          same_category: true,
          same_family: false,
          same_piece: false,
        },
      ])
    );

    const res = await request(app).get("/api/v1/stock/articles/similaires").query({ designation: "vis chc m6x20" });

    expect(res.status).toBe(200);
    expect(res.body.items[0].level).toBe("TRES_PROCHE");
    expect(res.body.items[0].reasons).toContain("Archivé — à réactiver plutôt qu'à recréer");
  });

  it("refuse une désignation trop courte plutôt que de renvoyer le référentiel", async () => {
    const res = await request(app).get("/api/v1/stock/articles/similaires").query({ designation: "v" });

    expect(res.status).toBe(400);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});
