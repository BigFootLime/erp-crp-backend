import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createHistorical: vi.fn() }));

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/access-control/services/access-control.service", () => ({
  resolveAccessProfile: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 7, role: "Administrateur Systeme et Reseau" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/stock/services/stock.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/stock/services/stock.service")>()),
  createHistoricalImportSVC: mocks.createHistorical,
}));

import app from "../config/app";

const result = {
  article_id: "11111111-1111-4111-8111-111111111111",
  lot_id: "22222222-2222-4222-8222-222222222222",
  movement_id: "33333333-3333-4333-8333-333333333333",
  stock_trace_code: "OLD-LOT-0001",
  qr_payload: '{"scope":"OLD"}',
  replayed: false,
};

describe("POST /api/v1/stock/historical-imports", () => {
  beforeEach(() => mocks.createHistorical.mockReset());

  it("validates and creates one explicit OLD import with the Idempotency-Key", async () => {
    mocks.createHistorical.mockResolvedValue(result);

    const res = await request(app)
      .post("/api/v1/stock/historical-imports")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "historical-import-001")
      .send({ kind: "MP", article_id: result.article_id, quantity: 3, lot_number: "MP-2026-01", notes: "Inventaire initial" });

    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ ...result, replayed: false });
    expect(mocks.createHistorical).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MP", article_id: result.article_id, quantity: 3, lot_number: "MP-2026-01" }),
      expect.objectContaining({ user_id: 7, path: "/api/v1/stock/historical-imports" }),
      "historical-import-001"
    );
  });

  it("returns the original result on an idempotent replay", async () => {
    mocks.createHistorical.mockResolvedValue({ ...result, replayed: true });

    const res = await request(app)
      .post("/api/v1/stock/historical-imports")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "historical-import-001")
      .send({ kind: "PF", client_number: "001", reference: "045/10", designation: "Palier", quantity: 2 });

    expect(res.status, res.text).toBe(200);
    expect(res.body.replayed).toBe(true);
  });

  it("rejects a missing key and MP requests without an existing material article", async () => {
    const missingKey = await request(app)
      .post("/api/v1/stock/historical-imports")
      .set("Authorization", "Bearer fake")
      .send({ kind: "MP", article_id: result.article_id, quantity: 1, lot_number: "MP-1" });
    expect(missingKey.status, missingKey.text).toBe(400);

    const missingArticle = await request(app)
      .post("/api/v1/stock/historical-imports")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "historical-import-002")
      .send({ kind: "MP", quantity: 1, lot_number: "MP-1" });
    expect(missingArticle.status).toBe(400);
    expect(mocks.createHistorical).not.toHaveBeenCalled();
  });
});
