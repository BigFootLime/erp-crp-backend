import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { HttpError } from "../utils/httpError";
import { setLogSinkForTests } from "../shared/observability/logger";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  getClient: vi.fn(),
  getFournisseur: vi.fn(),
  getCommande: vi.fn(),
  getOf: vi.fn(),
  getPieceTechnique: vi.fn(),
  getAffaire: vi.fn(),
  getStockArticle: vi.fn(),
  envelope: vi.fn(),
  read: vi.fn(),
  print: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

// The test uses the real mounted v1 router. Authentication is intentionally
// minimal but rejects a missing bearer token before controllers/services run.
vi.mock("../module/auth/middlewares/auth.middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/auth/middlewares/auth.middleware")>();
  return {
    ...actual,
    authenticateToken: (
      req: { user?: unknown; headers: Record<string, string | string[] | undefined> },
      res: { status: (status: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      if (typeof req.headers.authorization !== "string" || !req.headers.authorization.startsWith("Bearer ")) {
        res.status(401).json({ code: "UNAUTHORIZED" });
        return;
      }
      const role = typeof req.headers["x-test-role"] === "string"
        ? req.headers["x-test-role"]
        : "Administrateur Systeme et Reseau";
      req.user = { id: 7, username: "mounted-test", email: "mounted@example.test", role };
      next();
    },
  };
});

// Keep the real app/router composition while making the global account-module
// decision explicit and deterministic for the rejection matrix below.
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (
    req: { headers: Record<string, string | string[] | undefined> },
    res: { status: (status: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (req.headers["x-test-module"] === "denied") {
      res.status(403).json({ code: "MODULE_ACCESS_FORBIDDEN" });
      return;
    }
    next();
  },
}));

vi.mock("../module/client/services/clients.read.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/client/services/clients.read.service")>()),
  svcGetClientById: mocks.getClient,
}));
vi.mock("../module/fournisseurs/services/fournisseurs.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/fournisseurs/services/fournisseurs.service")>()),
  getFournisseurSVC: mocks.getFournisseur,
}));
vi.mock("../module/commande-client/services/commande-client.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/commande-client/services/commande-client.service")>()),
  getCommandeSVC: mocks.getCommande,
}));
vi.mock("../module/production/services/production.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/production/services/production.service")>()),
  svcGetOrdreFabrication: mocks.getOf,
}));
vi.mock("../module/pieces-techniques/services/pieces-techniques.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/pieces-techniques/services/pieces-techniques.service")>()),
  getPieceTechniqueSVC: mocks.getPieceTechnique,
}));
vi.mock("../module/affaire/services/affaire.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/affaire/services/affaire.service")>()),
  svcGetAffaire: mocks.getAffaire,
}));
vi.mock("../module/stock/services/stock.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module/stock/services/stock.service")>()),
  getStockArticleSVC: mocks.getStockArticle,
}));
vi.mock("../shared/authoritative-documents/authoritative-document.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/authoritative-documents/authoritative-document.service")>()),
  getOfficialDocumentGenerationEnvelope: mocks.envelope,
  readOfficialPdfBytes: mocks.read,
  recordOfficialPdfPrintIntent: mocks.print,
}));

import app from "../config/app";

const ARCHIVE_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ARCHIVE_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_BYTES = Buffer.from("%PDF-1.7 mounted immutable snapshot\n%%EOF\n", "utf8");

function binaryParser(response: NodeJS.ReadableStream, callback: (error: Error | null, value?: Buffer) => void): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  response.on("error", (error: Error) => callback(error));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
}

type MountedRoute = Readonly<{
  label: string;
  path: string;
  entityType: string;
  documentKind: string;
  baseUrl: string;
  root: ReturnType<typeof vi.fn>;
  expectRootLookup: () => void;
}>;

const clientId = "client-mounted";
const fournisseurId = "33333333-3333-4333-8333-333333333333";
const commandeId = "42";
const ofId = "73";
const pieceTechniqueId = "44444444-4444-4444-8444-444444444444";
const affaireId = "91";
const stockArticleId = "55555555-5555-4555-8555-555555555555";

