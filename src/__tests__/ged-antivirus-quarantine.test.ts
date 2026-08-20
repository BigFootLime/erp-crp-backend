import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const repository = vi.hoisted(() => ({
  repoCreateUploadSession: vi.fn(),
  repoClearQuarantineKey: vi.fn(),
  repoRecordUploadScan: vi.fn(),
  repoLogAccess: vi.fn(),
  repoGetClass: vi.fn(),
  repoLockGedBlobSha256: vi.fn(),
  repoFindDocumentByBlobHash: vi.fn(),
  repoUpsertBlob: vi.fn(),
  repoCreateDocumentWithVersion: vi.fn(),
  repoFinalizeUploadSession: vi.fn(),
  repoGetDocumentDetail: vi.fn(),
  repoListQuarantine: vi.fn(),
  repoGetQuarantineSession: vi.fn(),
  repoGetQuarantineSessionForUpdate: vi.fn(),
  repoMarkQuarantineDeleted: vi.fn(),
  repoInternalGetVersionContentRef: vi.fn(),
  withGedTransaction: vi.fn(),
}));

vi.mock("../module/ged/repository/ged.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("../module/ged/repository/ged.repository")>(),
  ...repository,
}));

import {
  deleteQuarantine,
  downloadVersion,
  listQuarantine,
  releaseQuarantine,
  rescanQuarantine,
  uploadDocument,
} from "../module/ged/services/ged.service";
import {
  clearRegisteredUploadDestinationsForTests,
  createSecureUpload,
} from "../shared/uploads/secure-upload";
import { setUploadScannerForTests } from "../shared/uploads/upload-scanner";

const EICAR = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  "ascii"
);
const CLEAN_TEXT = Buffer.from("Rapport de controle dimensionnel\n", "utf8");
const CLASS_ROW = {
  class_key: "RAPPORT_CONTROLE",
  domain: "QUALITE",
  label: "Rapport de controle",
  nature: "RAPPORT",
  allowed_mime_types: ["text/plain"],
  allowed_extensions: [".txt"],
  max_size_bytes: 1024 * 1024,
  approvals_required: 0,
  retention_months: null,
  hold_on_publish: false,
  is_active: true,
};
const DOCUMENT_DETAIL = {
  id: "22222222-2222-4222-8222-222222222222",
  code: "GED-2026-000001",
  class_key: CLASS_ROW.class_key,
  domain: CLASS_ROW.domain,
  title: "Rapport test",
  description: null,
  status: "DRAFT",
  current_version_id: null,
  created_by: 7,
  created_at: "2026-08-11T10:00:00.000Z",
  updated_at: "2026-08-11T10:00:00.000Z",
  archived_at: null,
  versions: [],
  links: [],
  holds: [],
};

let temporaryRoot: string;

async function stagedFile(content: Buffer, name: string) {
  const staging = path.join(temporaryRoot, `${crypto.randomUUID()}-${name}`);
  await fs.writeFile(staging, content, { mode: 0o600 });
  return {
    path: staging,
    originalname: name,
    mimetype: "text/plain",
    size: content.byteLength,
    uploadSecurity: {
      usage: "ged-deferred",
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      scanStatus: "pending" as const,
      scanProvider: "deferred",
    },
  };
}

function quarantineSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    class_key: CLASS_ROW.class_key,
    title: "Rapport test",
    original_name: "controle.txt",
    size_bytes: CLEAN_TEXT.byteLength,
    sha256: crypto.createHash("sha256").update(CLEAN_TEXT).digest("hex"),
    scan_status: "infected",
    quarantine_status: "quarantined",
    scan_provider: "clamdscan",
    signature_version: "ClamAV 1.4.5/27000",
    scan_duration_ms: 12,
    scan_attempts: 1,
    scanned_at: "2026-08-11T10:00:00.000Z",
    created_at: "2026-08-11T10:00:00.000Z",
    created_by: { id: 7, username: "admin", label: "Admin" },
    status: "QUARANTINE",
    mime_type: "text/plain",
    quarantine_key: `quarantine/${SESSION_ID}.quarantine`,
    request_metadata: {
      kind: "new_document",
      description: null,
      change_reason: "Reprise après réanalyse",
      link: null,
    },
    document_id: null,
    reject_reason: "Eicar-Signature FOUND",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearRegisteredUploadDestinationsForTests();
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-sol11-"));
  process.env.CERP_TMP_ROOT = path.join(temporaryRoot, "tmp");
  process.env.CERP_GED_VAULT_ROOT = path.join(temporaryRoot, "vault-root");
  process.env.CERP_GED_REQUIRE_SENTINEL = "false";
  process.env.CERP_UPLOAD_SCAN_MODE = "enforce";
  await fs.mkdir(process.env.CERP_TMP_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(process.env.CERP_GED_VAULT_ROOT, { recursive: true, mode: 0o700 });

  repository.repoCreateUploadSession.mockImplementation(async (_tx, input) => ({ id: input.id }));
  repository.repoGetClass.mockResolvedValue(CLASS_ROW);
  repository.repoFindDocumentByBlobHash.mockResolvedValue(null);
  repository.repoUpsertBlob.mockResolvedValue({ id: "blob-id" });
  repository.repoCreateDocumentWithVersion.mockResolvedValue({
    document_id: DOCUMENT_DETAIL.id,
    version_id: "33333333-3333-4333-8333-333333333333",
  });
  repository.repoGetDocumentDetail.mockResolvedValue(DOCUMENT_DETAIL);
  repository.repoListQuarantine.mockResolvedValue([]);
  repository.withGedTransaction.mockImplementation(async (work, hooks) => {
    const result = await work({ query: vi.fn() });
    await hooks?.beforeCommit?.();
    await hooks?.afterCommit?.();
    return result;
  });
});

