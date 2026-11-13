import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), upload: vi.fn(), parent: vi.fn(), content: vi.fn(),
  audit: vi.fn(), send: vi.fn(), authorized: vi.fn(), downloaded: vi.fn(),
  createUpload: vi.fn(),
}));

vi.mock("../module/metrologie/services/metrology-documents.service", () => ({
  listEquipmentDocuments: (...args: unknown[]) => mocks.list(...args),
  uploadEquipmentDocument: (...args: unknown[]) => mocks.upload(...args),
  assertEquipmentDocumentParent: (...args: unknown[]) => mocks.parent(...args),
  getEquipmentDocumentContent: (...args: unknown[]) => mocks.content(...args),
  scanMetadataSchema: { safeParse: vi.fn() },
}));
vi.mock("../shared/uploads/secure-upload", () => ({
  createSecureUpload: (...args: unknown[]) => {
    mocks.createUpload(...args);
    return { single: () => (_req: unknown, _res: unknown, next: () => void) => next() };
  },
}));
vi.mock("../shared/uploads/secure-download", () => ({
  sendSecureStoredFile: (...args: any[]) => mocks.send(...args),
}));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: (...args: unknown[]) => mocks.audit(...args) }));
vi.mock("../module/ged/services/ged.service", () => ({
  recordVersionDownloadAuthorized: (...args: unknown[]) => mocks.authorized(...args),
  recordVersionDownload: (...args: unknown[]) => mocks.downloaded(...args),
}));
vi.mock("../utils/cerpStorage", () => ({
  resolveMetrologyDocumentStoragePath: (value: string, root: string) => `resolved:${root}:${value}`,
}));
vi.mock("../module/metrologie/services/metrology-360.service", () => ({ svcMetrologyDocsBaseDir: () => "metrology-root" }));

import { errorHandler } from "../middlewares/errorHandler";
import routes from "../module/metrologie/routes/metrology-documents.routes";

const equipmentId = "11111111-1111-4111-8111-111111111111";
const documentId = "33333333-3333-4333-8333-333333333333";

function app(role: string | null) {
  const server = express();
  server.use(((req, _res, next) => { if (role) req.user = { id: 42, username: "test", role }; next(); }) as RequestHandler);
  server.use("/metrologie", routes);
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  for (const [key, mock] of Object.entries(mocks)) if (key !== "createUpload") mock.mockReset();
  mocks.parent.mockResolvedValue({});
  mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 200, has_more: false });
  mocks.audit.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async (res: express.Response) => { res.status(200).send("bytes"); return "completed"; });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("metrology document routes", () => {
  it("uses bounded disk staging with deferred scanning; it never accepts upload bytes in memory", () => {
    expect(mocks.createUpload).toHaveBeenCalledWith("quality-document", {
      storage: "staging", scan: "deferred", maxFiles: 1,
    });
  });

  it("fails closed without a document-read capability before reaching the service", async () => {
    expect((await request(app(null)).get(`/metrologie/equipements/${equipmentId}/documents`)).status).toBe(401);
    expect((await request(app("Commercial")).get(`/metrologie/equipements/${equipmentId}/documents`)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("validates bounded pagination and passes its normalized values", async () => {
    const accepted = await request(app("Métrologie")).get(`/metrologie/equipements/${equipmentId}/documents?page=2&pageSize=10`);
    expect(accepted.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ id: 42, role: "Métrologie" }, equipmentId, 2, 10);

    const rejected = await request(app("Métrologie")).get(`/metrologie/equipements/${equipmentId}/documents?page=0&extra=1`);
    expect(rejected.status).toBe(422);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("writes the source-document audit receipt before handing bytes to the download helper", async () => {
    mocks.content.mockResolvedValue({ kind: "source", source: {
      id: documentId, storage_path: "legacy/input.xlsx", source_name: "input.xlsx", mime_type: null,
      sha256: "f".repeat(64), av_status: "CLEAN",
    } });
    const response = await request(app("Métrologie")).get(`/metrologie/equipements/${equipmentId}/documents/${documentId}/file`);
    expect(response.status).toBe(200);
    expect(response.headers["x-cerp-document-sha256"]).toBe("f".repeat(64));
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filePath: "resolved:metrology-root:legacy/input.xlsx", allowedRoots: ["metrology-root"], expectedSha256: "f".repeat(64), download: true,
    }));
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
  });
});
