import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../utils/httpError";

const authoritative = vi.hoisted(() => ({
  envelope: vi.fn(),
  read: vi.fn(),
  print: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { query: vi.fn() } }));
vi.mock("../shared/authoritative-documents/authoritative-document.service", () => ({
  getOfficialDocumentGenerationEnvelope: authoritative.envelope,
  readOfficialPdfBytes: authoritative.read,
  recordOfficialPdfPrintIntent: authoritative.print,
}));

import { createCreationSnapshotHandlers } from "../shared/authoritative-documents/creation-snapshot-http";

const ROOT_ID = "visible-root";
const ARCHIVE_ID = "11111111-1111-4111-8111-111111111111";
const exactBytes = Buffer.from("%PDF-1.7 immutable creation snapshot\n%%EOF\n", "utf8");

function binaryParser(response: NodeJS.ReadableStream, callback: (error: Error | null, value?: Buffer) => void): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  response.on("error", (error: Error) => callback(error));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
}

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    if (req.header("x-test-anonymous") !== "true") req.user = { id: 7, role: "Administrateur" };
    next();
  });

  const handlers = createCreationSnapshotHandlers({
    entityType: "client",
    documentKind: "CLIENT_CREATION_SNAPSHOT",
    parseEntityId: (req) => req.params.id,
    canReadEntity: async (id) => id === ROOT_ID,
    baseUrl: (id) => `/clients/${encodeURIComponent(id)}/creation-snapshot`,
  });

  app.get("/:id/creation-snapshot", handlers.metadata);
  app.get("/:id/creation-snapshot/:documentId/preview", handlers.preview);
  app.get("/:id/creation-snapshot/:documentId/download", handlers.download);
  app.post("/:id/creation-snapshot/:documentId/print-intents", handlers.printIntent);

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    res.status(status).json({ code });
  };
  app.use(errors);
  return app;
}

describe("creation snapshot HTTP adapter", () => {
  beforeEach(() => {
    authoritative.envelope.mockReset().mockResolvedValue({
      state: "READY",
      latest_document: { id: ARCHIVE_ID },
      retryable: false,
      failure_code: null,
    });
    authoritative.read.mockReset().mockResolvedValue({
      bytes: exactBytes,
      filename: "client-creation-snapshot.pdf",
      sha256: "a".repeat(64),
    });
    authoritative.print.mockReset().mockResolvedValue(undefined);
  });

  it("returns metadata only after the aggregate scope check, with no-store links", async () => {
    const response = await request(buildApp()).get(`/${ROOT_ID}/creation-snapshot`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.body).toMatchObject({ state: "READY", latest_document: { id: ARCHIVE_ID } });
    expect(authoritative.envelope).toHaveBeenCalledWith({
      tx: expect.any(Object),
      entityType: "client",
      entityId: ROOT_ID,
      documentKind: "CLIENT_CREATION_SNAPSHOT",
      baseUrl: `/clients/${ROOT_ID}/creation-snapshot`,
    });
  });

  it("returns the exact archived bytes with secure preview/download cache and disposition headers", async () => {
    const app = buildApp();
    const preview = await request(app)
      .get(`/${ROOT_ID}/creation-snapshot/${ARCHIVE_ID}/preview`)
      .buffer(true)
      .parse(binaryParser);
    const download = await request(app)
      .get(`/${ROOT_ID}/creation-snapshot/${ARCHIVE_ID}/download`)
      .buffer(true)
      .parse(binaryParser);

    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(exactBytes);
    expect(preview.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(preview.headers["content-length"]).toBe(String(exactBytes.byteLength));
    expect(preview.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect(preview.headers["content-disposition"]).toContain('inline; filename="client-creation-snapshot.pdf"');

    expect(download.status).toBe(200);
    expect(download.body).toEqual(exactBytes);
    expect(download.headers["content-disposition"]).toContain('attachment; filename="client-creation-snapshot.pdf"');
    expect(authoritative.read).toHaveBeenNthCalledWith(1, {
      entityType: "client",
      entityId: ROOT_ID,
      documentKind: "CLIENT_CREATION_SNAPSHOT",
      archiveId: ARCHIVE_ID,
      actorUserId: 7,
      eventType: "AUTHORITATIVE_PDF_PREVIEWED",
    });
    expect(authoritative.read).toHaveBeenNthCalledWith(2, {
      entityType: "client",
      entityId: ROOT_ID,
      documentKind: "CLIENT_CREATION_SNAPSHOT",
      archiveId: ARCHIVE_ID,
      actorUserId: 7,
      eventType: "AUTHORITATIVE_PDF_DOWNLOADED",
    });
  });

  it("denies unknown roots before archive access and rejects unauthenticated metadata/byte reads", async () => {
    const app = buildApp();
    const hidden = await request(app).get(`/hidden-root/creation-snapshot/${ARCHIVE_ID}/preview`);
    const anonymousMetadata = await request(app)
      .get(`/${ROOT_ID}/creation-snapshot`)
      .set("x-test-anonymous", "true");
    const anonymous = await request(app)
      .get(`/${ROOT_ID}/creation-snapshot/${ARCHIVE_ID}/preview`)
      .set("x-test-anonymous", "true");

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ code: "CREATION_SNAPSHOT_ENTITY_NOT_FOUND" });
    expect(anonymousMetadata.status).toBe(401);
    expect(anonymousMetadata.body).toEqual({ code: "UNAUTHORIZED" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ code: "UNAUTHORIZED" });
    expect(authoritative.read).not.toHaveBeenCalled();
    expect(authoritative.envelope).not.toHaveBeenCalled();
  });

  it("rejects malformed archive ids and records a byte-free print intent for an exact archive", async () => {
    const app = buildApp();
    const malformed = await request(app).get(`/${ROOT_ID}/creation-snapshot/not-a-uuid/download`);
    const printed = await request(app).post(`/${ROOT_ID}/creation-snapshot/${ARCHIVE_ID}/print-intents`);

    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ code: "INVALID_ROUTE_PARAM" });
    expect(printed.status).toBe(204);
    expect(printed.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(authoritative.read).not.toHaveBeenCalled();
    expect(authoritative.print).toHaveBeenCalledWith({
      entityType: "client",
      entityId: ROOT_ID,
      documentKind: "CLIENT_CREATION_SNAPSHOT",
      archiveId: ARCHIVE_ID,
      actorUserId: 7,
    });
  });
});
