import nodeFs from "node:fs";
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
  cleanupUploadsAfterConfirmedRollback,
  cleanupUploadsAfterReconciledNoCommit,
  createSecureUpload,
  getRegisteredUploadDestinationCountForTests,
  markUploadCommitAttempted,
  markUploadCommitUncertain,
  markUploadsCommitted,
  registerUploadDestination,
} from "../shared/uploads/secure-upload";
import {
  assertSecureDownloadPath,
  buildContentDisposition,
  sendSecureStoredFile,
  setSecureDownloadHookForTests,
} from "../shared/uploads/secure-download";
import {
  assertUploadScannerConfiguration,
  getUploadScanMode,
  getUploadScannerStartupConfiguration,
  scanUpload,
  setUploadScannerForTests,
} from "../shared/uploads/upload-scanner";

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
  failureStatus?: 409 | 422 | 500;
  moveBeforeFailureTo?: string;
  usage?: "business-document" | "technical-document" | "image";
  ownership?: "rolled-back" | "not-committed" | "commit-attempted" | "committed";
  disconnectAfterCommit?: boolean;
  disconnectBeforeOwnership?: boolean;
  disconnectBeforeRegistration?: boolean;
  onOwnershipSettled?: () => void;
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
        const references = [files[0]];
        if (options.disconnectBeforeRegistration) {
          res.socket?.destroy();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        registerUploadDestination(references[0], destination);
        if (options.disconnectBeforeOwnership) {
          res.socket?.destroy();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (options.ownership === "rolled-back") {
          await cleanupUploadsAfterConfirmedRollback(references);
        } else if (options.ownership === "not-committed") {
          markUploadCommitAttempted(references);
          await cleanupUploadsAfterReconciledNoCommit(references);
        } else if (options.ownership === "commit-attempted") {
          markUploadCommitAttempted(references);
          markUploadCommitUncertain(references);
        } else if (options.ownership === "committed") {
          markUploadCommitAttempted(references);
          markUploadsCommitted(references);
        }
        options.onOwnershipSettled?.();
        if (options.disconnectBeforeOwnership || options.disconnectBeforeRegistration) return;
        if (options.disconnectAfterCommit) {
          res.socket?.destroy();
          return;
        }
      }
      if (options?.failAfterUpload) {
        const status = options.failureStatus ?? 409;
        next(status === 500
          ? new Error("downstream failure")
          : new HttpError(status, "BUSINESS_ROLLBACK", "Transaction métier annulée."));
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

  it("crée la quarantaine privée et garde le staging en 0600 avant et pendant le scan", async () => {
    process.env.CERP_UPLOAD_SCAN_MODE = "monitor";
    const mkdirSpy = vi.spyOn(nodeFs, "mkdirSync");
    const directoryChmodSpy = vi.spyOn(nodeFs, "chmodSync");
    const directoryFchmodSpy = vi.spyOn(nodeFs, "fchmodSync");
    const openSpy = vi.spyOn(nodeFs, "open");
    let notifyScanStarted!: (filePath: string) => void;
    const scanStarted = new Promise<string>((resolve) => { notifyScanStarted = resolve; });
    let releaseScan!: () => void;
    const scanRelease = new Promise<void>((resolve) => { releaseScan = resolve; });

    setUploadScannerForTests({
      name: "permission-gate-scanner",
      scan: async (input) => {
        if (!input.path) throw new Error("disk staging path expected");
        notifyScanStarted(input.path);
        await scanRelease;
        return { status: "clean", provider: "permission-gate-scanner" };
      },
    });

    const responsePromise = request(uploadApp())
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "permissions.pdf", contentType: "application/pdf" })
      .then((response) => response);
    const stagingPath = await scanStarted;

    try {
      const quarantineDirectory = path.resolve(
        temporaryRoot,
        "upload-quarantine",
        "business-document"
      );
      expect(mkdirSpy).toHaveBeenCalledWith(quarantineDirectory, {
        mode: 0o700,
      });
      if (process.platform === "win32") {
        expect(directoryChmodSpy).toHaveBeenCalledWith(quarantineDirectory, 0o700);
      } else {
        expect(directoryFchmodSpy).toHaveBeenCalledWith(expect.any(Number), 0o700);
      }
      expect(openSpy.mock.calls.some(([candidate, flags, mode]) =>
        path.resolve(String(candidate)) === path.resolve(stagingPath) && flags === "wx" && mode === 0o600
      )).toBe(true);
      if (process.platform !== "win32") {
        expect((await fs.stat(quarantineDirectory)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(stagingPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      releaseScan();
    }

    const response = await responsePromise;
    expect(response.status).toBe(201);
  });

  it("échoue fermé et nettoie le staging si le chmod défensif échoue", async () => {
    process.env.CERP_UPLOAD_SCAN_MODE = "monitor";
    const scan = vi.fn(async () => ({ status: "clean" as const, provider: "must-not-run" }));
    setUploadScannerForTests({ name: "must-not-run", scan });
    const actualOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen(...args);
      if (String(args[1]) !== "wx") {
        vi.spyOn(handle, "chmod").mockRejectedValue(Object.assign(new Error("permission denied"), {
          code: "EACCES",
        }));
      }
      return handle;
    });

    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "chmod-eacces.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("UPLOAD_STAGING_PERMISSION_FAILED");
    expect(response.body.message).not.toContain(temporaryRoot);
    expect(scan).not.toHaveBeenCalled();
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it("refuse une extension trompeuse même si le MIME annoncé paraît cohérent", async () => {
    const executable = Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(32)]);
    const response = await request(uploadApp())
      .post("/upload")
      .attach("documents[]", executable, { filename: "preuve.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(415);
    expect(response.body.code).toBe("UPLOAD_EXECUTABLE_FORBIDDEN");
  });

  it("refuse un faux ZIP qui ne contient qu'un préfixe PK", async () => {
    const response = await request(uploadApp({ usage: "technical-document" }))
      .post("/upload")
      .attach("documents[]", Buffer.from("PKnot-a-zip", "ascii"), {
        filename: "preuve.zip",
        contentType: "application/zip",
      });

    expect(response.status).toBe(415);
    expect(response.body.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
    expect(await allFiles(temporaryRoot)).toEqual([]);
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
    const response = await request(uploadApp({
      failAfterUpload: true,
      moveBeforeFailureTo: finalDirectory,
      ownership: "rolled-back",
    }))
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "rollback.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it.each([422, 500] as const)("nettoie le staging image après un rejet aval %i", async (failureStatus) => {
    const response = await request(uploadApp({ usage: "image", failAfterUpload: true, failureStatus }))
      .post("/upload")
      .attach("documents[]", Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00,
      ]), { filename: "machine.png", contentType: "image/png" });

    expect(response.status).toBe(failureStatus);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await allFiles(temporaryRoot)).toEqual([]);
  });

  it("préserve la destination si COMMIT a été tenté puis son ACK perdu", async () => {
    const finalDirectory = path.join(temporaryRoot, "documents");
    const response = await request(uploadApp({
      failAfterUpload: true,
      moveBeforeFailureTo: finalDirectory,
      ownership: "commit-attempted",
    }))
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "ack-perdu.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fs.readFile(path.join(finalDirectory, "stored.pdf"))).toEqual(VALID_PDF);
  });

  it("ne supprime pas un fichier durable si le client se déconnecte après COMMIT", async () => {
    const finalDirectory = path.join(temporaryRoot, "documents");
    await request(uploadApp({
      moveBeforeFailureTo: finalDirectory,
      ownership: "committed",
      disconnectAfterCommit: true,
    }))
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "committed.pdf", contentType: "application/pdf" })
      .catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fs.readFile(path.join(finalDirectory, "stored.pdf"))).toEqual(VALID_PDF);
  });

  it.each([
    ["committed", true],
    ["rolled-back", false],
    ["not-committed", false],
    ["commit-attempted", true],
  ] as const)(
    "libère le registre après un close avant issue transactionnelle (%s)",
    async (ownership, preserved) => {
      const finalDirectory = path.join(temporaryRoot, `close-${ownership}`);
      let notifyOwnershipSettled!: () => void;
      const ownershipSettled = new Promise<void>((resolve) => { notifyOwnershipSettled = resolve; });
      await request(uploadApp({
        moveBeforeFailureTo: finalDirectory,
        ownership,
        disconnectBeforeOwnership: true,
        onOwnershipSettled: notifyOwnershipSettled,
      }))
        .post("/upload")
        .attach("documents[]", VALID_PDF, { filename: `${ownership}.pdf`, contentType: "application/pdf" })
        .catch(() => undefined);

      await Promise.race([
        ownershipSettled,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`ownership settlement timeout: ${ownership}`)),
          2_000
        )),
      ]);
      const finalPresent = await fs.stat(path.join(finalDirectory, "stored.pdf"))
        .then((stat) => stat.isFile())
        .catch(() => false);
      expect(finalPresent).toBe(preserved);
      expect(getRegisteredUploadDestinationCountForTests()).toBe(0);
    }
  );

  it("stabilise 32 close avant rapprochement not-committed sans faux ownership résiduel", async () => {
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const finalDirectory = path.join(temporaryRoot, `close-not-committed-stress-${iteration}`);
      let notifyOwnershipSettled!: () => void;
      const ownershipSettled = new Promise<void>((resolve) => { notifyOwnershipSettled = resolve; });

      await request(uploadApp({
        moveBeforeFailureTo: finalDirectory,
        ownership: "not-committed",
        disconnectBeforeOwnership: true,
        onOwnershipSettled: notifyOwnershipSettled,
      }))
        .post("/upload")
        .attach("documents[]", VALID_PDF, {
          filename: `not-committed-${iteration}.pdf`,
          contentType: "application/pdf",
        })
        .catch(() => undefined);

      await Promise.race([
        ownershipSettled,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`stress ownership settlement timeout: ${iteration}`)),
          2_000
        )),
      ]);
      await expect(fs.stat(path.join(finalDirectory, "stored.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(getRegisteredUploadDestinationCountForTests()).toBe(0);
    }
  });

  it("libère aussi le registre quand le close précède l'enregistrement de la destination", async () => {
    const finalDirectory = path.join(temporaryRoot, "close-before-register");
    await request(uploadApp({
      moveBeforeFailureTo: finalDirectory,
      ownership: "committed",
      disconnectBeforeRegistration: true,
    }))
      .post("/upload")
      .attach("documents[]", VALID_PDF, { filename: "late-register.pdf", contentType: "application/pdf" })
      .catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(fs.stat(path.join(finalDirectory, "stored.pdf"))).resolves.toBeDefined();
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0);
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

  it("valide la structure exacte des STL binaires et les marqueurs STL ASCII", () => {
    const binaryStl = Buffer.alloc(84 + 50);
    binaryStl.writeUInt32LE(1, 80);
    expect(contentMatchesExtension(
      ".stl",
      { head: binaryStl, tail: binaryStl },
      binaryStl.length
    )).toBe(true);

    const wrongCount = Buffer.from(binaryStl);
    wrongCount.writeUInt32LE(2, 80);
    expect(contentMatchesExtension(
      ".stl",
      { head: wrongCount, tail: wrongCount },
      wrongCount.length
    )).toBe(false);

    const randomBinary = Buffer.alloc(134, 0x5a);
    expect(contentMatchesExtension(
      ".stl",
      { head: randomBinary, tail: randomBinary },
      randomBinary.length
    )).toBe(false);

    const asciiStl = Buffer.from(
      "solid fixture\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nendloop\nendfacet\nendsolid fixture\n",
      "ascii"
    );
    expect(contentMatchesExtension(
      ".stl",
      { head: asciiStl, tail: asciiStl },
      asciiStl.length
    )).toBe(true);
    const fakeAscii = Buffer.from("solid this is not an STL", "ascii");
    expect(contentMatchesExtension(
      ".stl",
      { head: fakeAscii, tail: fakeAscii },
      fakeAscii.length
    )).toBe(false);
  });
});

