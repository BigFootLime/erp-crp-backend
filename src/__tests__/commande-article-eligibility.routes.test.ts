import { EventEmitter } from "events";
import request, { type Response } from "supertest";
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
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { id: 1, role: "Administrateur Systeme et Reseau" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const PIECE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ARTICLE_DEVIS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_DOSSIER_DEVIS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const payload = {
  numero: "CC-315",
  client_id: "001",
  code_client: "PO-315",
  date_commande: "2026-08-04",
  lignes: [
    {
      article_id: ARTICLE_ID,
      designation: "Ligne conservee",
      quantite: 7,
      prix_unitaire_ht: 19.5,
      delai_client: "2026-09-30",
    },
  ],
};

function ineligibleArticleRow() {
  return {
    article_id: ARTICLE_ID,
    article_code: "MAT-SECONDARY-PF",
    article_designation: "Matiere multi-categorie",
    article_category: "matiere",
    family_code: "MAT",
    article_unite: "kg",
    piece_technique_id: PIECE_ID,
    piece_code: "DTP-315",
    piece_designation: "Dossier historique",
    stock_managed: true,
    is_active: true,
    commande_client_eligible: false,
    commande_client_ineligibility_code: "ARTICLE_NOT_FABRICATED",
  };
}

function expectCanonicalResolverQuery() {
  const resolveCall = mocks.clientQuery.mock.calls.find((call) =>
    String(call[0]).includes("FROM public.articles a") &&
    String(call[0]).includes("AS commande_client_eligible")
  );
  const sql = String(resolveCall?.[0]).replace(/\s+/g, " ");
  expect(sql).toContain("a.is_active = TRUE");
  expect(sql).toContain("a.stock_managed = TRUE");
  expect(sql).toContain("a.article_category IN ('fabrique', 'PIECE_TECHNIQUE')");
  expect(sql).toContain("a.piece_technique_id IS NOT NULL");
  expect(sql).not.toContain("article_category_link");
}

function expectActionableRejection(res: Response) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body).toMatchObject({
    code: "ARTICLE_NOT_FABRICATED",
    details: {
      field: "lignes.0.article_id",
      line_index: 0,
      article_id: ARTICLE_ID,
      article_code: "MAT-SECONDARY-PF",
    },
  });
  expect(res.body.message).toMatch(/MAT-SECONDARY-PF/);
  expect(res.body.message).toMatch(/article fabriqu/i);
  expect(
    mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO commande_ligne"))
  ).toBe(false);
  expectCanonicalResolverQuery();
}

function preparatoryBundleRow() {
  return {
    article_devis_id: SOURCE_ARTICLE_DEVIS_ID,
    article_devis_devis_id: 7,
    article_code: "ART-DV-315",
    article_designation: "Article devis 315",
    primary_category: "piece_finie_fabriquee",
    article_categories: ["piece_finie_fabriquee"],
    family_code: "PT",
    plan_index: 1,
    projet_id: null,
    source_official_article_id: ARTICLE_ID,
    dossier_devis_id: SOURCE_DOSSIER_DEVIS_ID,
    dossier_devis_devis_id: 7,
    dossier_code_piece: "DTP-315",
    dossier_designation: "Dossier 315",
    source_official_piece_technique_id: PIECE_ID,
    dossier_payload: {},
  };
}

