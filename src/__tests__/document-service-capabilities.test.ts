import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collect: vi.fn() }));

vi.mock("../shared/document-services/document-service-capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/document-services/document-service-capabilities")>();
  return { ...actual, collectDocumentServiceCapabilities: mocks.collect };
});

import { errorHandler } from "../middlewares/errorHandler";
import { resolveModuleKeyForPath } from "../module/access-control/domain/module-catalog";
import routes from "../shared/document-services/document-service-capabilities.routes";
import { documentServiceCapabilitiesFromHealth } from "../shared/document-services/document-service-capabilities";

const healthy = {
  configured: true, root_present: true, sentinel_required: true, sentinel_present: true,
  writable: true, healthy: true, detail: null,
  capacity_bytes: 123, available_bytes: 45, used_ratio: 0.5, inode_total: 10, inode_free: 5,
};

function app(authenticated: boolean) {
  const instance = express();
  if (authenticated) instance.use((req, _res, next) => {
    req.user = { id: 42, username: "operator", email: "operator@example.invalid", role: "ADV" };
    next();
  });
  instance.use("/api/v1/service-status", routes);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  mocks.collect.mockReset();
  mocks.collect.mockResolvedValue({
    contract_version: 1,
    status: "available",
    document_writes_supported: true,
    reason_code: null,
    checked_at: "2026-08-23T12:00:00.000Z",
  });
});

describe("shared document service capabilities (#618)", () => {
  it("requires authentication without requiring GED module capability", async () => {
    expect(resolveModuleKeyForPath("/api/v1/service-status/documents")).toBeNull();
    expect(resolveModuleKeyForPath("/service-status/documents")).toBeNull();
    await request(app(false)).get("/api/v1/service-status/documents").expect(401);
    const response = await request(app(true)).get("/api/v1/service-status/documents").expect(200);
    expect(response.body).toMatchObject({ contract_version: 1, document_writes_supported: true });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("returns only a stable reason code and no physical or capacity metadata", () => {
    const result = documentServiceCapabilitiesFromHealth({
      ...healthy,
      healthy: false,
      writable: false,
      detail: "private path /mnt/secret is read-only",
    }, "2026-08-23T12:00:00.000Z");

    expect(result).toEqual({
      contract_version: 1,
      status: "degraded",
      document_writes_supported: false,
      reason_code: "GED_VAULT_NOT_WRITABLE",
      checked_at: "2026-08-23T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("/mnt/secret");
    expect(JSON.stringify(result)).not.toContain("capacity");
  });

  it("distinguishes missing configuration from a missing/wrong mounted volume", () => {
    expect(documentServiceCapabilitiesFromHealth({
      ...healthy, configured: false, root_present: false, sentinel_present: false, writable: false, healthy: false,
    }).reason_code).toBe("GED_VAULT_NOT_CONFIGURED");
    expect(documentServiceCapabilitiesFromHealth({
      ...healthy, sentinel_present: false, writable: false, healthy: false,
    }).reason_code).toBe("GED_VOLUME_NOT_READY");
  });
});
