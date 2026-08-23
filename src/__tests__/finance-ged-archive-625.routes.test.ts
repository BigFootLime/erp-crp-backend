import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const legal = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), read: vi.fn(), print: vi.fn(),
}));

vi.mock("../module/facturation/services/finance-legal-archive.service", () => ({
  listFinanceLegalArchive: (...args: unknown[]) => legal.list(...args),
  getFinanceLegalArchive: (...args: unknown[]) => legal.get(...args),
  readFinanceLegalArchive: (...args: unknown[]) => legal.read(...args),
  printFinanceLegalArchive: (...args: unknown[]) => legal.print(...args),
  readLatestFinanceLegalArchive: (...args: unknown[]) => legal.read(...args),
}));

import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import factureRoutes from "../module/facturation/routes/factures.routes";
import { errorHandler } from "../middlewares/errorHandler";

function app(role: string | null) {
  const server = express();
  server.use(express.json());
  server.use(((req, _res, next) => {
    if (role) req.user = { id: 7, username: "finance-test", role };
    next();
  }) as RequestHandler);
  server.use("/factures", factureRoutes);
  server.use(validationErrorMiddleware);
  server.use(errorHandler);
  return server;
}

describe("#625 mounted legal PDF archive routes", () => {
  beforeEach(() => { for (const mock of Object.values(legal)) mock.mockReset(); vi.spyOn(console, "error").mockImplementation(() => undefined); });

  it("fails closed before an invoice archive handler runs", async () => {
    expect((await request(app(null)).get("/factures/1/official-documents")).status).toBe(401);
    const denied = await request(app("Employee")).get("/factures/1/official-documents");
    expect(denied.status).toBe(403);
    expect(legal.list).not.toHaveBeenCalled();
  });

  it("admits a Finance documents_read role and keeps the route mounted before /:id", async () => {
    legal.list.mockResolvedValue({ state: "READY", latest_document: null, retryable: false, failure_code: null });
    const response = await request(app("Comptable")).get("/factures/1/official-documents");
    expect(response.status).toBe(200);
    expect(legal.list).toHaveBeenCalledWith("FACTURE", 1);
  });
});
