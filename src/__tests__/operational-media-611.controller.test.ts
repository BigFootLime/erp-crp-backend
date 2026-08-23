import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../utils/httpError";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
  capabilities: vi.fn(),
  authenticatedAccount: vi.fn(),
  loggerError: vi.fn(),
}));

// The JWT middleware consults this repository after signature verification.
// Mock only the persistence edge: the actual authenticateToken and
// moduleAccessGate implementations are exercised below.
vi.mock("../module/auth/repository/auth.repository", () => ({
  findAuthenticatedAccountState: mocks.authenticatedAccount,
}));

vi.mock("../module/operational-media/services/operational-media.service", () => ({
  authorizeOperationalMediaRead: mocks.authorize,
}));

vi.mock("../module/operational-media/services/operational-media-health.service", () => ({
  collectOperationalMediaCapabilities: mocks.capabilities,
}));

vi.mock("../shared/uploads/secure-download", () => ({
  sendSecureStoredFile: mocks.send,
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.audit,
}));

vi.mock("../utils/logger", () => ({ default: { error: mocks.loggerError } }));

import operationalMediaRoutes from "../module/operational-media/routes/operational-media.routes";
import { authenticateToken } from "../module/auth/middlewares/auth.middleware";
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate";
import { runWithAccountModuleAccessScope } from "../module/access-control/context/account-module-access.context";

const ASSET_ID = "4a99e772-4496-4c0d-a5a2-2b82c1f8c5c1";
const STORAGE_KEY = "private/customers/ACME-secret-machine-photo.png";

const media = {
  asset: {
    id: ASSET_ID,
    storage_key: STORAGE_KEY,
    mime_type: "image/png",
    sha256: "a".repeat(64),
    status: "ACTIVE" as const,
    owner_type: "machine",
    owner_id: "machine-7",
    module_key: "production",
  },
  filePath: "/private/generated/images/private/customers/ACME-secret-machine-photo.png",
  allowedRoots: ["/private/generated/images"],
  mimeType: "image/png",
  expectedSha256: "a".repeat(64),
};

// This deliberately models the two global v1 boundary outcomes without
// importing all unrelated v1 modules. The real route is mounted after
// authenticateToken + moduleAccessGate in src/routes/v1.routes.ts.
const testAuthenticationBoundary: RequestHandler = (req, res, next) => {
  if (req.headers["x-test-user"] !== "authenticated") {
    res.status(401).json({ error: "Token manquant ou invalide" });
    return;
  }
  req.user = { id: 7, username: "media-test", email: "media@example.test", role: "administrateur" };
  next();
};

const errorBoundary: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    // Match the production error-handler disclosure boundary: controlled 4xx
    // messages are public, but a 5xx never replays a storage exception.
    res.status(error.status).json({
      code: error.code,
      message: error.status >= 500 ? "Erreur serveur." : error.message,
    });
    return;
  }
  res.status(500).json({ code: "INTERNAL_ERROR", message: "Erreur serveur." });
};

function makeApp() {
  return express()
    .use("/api/v1", testAuthenticationBoundary)
    .use("/api/v1/operational-media", operationalMediaRoutes)
    .use(errorBoundary);
}

function makeActualAuthenticationBoundaryApp() {
  return express()
    .use("/api/v1", (_req, _res, next) => runWithAccountModuleAccessScope(next))
    .use("/api/v1", authenticateToken)
    .use("/api/v1", moduleAccessGate)
    .use("/api/v1/operational-media", operationalMediaRoutes)
    .use(errorBoundary);
}

function contentRequest(app = makeApp()) {
  return request(app)
    .get(`/api/v1/operational-media/${ASSET_ID}/content`)
    .set("x-test-user", "authenticated");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(media);
  mocks.audit.mockResolvedValue(undefined);
  mocks.authenticatedAccount.mockResolvedValue({ status: "Active", session_epoch: 1, mfa_required: false, mfa_factor_id: null, mfa_factor_version: null });
  mocks.capabilities.mockResolvedValue({
    contract_version: 1,
    status: "degraded",
    authenticated_fetch_required: true,
    direct_img_src_supported: false,
    content_endpoint: "/api/v1/operational-media/:assetId/content",
    preview_supported: true,
    download_supported: true,
    upload_promotion_supported: false,
    storage: { ready: false, readable: true, writable: false, reason_code: "not_writable" },
    antivirus: { ready: true, reason_code: null },
  });
  mocks.send.mockImplementation(async (res: express.Response, options: { filename: string; mimeType: string }) => {
    res.setHeader("Content-Type", options.mimeType);
    res.setHeader("Content-Disposition", `inline; filename=\"${options.filename}\"`);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.end("safe-image-bytes");
    return "completed";
  });
});

afterEach(() => vi.restoreAllMocks());