describe("configuration fail-closed du scanner", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    setUploadScannerForTests(null);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    delete process.env.CERP_UPLOAD_SCAN_MODE;
    delete process.env.CERP_UPLOAD_SCAN_PROVIDER;
    delete process.env.CERP_UPLOAD_SCANNER_COMMAND;
    delete process.env.CERP_UPLOAD_SCANNER_TIMEOUT_MS;
  });

  it.each(["production", "development", undefined])(
    "utilise enforce hors tests lorsque NODE_ENV=%s",
    (nodeEnv) => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      expect(getUploadScanMode()).toBe("enforce");
    }
  );

  it("conserve monitor uniquement pour le runtime de tests", () => {
    process.env.NODE_ENV = "test";
    expect(getUploadScanMode()).toBe("monitor");
  });

  it.each(["off", "monitor"] as const)(
    "refuse explicitement %s au démarrage en production et garde les scans fail-closed",
    async (mode) => {
      process.env.NODE_ENV = "production";
      process.env.CERP_UPLOAD_SCAN_MODE = mode;
      setUploadScannerForTests({
        name: "clean-test-double",
        scan: async () => ({ status: "clean", provider: "clean-test-double" }),
      });

      expect(() => assertUploadScannerConfiguration()).toThrow(
        `CERP_UPLOAD_SCAN_MODE=${mode} interdit hors tests`
      );
      await expect(scanUpload({ buffer: VALID_PDF })).resolves.toMatchObject({
        status: "unavailable",
        provider: "configuration",
        reason: "mode_interdit_hors_tests",
        mode: "enforce",
      });
    }
  );

  it("refuse au preflight un mode invalide et un scanner absent en enforce", () => {
    process.env.NODE_ENV = "development";
    process.env.CERP_UPLOAD_SCAN_MODE = "permissive";
    expect(() => assertUploadScannerConfiguration()).toThrow(/SCAN_MODE invalide/);

    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
    expect(() => assertUploadScannerConfiguration()).toThrow(/PROVIDER=clamdscan/);
  });

  it("accepte la configuration enforce explicite et cohérente", () => {
    // The startup probe is intentionally bypassed under Vitest so injected
    // UploadScanner doubles do not require a ClamAV installation.
    process.env.NODE_ENV = "test";
    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
    process.env.CERP_UPLOAD_SCAN_PROVIDER = "clamdscan";
    process.env.CERP_UPLOAD_SCANNER_COMMAND = "clamdscan-custom";
    expect(assertUploadScannerConfiguration()).toEqual({
      mode: "enforce",
      provider: "clamdscan",
      command: "clamdscan-custom",
      timeoutMs: 120_000,
    });
  });

  it("refuse au preflight enforce une commande ClamAV absente", () => {
    process.env.NODE_ENV = "development";
    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
    process.env.CERP_UPLOAD_SCAN_PROVIDER = "clamdscan";
    process.env.CERP_UPLOAD_SCANNER_COMMAND = "cerp-command-that-does-not-exist";

    expect(() => assertUploadScannerConfiguration()).toThrow(/commande introuvable ou inexécutable/);
    expect(getUploadScannerStartupConfiguration()).toMatchObject({
      mode: "enforce",
      provider: "clamdscan",
      ready: false,
      reason: "command_unavailable",
    });
  });

  it("refuse une commande existante qui retourne 0 sans s'identifier comme ClamAV", () => {
    process.env.NODE_ENV = "development";
    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
    process.env.CERP_UPLOAD_SCAN_PROVIDER = "clamdscan";
    process.env.CERP_UPLOAD_SCANNER_COMMAND = process.execPath;

    expect(() => assertUploadScannerConfiguration()).toThrow(/réponse de version inattendue/);
    expect(getUploadScannerStartupConfiguration()).toMatchObject({
      mode: "enforce",
      provider: "clamdscan",
      ready: false,
      reason: "unexpected_version",
    });
  });

  it("démarre en mode dégradé sans provider tout en conservant enforce", () => {
    process.env.NODE_ENV = "development";
    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";

    expect(getUploadScannerStartupConfiguration()).toEqual({
      mode: "enforce",
      provider: "none",
      command: null,
      timeoutMs: 120_000,
      ready: false,
      reason: "provider_missing",
    });
  });

  it("garde une configuration invalide fatale au démarrage", () => {
    process.env.NODE_ENV = "development";
    process.env.CERP_UPLOAD_SCAN_MODE = "permissive";

    expect(() => getUploadScannerStartupConfiguration()).toThrow(/SCAN_MODE invalide/);
  });

  it("refuse un timeout scanner hors de la borne documentée", () => {
    process.env.NODE_ENV = "test";
    process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
    process.env.CERP_UPLOAD_SCAN_PROVIDER = "clamdscan";
    process.env.CERP_UPLOAD_SCANNER_TIMEOUT_MS = "600000";

    expect(() => assertUploadScannerConfiguration()).toThrow(/SCANNER_TIMEOUT_MS invalide/);
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
    setSecureDownloadHookForTests(null);
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  function downloadApp(filePath: string, expectedSha256?: string, onSettled?: () => void) {
    const app = express();
    app.get("/download", async (_req, res, next) => {
      try {
        await sendSecureStoredFile(res, {
          filePath,
          allowedRoots: [root],
          filename: "document.txt",
          mimeType: "text/plain",
          download: true,
          expectedSha256,
        });
      } catch (error) {
        next(error);
      } finally {
        onSettled?.();
      }
    });
    app.use(errorHandler());
    return app;
  }

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

  it("refuse une substitution entre la validation et l’ouverture", async () => {
    const candidate = path.join(root, "document.txt");
    const replacement = path.join(root, "replacement.txt");
    await fs.writeFile(candidate, "contenu-original");
    await fs.writeFile(replacement, "contenu-remplace");
    setSecureDownloadHookForTests(async (phase) => {
      if (phase !== "after-validation") return;
      await fs.rename(candidate, path.join(root, "original-retire.txt"));
      await fs.rename(replacement, candidate);
    });

    const response = await request(downloadApp(candidate)).get("/download");
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_STORAGE_PATH");
  });

  it("refuse aussi une substitution du répertoire parent", async () => {
    const parent = path.join(root, "parent");
    const retiredParent = path.join(root, "parent-retired");
    const outsideParent = path.join(outside, "replacement-parent");
    await fs.mkdir(parent);
    await fs.mkdir(outsideParent);
    const candidate = path.join(parent, "document.txt");
    await fs.writeFile(candidate, "contenu-original");
    await fs.writeFile(path.join(outsideParent, "document.txt"), "secret-exterieur");
    setSecureDownloadHookForTests(async (phase) => {
      if (phase !== "after-validation") return;
      await fs.rename(parent, retiredParent);
      await fs.symlink(outsideParent, parent, "junction");
    });

    const response = await request(downloadApp(candidate)).get("/download");
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_STORAGE_PATH");
  });

  it("sert exactement le descripteur ouvert même si le nom est remplacé ensuite", async () => {
    const candidate = path.join(root, "document.txt");
    const replacement = path.join(root, "replacement.txt");
    await fs.writeFile(candidate, "contenu-original");
    await fs.writeFile(replacement, "contenu-remplace");
    setSecureDownloadHookForTests(async (phase) => {
      if (phase !== "after-open") return;
      await fs.rename(candidate, path.join(root, "original-ouvert.txt"));
      await fs.rename(replacement, candidate);
    });

    const response = await request(downloadApp(candidate)).get("/download");
    expect(response.status).toBe(200);
    expect(response.text).toBe("contenu-original");
  });

  it("vérifie l'empreinte puis diffuse le même descripteur sans le fermer", async () => {
    const candidate = path.join(root, "document-verifie.txt");
    const content = Buffer.from("contenu portail vérifié", "utf8");
    const expectedSha256 = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    await fs.writeFile(candidate, content);

    const response = await request(downloadApp(candidate, expectedSha256)).get("/download");

    expect(response.status).toBe(200);
    expect(Buffer.from(response.text, "utf8")).toEqual(content);
  });

  it("interrompt l'intégrité si le client ferme et ne ferme le handle qu'une fois", async () => {
    const candidate = path.join(root, "large-document.bin");
    const content = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const expectedSha256 = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    await fs.writeFile(candidate, content);

    let closeSpy: ReturnType<typeof vi.spyOn> | null = null;
    const phases: string[] = [];
    setSecureDownloadHookForTests(async (phase, context) => {
      phases.push(phase);
      if (phase === "after-open" && context.fileHandle) {
        closeSpy = vi.spyOn(context.fileHandle, "close");
      }
      if (phase === "during-integrity") {
        context.response?.destroy();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    let settleHandler!: () => void;
    const handlerSettled = new Promise<void>((resolve) => { settleHandler = resolve; });
    const requestResult = request(downloadApp(candidate, expectedSha256, settleHandler)).get("/download");
    await Promise.race([
      requestResult.catch(() => undefined),
      new Promise((_, reject) => setTimeout(() => reject(new Error("download abort timeout")), 1_000)),
    ]);
    await Promise.race([
      handlerSettled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("download handler abort timeout")), 1_000)),
    ]);

    expect(phases).toContain("during-integrity");
    expect(phases).not.toContain("before-stream");
    expect(closeSpy).not.toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("ne démarre pas le stream si le client ferme entre intégrité et pipe", async () => {
    const candidate = path.join(root, "verified-document.bin");
    const content = Buffer.from("contenu-vérifié");
    const expectedSha256 = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    await fs.writeFile(candidate, content);

    let closeSpy: ReturnType<typeof vi.spyOn> | null = null;
    let beforeStreamCalls = 0;
    setSecureDownloadHookForTests(async (phase, context) => {
      if (phase === "after-open" && context.fileHandle) {
        closeSpy = vi.spyOn(context.fileHandle, "close");
      }
      if (phase === "before-stream") {
        beforeStreamCalls += 1;
        context.response?.destroy();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    let settleHandler!: () => void;
    const handlerSettled = new Promise<void>((resolve) => { settleHandler = resolve; });
    const requestResult = request(downloadApp(candidate, expectedSha256, settleHandler)).get("/download");
    await Promise.race([
      requestResult.catch(() => undefined),
      new Promise((_, reject) => setTimeout(() => reject(new Error("download pre-stream abort timeout")), 1_000)),
    ]);
    await Promise.race([
      handlerSettled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("download pre-stream handler timeout")), 1_000)),
    ]);

    expect(beforeStreamCalls).toBe(1);
    expect(closeSpy).not.toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
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
