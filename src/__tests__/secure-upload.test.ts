import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../utils/httpError";
import {
  assertSafeUploadName,
  contentMatchesExtension,
  createSecureUpload,
  registerUploadDestination,
} from "../shared/uploads/secure-upload";
import {
  assertSecureDownloadPath,
  buildContentDisposition,
} from "../shared/uploads/secure-download";
import { setUploadScannerForTests } from "../shared/uploads/upload-scanner";

const VALID_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii");

function errorHandler(): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500;
    res.status(status).json({
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Erreur interne",
    });
  };
}

function uploadApp(options?: {
  failAfterUpload?: boolean;
  moveBeforeFailureTo?: string;
  usage?: "business-document" | "image";
}) {
  const app = express();
  const usage = options?.usage ?? "business-document";
  const upload = createSecureUpload(usage);
  app.post("/upload", upload.array("documents[]", 10), async (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (options?.moveBeforeFailureTo && files[0]) {
        await fs.mkdir(options.moveBeforeFailureTo, { recursive: true });
        const destination = path.join(options.moveBeforeFailureTo, "stored.pdf");
        const sourcePath = files[0].path;
        await fs.rename(sourcePath, destination);
        registerUploadDestination({ path: sourcePath }, destination);
      }
      if (options?.failAfterUpload) {
        next(new HttpError(409, "BUSINESS_ROLLBACK", "Transaction métier annulée."));
        return;
      }
      res.status(201).json({ files: files.map((file) => file.uploadSecurity) });
    } catch (error) {
      next(error);
    }
  });
  app.use(errorHandler());
  return app;
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe("politique centrale des uploads", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-secure-upload-"));
    process.env.CERP_TMP_ROOT = temporaryRoot;
    process.env.CERP_UPLOAD_SCAN_MODE = "off";
    delete process.env.CERP_UPLOAD_SCAN_PROVIDER;
    setUploadScannerForTests(null);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setUploadScannerForTests(null);
    delete process.env.CERP_TMP_ROOT;
    delete process.env.CERP_UPLOAD_SCAN_MODE;
    delete process.env.CERP_UPLOAD_SCAN_PROVIDER;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("accepte un PDF inoffensif et calcule son empreinte", async () => {
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "controle.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.files[0]).toMatchObject({
      usage: "business-document",
      scanStatus: "unavailable",
      scanProvider: "disabled",
    });
    expect(response.body.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuse une extension trompeuse même si le MIME annoncé paraît cohérent", async () => {
    const executable = Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(32)]);
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", executable, { filename: "preuve.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(415);
    expect(response.body.code).toBe("UPLOAD_EXECUTABLE_FORBIDDEN");
  });

  it("refuse un MIME incohérent avant l’écriture du contenu", async () => {
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "preuve.pdf", contentType: "image/png" });

    expect(response.status).toBe(415);
    expect(response.body.code).toBe("UPLOAD_MIME_MISMATCH");
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it("refuse un fichier zéro octet", async () => {
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", Buffer.alloc(0), { filename: "vide.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("UPLOAD_EMPTY_FILE");
  });

  it("applique la limite de taille centralisée", async () => {
    const oversizedImage = Buffer.alloc(10 * 1024 * 1024 + 1);
    oversizedImage.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const response = await request(uploadApp({ usage: "image" }))
      .post("/upload")
      .attach("documents[]", oversizedImage, { filename: "atelier.png", contentType: "image/png" });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("UPLOAD_FILE_TOO_LARGE");
  });

  it("refuse le traversal et les noms ambigus", () => {
    for (const name of ["../../preuve.pdf", "..\\..\\preuve.pdf", "preuve.pdf\r\nX-Test: oui", "preuve\u202Efdp.exe"]) {
      expect(() => assertSafeUploadName(name)).toThrowError(expect.objectContaining({ code: "UPLOAD_NAME_INVALID" }));
    }
  });

  it("refuse un doublon de contenu dans le même lot", async () => {
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "a.pdf", contentType: "application/pdf" })
      .attach("documents[]", VALID_PDF, { filename: "b.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("UPLOAD_DUPLICATE_FILE");
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it("compense le staging et le stockage final lorsque la transaction métier est annulée", async () => {
    const finalDirectory = path.join(temporaryRoot, "documents");
    const response = await request(uploadApp({ failAfterUpload: true, moveBeforeFailureTo: finalDirectory }))
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "rollback.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it("échoue fermé en mode enforce lorsqu’aucun scanner réel n’est configuré", async () => {
    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "preuve.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("UPLOAD_SCAN_UNAVAILABLE");
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it("valide les signatures sans se fier au seul nom", () => {
    const pdfSample = { head: VALID_PDF, tail: VALID_PDF };
    const fakePng = { head: VALID_PDF, tail: VALID_PDF };
    expect(contentMatchesExtension(".pdf", pdfSample, VALID_PDF.length)).toBe(true);
    expect(contentMatchesExtension(".png", fakePng, VALID_PDF.length)).toBe(false);
  });
});

describe("téléchargement sécurisé et compatibilité historique", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-download-root-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-download-outside-"));
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("sert un fichier historique contenu dans sa racine sans revalider son format", async () => {
    const legacy = path.join(root, "legacy-sans-extension");
    await fs.writeFile(legacy, "historique");
    await expect(assertSecureDownloadPath(legacy, [root])).resolves.toBe(await fs.realpath(legacy));
  });

  it("refuse un fichier extérieur à la racine autorisée", async () => {
    const escaped = path.join(outside, "secret.txt");
    await fs.writeFile(escaped, "hors périmètre");
    await expect(assertSecureDownloadPath(escaped, [root])).rejects.toMatchObject({ code: "INVALID_STORAGE_PATH" });
  });

  it("neutralise traversal, CRLF et Unicode dans Content-Disposition", () => {
    const header = buildContentDisposition("../../contrôle.pdf\r\nX-Evil: yes", true);
    expect(header).toContain("attachment;");
    expect(header).toContain("filename*=UTF-8''");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header).not.toContain("../");
  });
});
