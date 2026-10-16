import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: vi.fn(),
  pieces: vi.fn(),
  versions: vi.fn(),
  stockReference: vi.fn(),
}));

vi.mock("../module/production/services/production-references.service", () => ({
  svcListProductionReferenceClients: mocks.clients,
  svcListProductionReferencePieces: mocks.pieces,
  svcListProductionReferencePieceVersions: mocks.versions,
  svcGetReceiptStockReference: mocks.stockReference,
}));

vi.mock("../module/access-control/repository/access-control.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/access-control/repository/access-control.repository")>();
  return { ...actual, repoAuthorizationEpoch: vi.fn(), repoResolveAccessProfile: vi.fn() };
});

import * as accessRepository from "../module/access-control/repository/access-control.repository";
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate";
import { invalidateAccessCache } from "../module/access-control/services/access-control.service";
import { listProductionReferenceClients, listProductionReferencePieces } from "../module/production/controllers/production-references.controller";

function profile(moduleKey: string, access: "GRANTED" | "DENIED") {
  return {
    is_superadmin: false, module_key: moduleKey, label: moduleKey, nav_page_keys: [],
    enabled_by_default: false, is_protected: false, is_active: true, access,
  };
}

function app() {
  const server = express();
  server.use((_req, _res, next) => {
    (_req as typeof _req & { user?: unknown }).user = { id: 81, username: "MODULE_ONLY", email: null, role: "Operateur" };
    next();
  });
  server.use(moduleAccessGate);
  server.get("/production/references/clients", listProductionReferenceClients);
  server.get("/production/references/pieces", listProductionReferencePieces);
  server.get("/clients", (_req, res) => res.json({ should_not_be_reached: true }));
  return server;
}

describe("Production reference projections — module-only HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache();
    vi.mocked(accessRepository.repoAuthorizationEpoch).mockResolvedValue(1n);
    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([
      profile("production", "GRANTED"),
      profile("clients", "DENIED"),
    ]);
    mocks.clients.mockResolvedValue({ items: [{ value: "client-1", label: "Client 1 (C1)" }] });
    mocks.pieces.mockResolvedValue({ items: [] });
  });

  it("serves the limited production projection for a non-superadmin with Production only", async () => {
    const response = await request(app()).get("/production/references/clients");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({ items: [{ value: "client-1", label: "Client 1 (C1)" }] });
    expect(mocks.clients).toHaveBeenCalledWith({ limit: 50 });
  });

  it("accepts the historical client selector limit of 200", async () => {
    const response = await request(app()).get("/production/references/clients?limit=200");
    expect(response.status).toBe(200);
    expect(mocks.clients).toHaveBeenCalledWith({ limit: 200 });
  });

  it("accepts the canonical textual client identifier", async () => {
    const response = await request(app()).get("/production/references/pieces?client_id=042");
    expect(response.status).toBe(200);
    expect(mocks.pieces).toHaveBeenCalledWith({ client_id: "042", limit: 50 });
  });

  it("refuses the global Clients route for that same module-only account", async () => {
    const response = await request(app()).get("/clients");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Accès interdit" });
  });
});