afterEach(async () => {
  setUploadScannerForTests(null);
  clearRegisteredUploadDestinationsForTests();
  delete process.env.CERP_TMP_ROOT;
  delete process.env.CERP_GED_VAULT_ROOT;
  delete process.env.CERP_GED_REQUIRE_SENTINEL;
  delete process.env.CERP_UPLOAD_SCAN_MODE;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("GED antivirus quarantine", () => {
  it("keeps the EICAR test file private, records the verdict, and creates no document", async () => {
    const file = await stagedFile(EICAR, "eicar.txt");
    setUploadScannerForTests({
      name: "clamav-eicar-test",
      scan: async (input) => {
        expect(input.path).toContain(`${path.sep}quarantine${path.sep}`);
        expect(await fs.readFile(input.path!)).toEqual(EICAR);
        return {
          status: "infected",
          provider: "clamdscan",
          reason: "Eicar-Signature FOUND",
          signature_version: "ClamAV 1.4.5/27000",
        };
      },
    });

    await expect(uploadDocument(
      { id: 7, role: "Administrateur" },
      { class_key: CLASS_ROW.class_key, title: "EICAR test" },
      file
    )).rejects.toMatchObject({ status: 422, code: "GED_SCAN_INFECTED" });

    const sessionId = repository.repoCreateUploadSession.mock.calls[0][1].id;
    expect(repository.repoRecordUploadScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session_id: sessionId,
        scan_status: "infected",
        quarantine_status: "quarantined",
        scan_provider: "clamdscan",
        signature_version: "ClamAV 1.4.5/27000",
      })
    );
    expect(repository.repoCreateDocumentWithVersion).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(
      temporaryRoot,
      "vault-root",
      "quarantine",
      `${sessionId}.quarantine`
    ))).toEqual(EICAR);
    expect(await fs.stat(file.path).catch(() => null)).toBeNull();
    expect(repository.repoLogAccess.mock.calls.map((call) => call[1].event_type)).toEqual(
      expect.arrayContaining(["SCAN_PENDING", "SCAN_INFECTED", "QUARANTINED"])
    );
  });

  it("fails closed and quarantines the file when the scanner is unavailable", async () => {
    const file = await stagedFile(CLEAN_TEXT, "controle.txt");
    setUploadScannerForTests({
      name: "unavailable-test",
      scan: async () => ({
        status: "unavailable",
        provider: "clamdscan",
        reason: "daemon_unavailable",
      }),
    });

    const uploadPromise = uploadDocument(
      { id: 7, role: "Administrateur" },
      { class_key: CLASS_ROW.class_key, title: "Rapport test" },
      file
    );
    await expect(uploadPromise).rejects.toMatchObject({
      status: 503,
      code: "GED_SCAN_FAILED",
      details: expect.objectContaining({ state: "quarantined" }),
    });

    const sessionId = repository.repoCreateUploadSession.mock.calls[0][1].id;
    await expect(uploadPromise).rejects.toMatchObject({
      details: { quarantine_id: sessionId, state: "quarantined" },
    });
    expect(repository.repoRecordUploadScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session_id: sessionId,
        scan_status: "scan_failed",
        quarantine_status: "quarantined",
        reject_reason: "daemon_unavailable",
      })
    );
    expect(repository.repoCreateDocumentWithVersion).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(
      temporaryRoot,
      "vault-root",
      "quarantine",
      `${sessionId}.quarantine`
    ))).toEqual(CLEAN_TEXT);
  });

  it("publishes only after a clean verdict and links the immutable scan session", async () => {
    const file = await stagedFile(CLEAN_TEXT, "controle.txt");
    setUploadScannerForTests({
      name: "clean-test",
      scan: async () => ({
        status: "clean",
        provider: "clamdscan",
        signature_version: "ClamAV 1.4.5/27000",
      }),
    });

    await expect(uploadDocument(
      { id: 7, role: "Administrateur" },
      { class_key: CLASS_ROW.class_key, title: "Rapport test" },
      file
    )).resolves.toMatchObject({ id: DOCUMENT_DETAIL.id });

    const sessionId = repository.repoCreateUploadSession.mock.calls[0][1].id;
    expect(repository.repoRecordUploadScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ session_id: sessionId, scan_status: "clean", status: "READY" })
    );
    expect(repository.repoCreateDocumentWithVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ upload_session_id: sessionId })
    );
    expect(repository.repoFinalizeUploadSession).toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      DOCUMENT_DETAIL.id,
      false
    );
    expect(repository.repoClearQuarantineKey).toHaveBeenCalledWith(sessionId);
    expect(await fs.stat(path.join(
      temporaryRoot,
      "vault-root",
      "quarantine",
      `${sessionId}.quarantine`
    )).catch(() => null)).toBeNull();
    expect(repository.repoRecordUploadScan.mock.invocationCallOrder[0]).toBeLessThan(
      repository.repoCreateDocumentWithVersion.mock.invocationCallOrder[0]
    );
  });

  it("does not run the scanner in the transport middleware before the pending record exists", async () => {
    const scan = vi.fn(async () => ({ status: "clean" as const, provider: "must-not-run" }));
    setUploadScannerForTests({ name: "must-not-run", scan });
    const upload = createSecureUpload("ged-deferred", { storage: "staging", scan: "deferred" });
    const app = express();
    app.post("/ged", upload.single("file"), (req, res) => {
      res.status(201).json({ security: req.file?.uploadSecurity });
    });

    const response = await request(app)
      .post("/ged")
      .attach("file", CLEAN_TEXT, { filename: "controle.txt", contentType: "text/plain" });

    expect(response.status).toBe(201);
    expect(response.body.security).toMatchObject({
      scanStatus: "pending",
      scanProvider: "deferred",
      sha256: crypto.createHash("sha256").update(CLEAN_TEXT).digest("hex"),
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("denies quarantine administration to a standard user and never queries its contents", async () => {
    await expect(listQuarantine({ id: 11, role: "Utilisateur" })).rejects.toMatchObject({
      status: 403,
      code: "GED_CAPABILITY_REQUIRED",
    });
    expect(repository.repoListQuarantine).not.toHaveBeenCalled();
  });

  it("blocks download before resolving storage when a linked verdict is not clean", async () => {
    repository.repoInternalGetVersionContentRef.mockResolvedValue({
      version_id: "33333333-3333-4333-8333-333333333333",
      document_id: DOCUMENT_DETAIL.id,
      status: "PUBLIE",
      original_name: "eicar.txt",
      mime_type: "text/plain",
      sha256: crypto.createHash("sha256").update(EICAR).digest("hex"),
      size_bytes: EICAR.byteLength,
      storage_key: "quarantine/must-never-be-resolved.quarantine",
      scan_status: "infected",
      quarantine_status: "quarantined",
    });

    await expect(downloadVersion(
      { id: 7, role: "Administrateur" },
      "33333333-3333-4333-8333-333333333333"
    )).rejects.toMatchObject({ status: 409, code: "GED_SCAN_REQUIRED" });
  });

  it("refuses release until an administrator has obtained a clean rescan", async () => {
    repository.repoGetQuarantineSession.mockResolvedValue({
      id: SESSION_ID,
      class_key: CLASS_ROW.class_key,
      title: "EICAR test",
      original_name: "eicar.txt",
      size_bytes: EICAR.byteLength,
      sha256: crypto.createHash("sha256").update(EICAR).digest("hex"),
      scan_status: "infected",
      quarantine_status: "quarantined",
      scan_provider: "clamdscan",
      signature_version: "ClamAV 1.4.5/27000",
      scan_duration_ms: 12,
      scan_attempts: 1,
      scanned_at: "2026-08-11T10:00:00.000Z",
      created_at: "2026-08-11T10:00:00.000Z",
      created_by: 7,
      status: "QUARANTINE",
      mime_type: "text/plain",
      quarantine_key: `quarantine/${SESSION_ID}.quarantine`,
      request_metadata: { kind: "new_document" },
      document_id: null,
      reject_reason: "Eicar-Signature FOUND",
    });

    await expect(releaseQuarantine(
      { id: 7, role: "Administrateur" },
      SESSION_ID
    )).rejects.toMatchObject({ status: 409, code: "GED_SCAN_REQUIRED" });
    expect(repository.repoCreateDocumentWithVersion).not.toHaveBeenCalled();
  });

  it("allows an administrator to rescan clean then release through the audited path", async () => {
    const quarantineDirectory = path.join(temporaryRoot, "vault-root", "quarantine");
    await fs.mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(quarantineDirectory, `${SESSION_ID}.quarantine`), CLEAN_TEXT, { mode: 0o600 });
    const infected = quarantineSession();
    const clean = quarantineSession({
      scan_status: "clean",
      scan_attempts: 2,
      reject_reason: null,
    });
    repository.repoGetQuarantineSession
      .mockResolvedValueOnce(infected)
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce(clean);
    repository.repoGetQuarantineSessionForUpdate
      .mockResolvedValueOnce(infected)
      .mockResolvedValueOnce(clean);
    setUploadScannerForTests({
      name: "clean-rescan-test",
      scan: async () => ({
        status: "clean",
        provider: "clamdscan",
        signature_version: "ClamAV 1.4.5/27001",
      }),
    });

    await expect(rescanQuarantine(
      { id: 7, role: "Administrateur" },
      SESSION_ID
    )).resolves.toMatchObject({ scan_status: "clean", quarantine_status: "quarantined" });
    await expect(releaseQuarantine(
      { id: 7, role: "Administrateur" },
      SESSION_ID
    )).resolves.toMatchObject({ id: DOCUMENT_DETAIL.id });

    expect(repository.repoRecordUploadScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session_id: SESSION_ID,
        scan_status: "clean",
        quarantine_status: "quarantined",
      })
    );
    expect(repository.repoFinalizeUploadSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      DOCUMENT_DETAIL.id,
      false
    );
    expect(repository.repoLogAccess.mock.calls.map((call) => call[1].event_type)).toEqual(
      expect.arrayContaining(["SCAN_CLEAN", "QUARANTINE_RELEASED", "UPLOAD"])
    );
    expect(repository.repoClearQuarantineKey).toHaveBeenCalledWith(SESSION_ID);
    expect(await fs.stat(path.join(quarantineDirectory, `${SESSION_ID}.quarantine`)).catch(() => null)).toBeNull();
  });

  it("deletes a quarantined threat only through the audited administrator action", async () => {
    const quarantineDirectory = path.join(temporaryRoot, "vault-root", "quarantine");
    await fs.mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(quarantineDirectory, `${SESSION_ID}.quarantine`), CLEAN_TEXT, { mode: 0o600 });
    const infected = quarantineSession();
    repository.repoGetQuarantineSession.mockResolvedValue(infected);
    repository.repoGetQuarantineSessionForUpdate.mockResolvedValue(infected);

    await expect(deleteQuarantine(
      { id: 7, role: "Administrateur" },
      SESSION_ID
    )).resolves.toBeUndefined();

    expect(repository.repoMarkQuarantineDeleted).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      "admin_delete"
    );
    expect(repository.repoLogAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event_type: "QUARANTINE_DELETED", actor_id: 7 })
    );
    expect(repository.repoClearQuarantineKey).toHaveBeenCalledWith(SESSION_ID);
    expect(await fs.stat(path.join(quarantineDirectory, `${SESSION_ID}.quarantine`)).catch(() => null)).toBeNull();
  });
});
