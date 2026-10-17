import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), contacts: vi.fn(), addresses: vi.fn() }));
vi.mock("../module/devis/services/devis-references.service", () => ({
  getDevisClientReference: mocks.client,
  listDevisClientContacts: mocks.contacts,
  listDevisClientAddresses: mocks.addresses,
}));
vi.mock("../module/access-control/repository/access-control.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/access-control/repository/access-control.repository")>();
  return { ...actual, repoAuthorizationEpoch: vi.fn(), repoResolveAccessProfile: vi.fn() };
});

import * as accessRepository from "../module/access-control/repository/access-control.repository";
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate";
import { invalidateAccessCache } from "../module/access-control/services/access-control.service";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import {
  getDevisReferenceClient,
  listDevisReferenceClientAddresses,
  listDevisReferenceClientContacts,
} from "../module/devis/controllers/devis-references.controller";

const readers = [
  { suffix: "", operation: mocks.client },
  { suffix: "/contacts", operation: mocks.contacts },
  { suffix: "/addresses", operation: mocks.addresses },
];

function app() {
  const server = express();
  server.use((req, _res, next) => {
    req.user = { id: 81, username: "DEVIS_ONLY", role: "Operateur" };
    next();
  });
  server.use(moduleAccessGate);
  server.get("/devis/references/clients/:clientId", getDevisReferenceClient);
  server.get("/devis/references/clients/:clientId/contacts", listDevisReferenceClientContacts);
  server.get("/devis/references/clients/:clientId/addresses", listDevisReferenceClientAddresses);
  server.get("/clients", (_req, res) => res.json({ reached: true }));
  server.get("/stock/articles", (_req, res) => res.json({ reached: true }));
  server.use(validationErrorMiddleware);
  return server;
}

describe("Devis references — canonical client identities and module boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache();
    vi.mocked(accessRepository.repoAuthorizationEpoch).mockResolvedValue(1n);
    vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue(
      ["devis", "clients", "stock"].map((module_key) => ({
        is_superadmin: false, module_key, label: module_key, nav_page_keys: [],
        enabled_by_default: false, is_protected: false, is_active: true,
        access: module_key === "devis" ? "GRANTED" as const : "DENIED" as const,
      })),
    );
    mocks.client.mockResolvedValue({ client: { client_id: "042" } });
    mocks.contacts.mockResolvedValue([]);
    mocks.addresses.mockResolvedValue([]);
  });

  it.each(readers)("accepts numeric, imported and UUID identities at $suffix", async ({ suffix, operation }) => {
    for (const clientId of ["042", "CLIENT_IMPORT-1", "11111111-1111-4111-8111-111111111111"]) {
      const response = await request(app()).get(`/devis/references/clients/${clientId}${suffix}`);
      expect(response.status).toBe(200);
      expect(operation).toHaveBeenLastCalledWith(clientId);
    }
  });

  it.each(readers)("rejects malformed or oversized identities before querying $suffix", async ({ suffix, operation }) => {
    for (const clientId of ["bad.id", "bad'identity", "x".repeat(129)]) {
      const response = await request(app()).get(`/devis/references/clients/${encodeURIComponent(clientId)}${suffix}`);
      expect(response.status).toBe(400);
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("does not open the global Clients or Stock modules", async () => {
    const server = app();
    expect((await request(server).get("/clients")).status).toBe(403);
    expect((await request(server).get("/stock/articles")).status).toBe(403);
  });
});
