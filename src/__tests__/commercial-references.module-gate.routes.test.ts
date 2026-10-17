import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/access-control/repository/access-control.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/access-control/repository/access-control.repository")>();
  return { ...actual, repoAuthorizationEpoch: vi.fn(), repoResolveAccessProfile: vi.fn() };
});

import * as accessRepository from "../module/access-control/repository/access-control.repository";
import commercialReferencesRoutes from "../module/commercial-references/routes/commercial-references.routes";
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate";
import { resolveModuleAccessKeysForRequest, resolveModuleKeyForPath } from "../module/access-control/domain/module-catalog";
import { invalidateAccessCache } from "../module/access-control/services/access-control.service";

function profile(moduleKey: string, access: "GRANTED" | "DENIED") {
  return {
    is_superadmin: false, module_key: moduleKey, label: moduleKey, nav_page_keys: [],
    enabled_by_default: false, is_protected: false, is_active: true, access,
  };
}

function app() {
  const server = express();
  server.use((_req, _res, next) => {
    (_req as typeof _req & { user?: unknown }).user = { id: 81, username: "CLIENTS_ONLY", role: "Operateur" };
    next();
  });
  server.use(moduleAccessGate);
  server.use((req, res, next) => {
    res.setHeader("x-test-granted-module", req.accountModuleAccess?.moduleKey ?? "");
    next();
  });
  server.use(commercialReferencesRoutes);
  server.get("/devis", (_req, res) => res.json({ reached: true }));
  server.post("/conditions-paiement/nested", (_req, res) => res.status(201).json({ reached: true }));
  return server;
}

describe("Commercial reference reads — exact shared module boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache();
    vi.mocked(accessRepository.repoAuthorizationEpoch).mockResolvedValue(1n);
    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([
      profile("clients", "GRANTED"),
      profile("devis", "DENIED"),
    ]);
  });

  it("maps only the two exact GET readers to Clients or Devis", () => {
    expect(resolveModuleAccessKeysForRequest("/api/v1/conditions-paiement?active=1", "GET")).toEqual(["clients", "devis"]);
    expect(resolveModuleAccessKeysForRequest("/compte-vente/", "GET")).toEqual(["clients", "devis"]);
    expect(resolveModuleAccessKeysForRequest("/conditions-paiement/nested", "GET")).toEqual(["devis"]);
    expect(resolveModuleAccessKeysForRequest("/conditions-paiement", "POST")).toEqual(["devis"]);
    expect(resolveModuleKeyForPath("/conditions-paiement")).toBe("devis");
  });

  it.each(["/conditions-paiement", "/compte-vente"])("allows Clients-only to read %s", async (path) => {
    const response = await request(app()).get(path);
    expect(response.status).toBe(200);
    expect(response.headers["x-test-granted-module"]).toBe("clients");
    expect(response.body).toMatchObject({ availability: "NOT_CONFIGURED", items: [] });
  });

  it("allows Devis-only", async () => {
    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([
      profile("clients", "DENIED"), profile("devis", "GRANTED"),
    ]);
    const response = await request(app()).get("/conditions-paiement");
    expect(response.status).toBe(200);
    expect(response.headers["x-test-granted-module"]).toBe("devis");
  });

  it("refuses accounts without either module and does not reopen Devis or nested mutations", async () => {
    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([
      profile("clients", "DENIED"), profile("devis", "DENIED"),
    ]);
    expect((await request(app()).get("/conditions-paiement")).status).toBe(403);

    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([
      profile("clients", "GRANTED"), profile("devis", "DENIED"),
    ]);
    invalidateAccessCache();
    expect((await request(app()).get("/devis")).status).toBe(403);
    expect((await request(app()).post("/conditions-paiement/nested")).status).toBe(403);
  });

  it("fails closed when the access profile or either required catalog decision is unavailable", async () => {
    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue(null);
    expect((await request(app()).get("/conditions-paiement")).status).toBe(503);

    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([profile("clients", "GRANTED")]);
    invalidateAccessCache();
    expect((await request(app()).get("/conditions-paiement")).status).toBe(503);
  });
});