const routes: readonly MountedRoute[] = [
  {
    label: "client",
    path: `/api/v1/clients/${clientId}/creation-snapshot`,
    entityType: "client",
    documentKind: "CLIENT_CREATION_SNAPSHOT",
    baseUrl: `/clients/${clientId}/creation-snapshot`,
    root: mocks.getClient,
    expectRootLookup: () => expect(mocks.getClient).toHaveBeenCalledWith(clientId, { includeSensitiveFinance: false }),
  },
  {
    label: "fournisseur",
    path: `/api/v1/fournisseurs/${fournisseurId}/creation-snapshot`,
    entityType: "fournisseur",
    documentKind: "SUPPLIER_CREATION_SNAPSHOT",
    baseUrl: `/fournisseurs/${fournisseurId}/creation-snapshot`,
    root: mocks.getFournisseur,
    expectRootLookup: () => expect(mocks.getFournisseur).toHaveBeenCalledWith(fournisseurId),
  },
  {
    label: "commande client",
    path: `/api/v1/commandes/${commandeId}/creation-snapshot`,
    entityType: "commande-client",
    documentKind: "CUSTOMER_ORDER_CREATION_SNAPSHOT",
    baseUrl: `/commandes/${commandeId}/creation-snapshot`,
    root: mocks.getCommande,
    expectRootLookup: () => expect(mocks.getCommande).toHaveBeenCalledWith(commandeId, expect.any(Set)),
  },
  {
    label: "ordre de fabrication",
    path: `/api/v1/production/ofs/${ofId}/creation-snapshot`,
    entityType: "ordre-fabrication",
    documentKind: "OF_CREATION_SNAPSHOT",
    baseUrl: `/production/ofs/${ofId}/creation-snapshot`,
    root: mocks.getOf,
    expectRootLookup: () => expect(mocks.getOf).toHaveBeenCalledWith({ id: Number(ofId), user_id: 7 }),
  },
  {
    label: "pièce technique",
    path: `/api/v1/pieces-techniques/${pieceTechniqueId}/creation-snapshot`,
    entityType: "piece-technique",
    documentKind: "TECHNICAL_PIECE_CREATION_SNAPSHOT",
    baseUrl: `/pieces-techniques/${pieceTechniqueId}/creation-snapshot`,
    root: mocks.getPieceTechnique,
    expectRootLookup: () => expect(mocks.getPieceTechnique).toHaveBeenCalledWith(pieceTechniqueId, expect.any(Set)),
  },
  {
    label: "affaire",
    path: `/api/v1/affaires/${affaireId}/creation-snapshot`,
    entityType: "affaire",
    documentKind: "AFFAIR_CREATION_SNAPSHOT",
    baseUrl: `/affaires/${affaireId}/creation-snapshot`,
    root: mocks.getAffaire,
    expectRootLookup: () => expect(mocks.getAffaire).toHaveBeenCalledWith(Number(affaireId), ""),
  },
  {
    label: "article stock",
    path: `/api/v1/stock/articles/${stockArticleId}/creation-snapshot`,
    entityType: "stock-article",
    documentKind: "STOCK_ARTICLE_CREATION_SNAPSHOT",
    baseUrl: `/stock/articles/${stockArticleId}/creation-snapshot`,
    root: mocks.getStockArticle,
    expectRootLookup: () => expect(mocks.getStockArticle).toHaveBeenCalledWith(stockArticleId, false),
  },
];

function authenticated(requestBuilder: request.Test): request.Test {
  return requestBuilder.set("Authorization", "Bearer mounted-test");
}

beforeEach(() => {
  // The error-path matrix intentionally exercises 401/403/404 responses.
  // Keep CI output focused on assertions rather than structured application logs.
  setLogSinkForTests(() => {});
  mocks.poolQuery.mockReset().mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockReset().mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.clientQuery.mockReset().mockResolvedValue({ rows: [] });
  mocks.clientRelease.mockReset();

  for (const root of [
    mocks.getClient,
    mocks.getFournisseur,
    mocks.getCommande,
    mocks.getOf,
    mocks.getPieceTechnique,
    mocks.getAffaire,
    mocks.getStockArticle,
  ]) {
    root.mockReset().mockResolvedValue({ id: "visible" });
  }
  mocks.envelope.mockReset().mockResolvedValue({
    state: "READY",
    latest_document: { id: ARCHIVE_ID },
    retryable: false,
    failure_code: null,
  });
  mocks.read.mockReset().mockResolvedValue({
    bytes: SNAPSHOT_BYTES,
    filename: "creation-snapshot.pdf",
    sha256: "a".repeat(64),
  });
  mocks.print.mockReset().mockResolvedValue(undefined);
});

afterAll(() => setLogSinkForTests(null));

