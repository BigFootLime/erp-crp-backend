import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.hoisted(() => vi.fn());
vi.mock("../module/facturation/electronic-invoicing/electronic-invoice-directory.service", () => ({
  verifyElectronicInvoiceDirectoryAddress: verify,
}));
import { verifyClientElectronicInvoiceAddress, verifyFournisseurElectronicInvoiceAddress } from "../module/facturation/electronic-invoicing/electronic-invoice-directory.controller";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import { errorHandler } from "../middlewares/errorHandler";

// Handler wire-contract test. Route authorization remains covered separately;
// no provider/network/database call is performed by this fixture.
function app() {
  const server = express();
  server.use(express.json());
  server.use(((req, _res, next) => {
    req.user = { id: 7, username: "recipe", email: "recipe@test.invalid", role: "Directeur" };
    next();
  }) as RequestHandler);
  server.post("/clients/:id/verify", verifyClientElectronicInvoiceAddress);
  server.post("/fournisseurs/:id/verify", verifyFournisseurElectronicInvoiceAddress);
  server.use(validationErrorMiddleware);
  server.use(errorHandler);
  return server;
}

beforeEach(() => { vi.clearAllMocks(); verify.mockResolvedValue({ idempotent_replay: false }); });

describe("directory revision returned by the existing reference-data GET", () => {
  it.each([
    ["clients", "2026-10-11 22:47:46.123456+02", "2026-10-11T22:47:46.123456+02:00"],
    ["fournisseurs", "2026-10-11 20:47:46.123456+00", "2026-10-11T20:47:46.123456+00:00"],
    ["clients", "2026-10-11 18:17:46.123456-02:30", "2026-10-11T18:17:46.123456-02:30"],
    ["clients", "2026-10-11T20:47:46.123Z", "2026-10-11T20:47:46.123Z"],
    ["fournisseurs", "2026-10-11T20:47:46.123456+00:00", "2026-10-11T20:47:46.123456+00:00"],
  ])("accepts %s revision %s without rounding", async (root, revision, expected) => {
    const response = await request(app()).post(`/${root}/195/verify`).set("Idempotency-Key", "directory-revision-1224")
      .send({ identifier: "0225:380569012", expected_updated_at: revision });
    expect(response.status).toBe(201);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: expected }));
  });
  it.each(["2026-02-30 20:47:46+00", "2026-10-11 20:47:46", "yesterday", "2026-10-11 25:47:46+00", "2026-10-11 20:47:46.1234567+00"])("rejects invalid or ambiguous revision %s before provider work", async revision => {
    const response = await request(app()).post("/clients/195/verify").set("Idempotency-Key", "directory-revision-1224")
      .send({ identifier: "0225:380569012", expected_updated_at: revision });
    expect(response.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });
});
