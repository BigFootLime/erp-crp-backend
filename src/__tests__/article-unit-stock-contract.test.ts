import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeDb = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    on: vi.fn(),
    query: routeDb.poolQuery,
    connect: routeDb.poolConnect,
  })),
}));

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../shared/authoritative-documents/authoritative-document.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/authoritative-documents/authoritative-document.service")>()),
  queueCreationPdfArchive: vi.fn(),
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

import {
  assertCanonicalArticleUnit,
  repoCreateArticleTx,
  resolveUnitIdForArticle,
} from "../module/stock/repository/stock.repository";
import { canonicalizeStockUnitCode } from "../shared/stock-unit";
import { createArticleSchema } from "../module/stock/validators/stock.validators";
import app from "../config/app";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const MILLIMETRE_UNIT_ID = "22222222-2222-4222-8222-222222222222";
const MAGASIN_ID = "33333333-3333-4333-8333-333333333333";
const WAREHOUSE_ID = "44444444-4444-4444-8444-444444444444";
const LOCATION_ID = "55555555-5555-4555-8555-555555555555";
const STOCK_LEVEL_ID = "66666666-6666-4666-8666-666666666666";
const MOVEMENT_ID = "77777777-7777-4777-8777-777777777777";
const MOVEMENT_LINE_ID = "88888888-8888-4888-8888-888888888888";

beforeEach(() => {
  routeDb.poolQuery.mockReset();
  routeDb.poolConnect.mockReset();
  routeDb.clientQuery.mockReset();
  routeDb.clientRelease.mockReset();
  routeDb.poolConnect.mockResolvedValue({
    query: routeDb.clientQuery,
    release: routeDb.clientRelease,
  });
});

