import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Administrateur Systeme et Reseau" };
    next();
  },
  authorizeRole:
    (...roles: string[]) =>
    (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => void) => {
      if (req.user && roles.includes(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Accès interdit" });
    },
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/stock", () => {
  it("GET /api/v1/stock/analytics returns analytics payload", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ articles_count: 12, stock_managed_articles: 9, qty_on_hand: 120, qty_available: 100, qty_reserved: 20 }] })
      .mockResolvedValueOnce({ rows: [{ id: "mag-1", code: "MAT", name: "Matières" }] })
      .mockResolvedValueOnce({ rows: [{ article_category: "matiere", articles_count: 5, stock_managed_count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ date: "2026-03-13", qty_in: 10, qty_out: 3, net_qty: 7 }] })
      .mockResolvedValueOnce({ rows: [{ article_id: "art-1", code: "MAT-001", designation: "Alu", qty_moved: 20, qty_on_hand: 15, qty_available: 12 }] });

    const res = await request(app)
      .get("/api/v1/stock/analytics")
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kpis: { articles_count: 12, stock_managed_articles: 9 },
      magasins: [{ code: "MAT" }],
      category_counts: [{ article_category: "matiere" }],
    });
  });

  it("POST /api/v1/stock/articles syncs reverse piece technique link", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FROM public.pieces_techniques pt") && q.includes("LEFT JOIN public.pieces_families")) {
        return { rows: [{ code_piece: "PT-001", designation: "Pièce stockée", family_code: "PT" }] };
      }
      if (q.includes("FROM public.pieces_techniques WHERE id = $1::uuid LIMIT 1")) {
        return { rows: [{ ok: 1 }] };
      }
      if (q.includes("FROM public.affaire") && q.includes("type_affaire = 'projet'")) {
        return { rows: [{ ok: 1 }] };
      }
      if (q.includes("INSERT INTO public.articles")) {
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
      }
      if (q.includes("INSERT INTO public.article_category_link")) {
        return { rows: [] };
      }
      if (q.includes("INSERT INTO public.articles_fabrique_families")) {
        return { rows: [] };
      }
      if (q.includes("UPDATE public.pieces_techniques SET article_id = $2::uuid WHERE id = $1::uuid")) {
        return { rows: [] };
      }
      if (q.includes("INSERT INTO public.articles_fabrique")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    mocks.poolQuery.mockResolvedValue({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          root_article_id: "11111111-1111-1111-1111-111111111111",
          parent_article_id: null,
          version_number: 1,
          plan_index: 1,
          status: "VALIDE",
          projet_id: 7,
          code: "PT-001-P1",
          designation: "Pièce stockée",
          article_type: "PIECE_TECHNIQUE",
          article_category: "fabrique",
          article_categories: ["fabrique"],
          family_code: "PT",
          stock_managed: true,
          piece_technique_id: "22222222-2222-2222-2222-222222222222",
          piece_code: "PT-001",
          piece_designation: "Pièce stockée",
          unite: "pcs",
          lot_tracking: false,
          is_active: true,
          notes: null,
          qty_available: 0,
          qty_reserved: 0,
          qty_total: 0,
          locations_count: 0,
          updated_at: "2026-03-13T00:00:00.000Z",
          created_at: "2026-03-13T00:00:00.000Z",
        },
      ],
    });

    const res = await request(app)
      .post("/api/v1/stock/articles")
      .set("Authorization", "Bearer fake")
      .send({
        code: "PT-001-P1",
        projet_id: 7,
        designation: "Pièce stockée",
        article_category: "fabrique",
        article_categories: ["fabrique"],
        family_code: "PT",
        stock_managed: true,
        piece_technique_id: "22222222-2222-2222-2222-222222222222",
        plan_index: 1,
        lot_tracking: false,
        is_active: true,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ article_category: "fabrique", family_code: "PT", stock_managed: true });
    expect(
      mocks.clientQuery.mock.calls.some((call) =>
        String(call[0]).includes("UPDATE public.pieces_techniques SET article_id = $2::uuid WHERE id = $1::uuid")
      )
    ).toBe(true);
  });

  it("POST /api/v1/stock/movements rejects missing lot for lot-tracked article", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("SELECT nextval('public.stock_movement_no_seq')::text AS n")) {
        return { rows: [{ n: "1" }] };
      }
      if (q.includes("SELECT stock_managed, lot_tracking FROM public.articles")) {
        return { rows: [{ stock_managed: true, lot_tracking: true }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post("/api/v1/stock/movements")
      .set("Authorization", "Bearer fake")
      .send({
        movement_type: "IN",
        lines: [
          {
            article_id: "11111111-1111-1111-1111-111111111111",
            qty: 5,
            dst_magasin_id: "33333333-3333-3333-3333-333333333333",
            dst_emplacement_id: 1,
          },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "LOT_REQUIRED" });
  });
});