function preparatoryPayload() {
  return {
    ...payload,
    officialize_preparatory_data: true,
    lignes: [
      {
        source_article_devis_id: SOURCE_ARTICLE_DEVIS_ID,
        source_dossier_devis_id: SOURCE_DOSSIER_DEVIS_ID,
        designation: "Ligne preparatoire",
        code_piece: "DTP-315",
        quantite: 1,
        prix_unitaire_ht: 19.5,
        delai_client: "2026-09-30",
      },
    ],
  };
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("BUG-CERP-0015 - validation serveur POST/PATCH commandes", () => {
  it("refuse en POST une categorie primaire matiere meme avec secondaire fabriquee", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "315" }] })
      .mockResolvedValueOnce({ rows: [{ v: "1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "315" }] })
      .mockResolvedValueOnce({ rows: [ineligibleArticleRow()] });

    const res = await request(app)
      .post("/api/v1/commandes")
      .field("data", JSON.stringify(payload));

    expectActionableRejection(res);
  });

  it("applique le meme refus lors du remplacement des lignes en PATCH", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            numero: "CC-315",
            client_id: "001",
            devis_id: null,
            order_type: "FERME",
            adresse_facturation_id: null,
            cadre_start_date: null,
            cadre_end_date: null,
            dest_stock_magasin_id: null,
            dest_stock_emplacement_id: null,
            ar_sent_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "315" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ineligibleArticleRow()] });

    const res = await request(app)
      .patch("/api/v1/commandes/315")
      .field("data", JSON.stringify(payload));

    expectActionableRejection(res);
  });

  it("refuse en POST une promotion preparatoire existante mais ineligible", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("nextval('public.commande_client_id_seq')")) return { rows: [{ id: "315" }] };
      if (query.includes("public.fn_next_issued_code_value")) return { rows: [{ v: "1" }] };
      if (query.includes("INSERT INTO commande_client")) return { rows: [{ id: "315" }] };
      if (query.includes("FROM public.article_devis ad")) return { rows: [preparatoryBundleRow()] };
      if (query.includes("FROM public.dossier_technique_piece_devis_promotion")) {
        return { rows: [{ promoted_piece_technique_id: PIECE_ID }] };
      }
      if (query.includes("FROM public.article_devis_promotion")) {
        return { rows: [{ promoted_article_id: ARTICLE_ID }] };
      }
      if (
        query.includes("FROM public.articles a") &&
        (query.includes("WHERE a.id = $1::uuid") || query.includes("AS commande_client_eligible"))
      ) {
        return { rows: [ineligibleArticleRow()] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post("/api/v1/commandes")
      .field("data", JSON.stringify(preparatoryPayload()));

    expectActionableRejection(res);
  });

  it("refuse en PATCH un nouvel article preparatoire sans dossier technique", async () => {
    let promotedArticleId: string | null = null;
    mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const query = String(sql);
      if (query.includes("FROM commande_client") && query.includes("FOR UPDATE")) {
        return {
          rows: [{
            numero: "CC-315",
            client_id: "001",
            devis_id: null,
            order_type: "FERME",
            adresse_facturation_id: null,
            cadre_start_date: null,
            cadre_end_date: null,
            dest_stock_magasin_id: null,
            dest_stock_emplacement_id: null,
            ar_sent_at: null,
          }],
        };
      }
      if (query.includes("UPDATE commande_client") && query.includes("RETURNING id")) {
        return { rows: [{ id: "315" }] };
      }
      if (query.includes("FROM public.article_devis_promotion")) return { rows: [] };
      if (query.includes("INSERT INTO public.articles (")) {
        promotedArticleId = String(params?.[0] ?? "");
        return { rows: [] };
      }
      if (
        query.includes("FROM public.articles a") &&
        (query.includes("WHERE a.id = $1::uuid") || query.includes("AS commande_client_eligible"))
      ) {
        const articleId = promotedArticleId ?? String(params?.[0] ?? "");
        return {
          rows: [{
            article_id: articleId,
            article_code: "ART-DV-NO-DTP",
            article_designation: "Article devis sans DTP",
            article_category: "fabrique",
            family_code: "PT",
            article_unite: "u",
            piece_technique_id: null,
            piece_code: null,
            piece_designation: null,
            stock_managed: true,
            is_active: true,
            commande_client_eligible: false,
            commande_client_ineligibility_code: "ARTICLE_PIECE_TECHNIQUE_REQUIRED",
          }],
        };
      }
      return { rows: [] };
    });

    const patchPayload = {
      ...payload,
      officialize_preparatory_data: true,
      lignes: [{
        designation: "Article devis sans DTP",
        code_piece: "ART-DV-NO-DTP",
        quantite: 1,
        prix_unitaire_ht: 19.5,
        delai_client: "2026-09-30",
        article_devis_data: {
          id: SOURCE_ARTICLE_DEVIS_ID,
          devis_id: 7,
          code: "ART-DV-NO-DTP",
          designation: "Article devis sans DTP",
          primary_category: "piece_finie_fabriquee",
          article_categories: ["piece_finie_fabriquee"],
          family_code: "PT",
          plan_index: 1,
          projet_id: null,
          source_official_article_id: null,
        },
      }],
    };

    const res = await request(app)
      .patch("/api/v1/commandes/315")
      .field("data", JSON.stringify(patchPayload));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      code: "ARTICLE_PIECE_TECHNIQUE_REQUIRED",
      details: {
        field: "lignes.0.article_id",
        line_index: 0,
        article_id: promotedArticleId,
        article_code: "ART-DV-NO-DTP",
      },
    });
    expect(
      mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO commande_ligne"))
    ).toBe(false);
    expectCanonicalResolverQuery();
  });

  it("accepte en POST une promotion preparatoire canoniquement eligible", async () => {
    const eligible = {
      ...ineligibleArticleRow(),
      article_code: "ART-DV-ELIGIBLE",
      article_designation: "Article devis eligible",
      article_category: "fabrique",
      family_code: "PT",
      commande_client_eligible: true,
      commande_client_ineligibility_code: null,
    };
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("nextval('public.commande_client_id_seq')")) return { rows: [{ id: "315" }] };
      if (query.includes("public.fn_next_issued_code_value")) return { rows: [{ v: "1" }] };
      if (query.includes("INSERT INTO commande_client")) return { rows: [{ id: "315" }] };
      if (query.includes("FROM public.article_devis ad")) return { rows: [preparatoryBundleRow()] };
      if (query.includes("FROM public.dossier_technique_piece_devis_promotion")) {
        return { rows: [{ promoted_piece_technique_id: PIECE_ID }] };
      }
      if (query.includes("FROM public.article_devis_promotion")) {
        return { rows: [{ promoted_article_id: ARTICLE_ID }] };
      }
      if (
        query.includes("FROM public.articles a") &&
        (query.includes("WHERE a.id = $1::uuid") || query.includes("AS commande_client_eligible"))
      ) {
        return { rows: [eligible] };
      }
      if (query.includes("INSERT INTO commande_ligne")) return { rows: [{ id: "1" }] };
      return { rows: [] };
    });

    const res = await request(app)
      .post("/api/v1/commandes")
      .field("data", JSON.stringify(preparatoryPayload()));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ id: 315 });
    expect(
      mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO commande_ligne"))
    ).toBe(true);
    expectCanonicalResolverQuery();
  });
});