describe("#611 operational media HTTP boundary", () => {
  it("is mounted behind the real JWT and shared-route module gate", async () => {
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "operational-media-test-secret";
    try {
      const app = makeActualAuthenticationBoundaryApp();
      await request(app).get(`/api/v1/operational-media/${ASSET_ID}/content`).expect(401);
      expect(mocks.authorize).not.toHaveBeenCalled();

      const token = jwt.sign({ id: 7, username: "media-test", email: "media@example.test", role: "administrateur", session_epoch: 1 }, process.env.JWT_SECRET);
      const response = await request(app)
        .get(`/api/v1/operational-media/${ASSET_ID}/content`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(Buffer.from(response.body).toString("utf8")).toBe("safe-image-bytes");
      expect(mocks.authenticatedAccount).toHaveBeenCalledWith(7);
      // /operational-media is intentionally shared. The real global gate grants
      // the shared scope, while authorizeOperationalMediaRead still checks the
      // bound owner module before bytes can be read.
      expect(mocks.authorize).toHaveBeenCalledWith({ assetId: ASSET_ID, userId: 7 });
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });

  it("authenticates the capability probe and returns measured degraded actions", async () => {
    await request(makeApp()).get("/api/v1/operational-media/capabilities").expect(401);

    const response = await request(makeApp())
      .get("/api/v1/operational-media/capabilities")
      .set("x-test-user", "authenticated")
      .expect(200);

    expect(response.body).toMatchObject({
      status: "degraded",
      preview_supported: true,
      upload_promotion_supported: false,
      storage: { reason_code: "not_writable" },
    });
    expect(mocks.capabilities).toHaveBeenCalledTimes(1);
  });

  it("returns 401 before the media service for an unauthenticated request", async () => {
    const response = await request(makeApp()).get(`/api/v1/operational-media/${ASSET_ID}/content`);

    expect(response.status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("keeps malformed and out-of-scope identities non-disclosing 404s", async () => {
    mocks.authorize
      .mockRejectedValueOnce(new HttpError(404, "MEDIA_NOT_FOUND", "Média introuvable."))
      .mockRejectedValueOnce(new HttpError(404, "MEDIA_NOT_FOUND", "Média introuvable."));

    const malformed = await request(makeApp())
      .get("/api/v1/operational-media/not-a-uuid/content")
      .set("x-test-user", "authenticated");
    const outOfScope = await contentRequest();

    expect(malformed.status).toBe(404);
    expect(outOfScope.status).toBe(404);
    expect(malformed.body).toEqual(outOfScope.body);
    expect(JSON.stringify(outOfScope.body)).not.toContain(STORAGE_KEY);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    [410, "MEDIA_REVOKED"],
    [423, "MEDIA_QUARANTINED"],
    [423, "MEDIA_LEGACY_UNVERIFIED"],
  ])("returns the explicit stale/quarantine status %i", async (status, code) => {
    mocks.authorize.mockRejectedValueOnce(new HttpError(status, code, "Média indisponible."));

    const response = await contentRequest();

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns an opaque 503 after an authorization receipt when integrity/storage delivery fails", async () => {
    mocks.send.mockRejectedValueOnce(new HttpError(503, "DOCUMENT_INTEGRITY_ERROR", "Internal path: " + STORAGE_KEY));

    const response = await contentRequest();

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain(STORAGE_KEY);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({ body: { action: "OPERATIONAL_MEDIA_READ_AUTHORIZED" } });
  });

  it("writes an authorization receipt before bytes and a completion receipt after a finished stream", async () => {
    const response = await contentRequest();

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["content-security-policy"]).toBe("sandbox");
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
      user_id: 7,
      body: { action: "OPERATIONAL_MEDIA_READ_AUTHORIZED", details: { asset_id: ASSET_ID } },
    });
    expect(mocks.audit.mock.calls[1]?.[0]).toMatchObject({ body: { action: "OPERATIONAL_MEDIA_READ_COMPLETED", details: { asset_id: ASSET_ID } } });
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      snapshotVerifiedBytes: true,
      maxSnapshotBytes: 25 * 1024 * 1024,
      integrityError: { status: 503, code: "MEDIA_INTEGRITY_ERROR", message: "L’intégrité du média ne peut pas être confirmée." },
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(STORAGE_KEY);
  });

  it("does not record completion for an aborted stream", async () => {
    mocks.send.mockImplementationOnce(async (res: express.Response) => {
      // Model a transport that has already closed: the secure sender reports
      // `aborted`, while ending this isolated HTTP harness prevents Supertest
      // from waiting for an intentionally absent stream.
      res.status(499).end();
      return "aborted";
    });

    const response = await contentRequest();

    expect(response.status).toBe(499);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({ body: { action: "OPERATIONAL_MEDIA_READ_AUTHORIZED" } });
  });

  it("fails closed before sending bytes when the authorization receipt cannot persist", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));

    const response = await contentRequest();

    expect(response.status).toBe(500);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("keeps the delivered response honest when post-finish completion observability fails", async () => {
    mocks.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("completion unavailable"));

    const response = await contentRequest();

    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.loggerError).toHaveBeenCalledWith("operational_media_completion_audit_failed", { asset_id: ASSET_ID, user_id: 7 });
  });

  it("does not expose the physical storage filename in Content-Disposition", async () => {
    const response = await contentRequest();

    expect(response.headers["content-disposition"] ?? "").not.toContain("ACME-secret-machine-photo.png");
  });

  it("delivers an authorized PDF with attachment-safe private headers and two honest audit receipts", async () => {
    mocks.authorize.mockResolvedValueOnce({
      ...media,
      asset: { ...media.asset, mime_type: "application/pdf" },
      mimeType: "application/pdf",
    });
    mocks.send.mockImplementationOnce(async (res: express.Response, options: { filename: string; mimeType: string; download?: boolean }) => {
      res.setHeader("Content-Type", options.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename=\"${options.filename}\"`);
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.end("%PDF-safe");
      return "completed";
    });

    const response = await contentRequest().query({ download: "1" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain(`media-${ASSET_ID}.pdf`);
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(mocks.audit).toHaveBeenCalledTimes(2);
  });
});