describe("#475 article/stock unit contract", () => {
  it.each([
    ["PCE", "u"], ["pcs", "u"], ["PC", "u"], [" unite ", "u"], ["U", "u"], ["MM", "mm"], ["Kg", "kg"], ["M", "m"],
  ])("canonicalizes the historical stock unit %s as %s", (input, expected) => {
    expect(canonicalizeStockUnitCode(input)).toBe(expected);
  });

  it("creates a real article with canonical mm then resolves its unit for a stock movement", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let storedUnit: string | null = null;
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("FROM public.units")) return { rows: [{ id: MILLIMETRE_UNIT_ID }] };
        if (sql.includes("fn_next_issued_code_value")) return { rows: [{ v: "42" }] };
        if (sql.includes("INSERT INTO public.articles (")) {
          storedUnit = (values?.[9] as string | null) ?? null;
          return { rows: [{ id: ARTICLE_ID }] };
        }
        if (sql.includes("SELECT unite FROM public.articles")) return { rows: [{ unite: storedUnit }] };
        return { rows: [] };
      },
    };

    const body = createArticleSchema.parse({ body: {
      designation: "Tôle 2 mm",
      article_category: "achat",
      article_categories: ["achat_revente"],
      family_code: "ACH",
      unite: "MM",
    } }).body;
    const audit = {
      user_id: 1, ip: null, user_agent: null, device_type: null, os: null,
      browser: null, path: "/api/v1/stock/articles", page_key: "stock", client_session_id: null,
    };

    const created = await repoCreateArticleTx(client as never, body, audit);
    expect(created.id).toBe(ARTICLE_ID);
    expect(storedUnit).toBe("mm");
    await expect(resolveUnitIdForArticle(client, ARTICLE_ID, null)).resolves.toBe(MILLIMETRE_UNIT_ID);
    expect(queries.some(({ values }) => values?.[0] === "mm")).toBe(true);
  });

  it("creates an article then a stock movement through the real HTTP/service/repository flow", async () => {
    type QueryCall = { sql: string; values: unknown[] };
    type ArticleState = {
      id: string;
      code: string;
      designation: string;
      article_type: string;
      article_category: string;
      article_categories: string[];
      family_code: string;
      stock_managed: boolean;
      unite: string | null;
      lot_tracking: boolean;
      is_sold: boolean;
      is_active: boolean;
      status: string;
    };

    const state: {
      queries: QueryCall[];
      article: ArticleState | null;
      stockLevel: {
        id: string;
        article_id: string;
        unit_id: string;
        warehouse_id: string;
        location_id: string;
      } | null;
      movement: Record<string, unknown> | null;
      movementLine: Record<string, unknown> | null;
    } = {
      queries: [],
      article: null,
      stockLevel: null,
      movement: null,
      movementLine: null,
    };

    const query = vi.fn(async (sql: unknown, rawValues?: unknown[]) => {
      const text = String(sql);
      const values = rawValues ?? [];
      state.queries.push({ sql: text, values });

      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (text.includes("FROM public.article_create_idempotence")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.stock_command_receipts")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.units")) {
        return values[0] === "mm"
          ? { rows: [{ id: MILLIMETRE_UNIT_ID }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("fn_next_issued_code_value")) return { rows: [{ v: "42" }], rowCount: 1 };
      if (text.includes("INSERT INTO public.articles (")) {
        state.article = {
          id: String(values[0]),
          code: String(values[1]),
          designation: String(values[2]),
          article_type: String(values[4]),
          article_category: String(values[5]),
          article_categories: ["achat_revente"],
          family_code: String(values[6]),
          stock_managed: Boolean(values[7]),
          unite: values[9] == null ? null : String(values[9]),
          lot_tracking: Boolean(values[16]),
          is_sold: Boolean(values[17]),
          is_active: Boolean(values[18]),
          status: String(values[14]),
        };
        return { rows: [{ id: state.article.id, updated_at: "2026-08-04T10:00:00.000Z" }], rowCount: 1 };
      }
      if (text.includes("SELECT updated_at::text AS updated_at FROM public.articles")) {
        return state.article ? { rows: [{ updated_at: "2026-08-04T10:00:00.000Z" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT stock_managed, lot_tracking FROM public.articles")) {
        return state.article
          ? { rows: [{ stock_managed: state.article.stock_managed, lot_tracking: state.article.lot_tracking }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT unite FROM public.articles")) {
        return state.article ? { rows: [{ unite: state.article.unite }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.emplacements e") && text.includes("JOIN public.magasins m")) {
        return {
          rows: [{
            magasin_id: MAGASIN_ID,
            location_id: LOCATION_ID,
            warehouse_id: WAREHOUSE_ID,
            emplacement_active: true,
            magasin_active: true,
            location_type: "STORAGE",
            allow_inbound: true,
            allow_outbound: true,
            restrictions: {},
          }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO public.stock_levels (")) {
        state.stockLevel = {
          id: STOCK_LEVEL_ID,
          article_id: String(values[0]),
          unit_id: String(values[1]),
          warehouse_id: String(values[2]),
          location_id: String(values[3]),
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM public.stock_levels") && text.includes("article_id = $1::uuid")) {
        return state.stockLevel ? { rows: [state.stockLevel], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT nextval('public.stock_movement_no_seq')")) {
        return { rows: [{ n: "7" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO public.stock_movements (")) {
        state.movement = {
          id: MOVEMENT_ID,
          movement_no: values[0],
          movement_type: values[1],
          status: "DRAFT",
          article_id: values[2],
          stock_level_id: values[3],
          stock_batch_id: values[4],
          qty: values[5],
          effective_at: values[6],
          posted_at: null,
          source_document_type: values[7],
          source_document_id: values[8],
          reason_code: values[9],
          notes: values[10],
          correlation_id: values[12],
          reversal_of_id: null,
          created_at: "2026-08-04T10:00:00.000Z",
          updated_at: "2026-08-04T10:00:00.000Z",
          created_by: values[13],
          updated_by: values[13],
          posted_by: null,
        };
        return { rows: [{ id: MOVEMENT_ID }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO public.stock_movement_lines (")) {
        state.movementLine = {
          id: MOVEMENT_LINE_ID,
          movement_id: values[0],
          line_no: values[1],
          article_id: values[2],
          article_code: state.article?.code,
          article_designation: state.article?.designation,
          lot_id: values[3],
          lot_code: null,
          qty: values[4],
          unite: values[5],
          unit_cost: values[6],
          currency: values[7],
          src_magasin_id: values[8],
          src_magasin_code: null,
          src_magasin_name: null,
          src_emplacement_id: values[9],
          src_emplacement_code: null,
          src_emplacement_name: null,
          dst_magasin_id: values[10],
          dst_magasin_code: "MAG-01",
          dst_magasin_name: "Magasin principal",
          dst_emplacement_id: values[11],
          dst_emplacement_code: "RACK-01",
          dst_emplacement_name: "Rack 01",
          note: values[12],
          direction: values[13],
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM public.stock_movements") && text.includes("WHERE id = $1::uuid")) {
        return state.movement ? { rows: [state.movement], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.stock_movement_lines l")) {
        return state.movementLine ? { rows: [state.movementLine], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.stock_movement_documents md")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.stock_movement_event_log")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.articles a") && text.includes("WHERE a.id = $1::uuid")) {
        if (!state.article) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            ...state.article,
            root_article_id: state.article.id,
            parent_article_id: null,
            version_number: 1,
            plan_index: 1,
            projet_id: null,
            piece_technique_id: null,
            piece_code: null,
            piece_designation: null,
            row_version: 1,
            archived_at: null,
            archive_reason: null,
            applicable_version: null,
            notes: null,
            article_matiere: null,
            fourniture_client: null,
            qty_available: 0,
            qty_reserved: 0,
            qty_total: 0,
            locations_count: 0,
            updated_at: "2026-08-04T10:00:00.000Z",
            created_at: "2026-08-04T10:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (text.includes("SELECT 1::int AS ok FROM public.articles")) {
        return state.article ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.article_procurement_profile")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.fournisseur_catalogue")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.article_documents")) return { rows: [], rowCount: 0 };

      return { rows: [], rowCount: 0 };
    });

    routeDb.clientQuery.mockImplementation(query);
    routeDb.poolQuery.mockImplementation(query);

    const articleResponse = await request(app)
      .post("/api/v1/stock/articles")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "contract-article-mm-001")
      .send({
        designation: "Plaque 2 mm",
        article_category: "achat",
        article_categories: ["achat_revente"],
        family_code: "ACH",
        unite: "MM",
      });

    expect(articleResponse.status).toBe(201);
    expect(articleResponse.body).toMatchObject({ id: state.article?.id, unite: "mm", stock_managed: true });
    const movementQueryStart = state.queries.length;

    const movementResponse = await request(app)
      .post("/api/v1/stock/movements")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "contract-movement-mm-001")
      .send({
        movement_type: "IN",
        lines: [{
          article_id: articleResponse.body.id,
          qty: 5,
          dst_magasin_id: MAGASIN_ID,
          dst_emplacement_id: 1,
        }],
      });

    expect(movementResponse.status).toBe(201);
    expect(movementResponse.body).toMatchObject({
      movement: {
        id: MOVEMENT_ID,
        article_id: articleResponse.body.id,
        stock_level_id: STOCK_LEVEL_ID,
        qty: 5,
      },
      lines: [{ movement_id: MOVEMENT_ID, article_id: articleResponse.body.id, qty: 5 }],
    });
    expect(state.stockLevel).toEqual({
      id: STOCK_LEVEL_ID,
      article_id: articleResponse.body.id,
      unit_id: MILLIMETRE_UNIT_ID,
      warehouse_id: WAREHOUSE_ID,
      location_id: LOCATION_ID,
    });
    expect(state.movement).toMatchObject({
      id: MOVEMENT_ID,
      article_id: articleResponse.body.id,
      stock_level_id: STOCK_LEVEL_ID,
    });
    expect(state.movementLine).toMatchObject({
      movement_id: MOVEMENT_ID,
      article_id: articleResponse.body.id,
      dst_magasin_id: MAGASIN_ID,
      dst_emplacement_id: 1,
    });

    const movementQueries = state.queries.slice(movementQueryStart);
    expect(movementQueries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sql: expect.stringContaining("SELECT unite FROM public.articles"), values: [articleResponse.body.id] }),
      expect.objectContaining({ sql: expect.stringContaining("FROM public.units"), values: ["mm"] }),
      expect.objectContaining({ sql: expect.stringContaining("INSERT INTO public.stock_levels") }),
      expect.objectContaining({ sql: expect.stringContaining("INSERT INTO public.stock_movements") }),
      expect.objectContaining({ sql: expect.stringContaining("INSERT INTO public.stock_movement_lines") }),
    ]));
  });

  it("rejects an invalid article unit before the article is persisted", async () => {
    const client = { query: async () => ({ rows: [] }) };

    await expect(assertCanonicalArticleUnit(client, "banane")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ARTICLE_UNIT",
      message: expect.stringContaining("banane"),
    });
  });

  it("keeps preflight, verification and exact-row rollback guards coherent", () => {
    const patch = readFileSync(resolve("db/patches/20260804_article_unit_stock_contract.sql"), "utf8");
    const preflight = readFileSync(resolve("db/patches/support/20260804_article_unit_stock_contract.preflight.sql"), "utf8");
    const verify = readFileSync(resolve("db/patches/support/20260804_article_unit_stock_contract.verify.sql"), "utf8");
    const rollback = readFileSync(resolve("db/patches/support/20260804_article_unit_stock_contract.rollback.sql"), "utf8");

    expect(patch).toMatch(/\('mm'::text, 'Millimètre'::text\)/);
    expect(patch).toMatch(/\('m'::text,\s+'Mètre'::text\)/);
    expect(patch).toMatch(/\('kg'::text, 'Kilogramme'::text\)/);
    expect(patch).toContain("unit_id text NOT NULL");
    expect(patch).not.toMatch(/UPDATE\s+public\.articles/i);

    for (const guard of [preflight, verify]) {
      expect(guard).toContain("'pc','pce','pces','pcs'");
      expect(guard).toContain("'unit','units','unite','unites','unité','unités'");
      expect(guard).toContain("\\quit 3");
      expect(guard).toContain("has_unresolved");
    }

    expect(rollback).toContain("current_database() = 'cerp_prod'");
    expect(rollback).toContain("id::text = seeded.unit_id");
    expect(rollback).not.toMatch(/DELETE\s+FROM\s+public\.articles/i);
  });
});
