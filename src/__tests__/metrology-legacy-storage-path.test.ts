import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { errorHandler } from "../middlewares/errorHandler";
import { sendSecureStoredFile } from "../shared/uploads/secure-download";
import { resolveCerpStoragePath, resolveMetrologyDocumentStoragePath } from "../utils/cerpStorage";

const sourceSetSha = "a".repeat(64);
const blobSha = "b".repeat(64);
const historicalPath = `uploads/docs/legacy-import/${sourceSetSha}/${blobSha}.pdf`;
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("legacy metrology source storage", () => {
  it("maps the immutable reference to the canonical real vault and preserves SHA delivery", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-metrology-vault-"));
    const baseDir = path.join(temporaryRoot, "metrologie");
    const filePath = path.join(baseDir, "legacy-import", sourceSetSha, `${blobSha}.pdf`);
    const contents = Buffer.from("immutable metrology source");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    expect(resolveMetrologyDocumentStoragePath(historicalPath, baseDir)).toBe(filePath);

    const app = express();
    app.get("/source", async (_req, res, next) => {
      try {
        await sendSecureStoredFile(res, {
          filePath: resolveMetrologyDocumentStoragePath(historicalPath, baseDir),
          allowedRoots: [baseDir], filename: "source.pdf", mimeType: "application/pdf", download: true,
          expectedSha256: crypto.createHash("sha256").update(contents).digest("hex"),
        });
      } catch (error) { next(error); }
    });
    app.use(errorHandler);

    const response = await request(app).get("/source");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(contents);
    expect(response.headers["content-disposition"]).toContain("attachment");
  });

  it.each([
    "uploads/docs/legacy-import/../outside.pdf",
    `uploads/docs/legacy-import/${sourceSetSha}/%2e%2e.pdf`,
    `uploads/docs/legacy-import/${sourceSetSha}/${blobSha}.exe`,
    `uploads/docs/legacy-import/${sourceSetSha.toUpperCase()}/${blobSha}.pdf`,
    `uploads/docs/legacy-import/${sourceSetSha}\\${blobSha}.pdf`,
    `/uploads/docs/legacy-import/${sourceSetSha}/${blobSha}.pdf`,
  ])("rejects malformed or non-canonical legacy metadata: %s", (storagePath) => {
    try {
      resolveMetrologyDocumentStoragePath(storagePath, "C:/metrologie");
      throw new Error("expected invalid legacy storage path to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_STORAGE_PATH" });
    }
  });

  it("leaves canonical and unknown non-legacy paths on the existing resolver", () => {
    const canonical = `uploads/docs/metrologie/legacy-import/${sourceSetSha}/${blobSha}.pdf`;
    const unknown = "uploads/docs/not-metrology/unknown.pdf";
    expect(resolveMetrologyDocumentStoragePath(canonical, "C:/metrologie")).toBe(resolveCerpStoragePath(canonical));
    expect(resolveMetrologyDocumentStoragePath(unknown, "C:/metrologie")).toBe(resolveCerpStoragePath(unknown));
  });
});