describe("mounted Wave 2 creation-snapshot routes", () => {
  it.each(routes)("rejects unauthenticated $label route before its root/archive adapter", async (route) => {
    const response = await request(app).get(route.path);

    expect(response.status).toBe(401);
    expect(route.root).not.toHaveBeenCalled();
    expect(mocks.envelope).not.toHaveBeenCalled();
  });

  it.each(routes)("honors the global module-access rejection on actual $label mount", async (route) => {
    const response = await authenticated(request(app).get(route.path)).set("x-test-module", "denied");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: "MODULE_ACCESS_FORBIDDEN" });
    expect(route.root).not.toHaveBeenCalled();
    expect(mocks.envelope).not.toHaveBeenCalled();
  });

  it("routes every mounted aggregate to its fixed kind after the real root-scope adapter", async () => {
    for (const route of routes) {
      route.root.mockClear();
      mocks.envelope.mockClear();
      const response = await authenticated(request(app).get(route.path));

      expect(response.status, route.label).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.body).toMatchObject({ state: "READY", latest_document: { id: ARCHIVE_ID } });
      route.expectRootLookup();
      expect(mocks.envelope).toHaveBeenCalledWith({
        tx: expect.any(Object),
        entityType: route.entityType,
        entityId: route.path.split("/").at(-2),
        documentKind: route.documentKind,
        baseUrl: route.baseUrl,
      });
    }
  });

  it("returns the same 404 before archive metadata for a scoped-away root on every mount", async () => {
    for (const route of routes) {
      mocks.envelope.mockClear();
      route.root.mockResolvedValueOnce(null);
      const response = await authenticated(request(app).get(route.path));

      expect(response.status, route.label).toBe(404);
      expect(response.body.code).toBe("CREATION_SNAPSHOT_ENTITY_NOT_FOUND");
      expect(mocks.envelope, route.label).not.toHaveBeenCalled();
    }
  });

  it("retains aggregate export/read capability guards where the module has one", async () => {
    const deniedCases = [
      { path: `/api/v1/commandes/${commandeId}/creation-snapshot`, role: "Employee" },
      { path: `/api/v1/affaires/${affaireId}/creation-snapshot`, role: "Employee" },
      { path: `/api/v1/stock/articles/${stockArticleId}/creation-snapshot`, role: "Commercial" },
    ] as const;

    for (const denied of deniedCases) {
      mocks.envelope.mockClear();
      const response = await authenticated(request(app).get(denied.path)).set("x-test-role", denied.role);
      expect(response.status, denied.path).toBe(403);
      expect(mocks.envelope, denied.path).not.toHaveBeenCalled();
    }
  });

  it("serves the exact immutable command snapshot bytes through both mounted PDF surfaces", async () => {
    const base = `/api/v1/commandes/${commandeId}/creation-snapshot/${ARCHIVE_ID}`;
    const preview = await authenticated(request(app).get(`${base}/preview`)).buffer(true).parse(binaryParser);
    const download = await authenticated(request(app).get(`${base}/download`)).buffer(true).parse(binaryParser);

    for (const response of [preview, download]) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(SNAPSHOT_BYTES);
      expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
      expect(response.headers["content-length"]).toBe(String(SNAPSHOT_BYTES.byteLength));
      expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(preview.headers["content-disposition"]).toContain('inline; filename="creation-snapshot.pdf"');
    expect(download.headers["content-disposition"]).toContain('attachment; filename="creation-snapshot.pdf"');
    expect(mocks.read).toHaveBeenNthCalledWith(1, {
      entityType: "commande-client",
      entityId: commandeId,
      documentKind: "CUSTOMER_ORDER_CREATION_SNAPSHOT",
      archiveId: ARCHIVE_ID,
      actorUserId: 7,
      eventType: "AUTHORITATIVE_PDF_PREVIEWED",
    });
    expect(mocks.read).toHaveBeenNthCalledWith(2, {
      entityType: "commande-client",
      entityId: commandeId,
      documentKind: "CUSTOMER_ORDER_CREATION_SNAPSHOT",
      archiveId: ARCHIVE_ID,
      actorUserId: 7,
      eventType: "AUTHORITATIVE_PDF_DOWNLOADED",
    });
  });

  it("rejects malformed and foreign archive IDs without falling back to another document", async () => {
    const root = `/api/v1/commandes/${commandeId}/creation-snapshot`;
    const malformed = await authenticated(request(app).get(`${root}/not-a-uuid/download`));
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_ROUTE_PARAM");
    expect(mocks.read).not.toHaveBeenCalled();

    mocks.read.mockRejectedValueOnce(
      new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable.")
    );
    const foreign = await authenticated(request(app).get(`${root}/${FOREIGN_ARCHIVE_ID}/download`));
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("OFFICIAL_DOCUMENT_NOT_FOUND");
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ archiveId: FOREIGN_ARCHIVE_ID }));
  });

  it("records a byte-free print intent through the mounted stock-article route", async () => {
    const response = await authenticated(
      request(app).post(`/api/v1/stock/articles/${stockArticleId}/creation-snapshot/${ARCHIVE_ID}/print-intents`)
    );

    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(mocks.print).toHaveBeenCalledWith({
      entityType: "stock-article",
      entityId: stockArticleId,
      documentKind: "STOCK_ARTICLE_CREATION_SNAPSHOT",
      archiveId: ARCHIVE_ID,
      actorUserId: 7,
    });
  });
});
