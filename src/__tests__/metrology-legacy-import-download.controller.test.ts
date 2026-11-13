import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ source: vi.fn(), read: vi.fn(), send: vi.fn() }));

vi.mock("../module/metrologie/services/metrology-360.service", () => ({
  svcGetLegacyImportSourceFile: (...args: unknown[]) => mocks.source(...args),
  svcRecordLegacySourceRead: (...args: unknown[]) => mocks.read(...args),
  svcMetrologyDocsBaseDir: () => "metrology-root",
}));
vi.mock("../utils/cerpStorage", () => ({
  resolveCerpStoragePath: vi.fn(),
  resolveMetrologyDocumentStoragePath: (value: string, root: string) => `canonical:${root}:${value}`,
}));
vi.mock("../shared/uploads/secure-download", () => ({
  sendSecureStoredFile: (...args: unknown[]) => mocks.send(...args),
}));

import { downloadLegacyImportSource } from "../module/metrologie/controllers/metrology-360.controller";

const sourceId = "11111111-1111-4111-8111-111111111111";

function app() {
  const server = express();
  server.use(((req, _res, next) => {
    req.user = { id: 42, username: "metrology", role: "Métrologie" };
    next();
  }) as RequestHandler);
  server.get("/legacy-import-sources/:id/file", downloadLegacyImportSource);
  return server;
}

beforeEach(() => {
  mocks.source.mockReset();
  mocks.read.mockReset();
  mocks.send.mockReset();
  mocks.source.mockResolvedValue({
    storage_path: `uploads/docs/legacy-import/${"a".repeat(64)}/${"b".repeat(64)}.pdf`,
    source_name: "source.pdf", mime_type: "application/pdf", sha256: "c".repeat(64), av_status: "CLEAN",
  });
  mocks.read.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async (res: express.Response) => { res.status(200).send("bytes"); });
});

describe("legacy import source download", () => {
  it("uses the canonical resolver before the SHA-guarded secure download", async () => {
    const response = await request(app()).get(`/legacy-import-sources/${sourceId}/file`);
    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filePath: expect.stringMatching(/^canonical:metrology-root:uploads\/docs\/legacy-import\//),
      allowedRoots: ["metrology-root"], expectedSha256: "c".repeat(64), download: true,
    }));
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
  });
});
