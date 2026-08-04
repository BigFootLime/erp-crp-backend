import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  insertAuditLog: vi.fn(),
  insertProjectActivity: vi.fn(),
  requireProjectAccess: vi.fn(),
  repoFindEvidenceFileByProjectHash: vi.fn(),
  repoCreateEvidence: vi.fn(),
  repoCreateEvidenceFile: vi.fn(),
  repoGetEvidenceFileById: vi.fn(),
  repoGetWorkPackageById: vi.fn(),
}));

vi.mock("../module/project-office/repository/project-office.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/project-office/repository/project-office.repository")>();
  return {
    ...actual,
    withTransaction: mocks.withTransaction,
    insertAuditLog: mocks.insertAuditLog,
    insertProjectActivity: mocks.insertProjectActivity,
  };
});

vi.mock("../module/project-office/repository/project-office-registers.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/project-office/repository/project-office-registers.repository")>();
  return {
    ...actual,
    repoFindEvidenceFileByProjectHash: mocks.repoFindEvidenceFileByProjectHash,
    repoCreateEvidence: mocks.repoCreateEvidence,
    repoCreateEvidenceFile: mocks.repoCreateEvidenceFile,
    repoGetEvidenceFileById: mocks.repoGetEvidenceFileById,
  };
});

vi.mock("../module/project-office/repository/project-office-work.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/project-office/repository/project-office-work.repository")>();
  return { ...actual, repoGetWorkPackageById: mocks.repoGetWorkPackageById };
});

vi.mock("../module/project-office/services/project-office-access.service", () => ({
  requireProjectAccess: mocks.requireProjectAccess,
}));

import {
  PoCommitUncertainError,
} from "../module/project-office/repository/project-office.repository";
import {
  uploadEvidenceFile,
} from "../module/project-office/services/project-office-registers.service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const PDF = Buffer.from("%PDF-1.7\npreuve Project Office\n", "utf8");
const ACTOR = { id: 42, role: "Directeur" };
const AUDIT = {
  user_id: 42,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: null,
  page_key: null,
  client_session_id: null,
};

function uploadedFile(): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "preuve.pdf",
    encoding: "7bit",
    mimetype: "application/pdf",
    size: PDF.byteLength,
    destination: "",
    filename: "",
    path: "",
    buffer: Buffer.from(PDF),
    stream: null,
  } as unknown as Express.Multer.File;
}

function input() {
  return {
    work_package_id: null,
    title: "Preuve",
    description: null,
    category: "DOCUMENT" as const,
    version_number: 1,
    status: "BROUILLON" as const,
    date_effet: null,
    visibility: "PRIVATE" as const,
  };
}

describe("Project Office evidence durable lifecycle", () => {
  let documentsRoot: string;
  let transactionResult: { evidence: Record<string, unknown>; file: Record<string, unknown> } | null;
  let createdStorageKey: string | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-po-evidence-"));
    process.env.CERP_DOCUMENTS_ROOT = documentsRoot;
    mocks.requireProjectAccess.mockResolvedValue(undefined);
    mocks.repoFindEvidenceFileByProjectHash.mockResolvedValue(null);
    mocks.repoCreateEvidence.mockResolvedValue({
      id: EVIDENCE_ID,
      project_id: PROJECT_ID,
      title: "Preuve",
    });
    createdStorageKey = null;
    transactionResult = null;
    mocks.repoCreateEvidenceFile.mockImplementation(async (_tx, created) => {
      createdStorageKey = created.storage_key;
      return {
        id: FILE_ID,
        evidence_id: EVIDENCE_ID,
        project_id: PROJECT_ID,
        original_name: created.original_name,
        mime_type: created.mime_type,
        size_bytes: created.size_bytes,
        sha256: created.sha256,
        category: created.category,
        version_number: created.version_number,
        status: created.status,
        date_effet: created.date_effet,
        visibility: created.visibility,
        created_at: "2026-08-04T12:00:00.000Z",
        created_by: created.created_by,
      };
    });
    mocks.insertAuditLog.mockResolvedValue(undefined);
    mocks.insertProjectActivity.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CERP_DOCUMENTS_ROOT;
    await fs.rm(documentsRoot, { recursive: true, force: true });
  });

  function installCommitAckLoss(): void {
    mocks.withTransaction.mockImplementation(async (work) => {
      const result = await work({ query: vi.fn() });
      transactionResult = result;
      throw new PoCommitUncertainError(result, new Error("commit acknowledgement lost"));
    });
  }

  function durablePath(): string {
    if (!createdStorageKey) throw new Error("storage key not captured");
    return path.join(documentsRoot, ...createdStorageKey.split("/"));
  }

  it("ACK perdu + métadonnées et fichier exacts retourne le succès", async () => {
    installCommitAckLoss();
    mocks.repoGetEvidenceFileById.mockImplementation(async () => {
      const result = transactionResult!;
      return {
        ...result.file,
        storage_key: createdStorageKey,
        sanitized_name: path.basename(createdStorageKey!),
      };
    });

    const result = await uploadEvidenceFile(ACTOR, PROJECT_ID, input(), uploadedFile(), AUDIT);

    expect(result.file.id).toBe(FILE_ID);
    await expect(fs.readFile(durablePath())).resolves.toEqual(PDF);
  });

  it("ACK perdu + absence totale compense l'inode et rend une erreur réessayable", async () => {
    installCommitAckLoss();
    mocks.repoGetEvidenceFileById.mockResolvedValue(null);

    await expect(uploadEvidenceFile(ACTOR, PROJECT_ID, input(), uploadedFile(), AUDIT))
      .rejects.toMatchObject({ status: 503, code: "PO_UPLOAD_COMMIT_NOT_APPLIED" });

    await expect(fs.stat(durablePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ACK perdu + métadonnées partielles préserve le fichier et rend 503 incertain", async () => {
    installCommitAckLoss();
    mocks.repoGetEvidenceFileById.mockImplementation(async () => ({
      ...transactionResult!.file,
      evidence_id: "44444444-4444-4444-8444-444444444444",
      storage_key: createdStorageKey,
      sanitized_name: path.basename(createdStorageKey!),
    }));

    await expect(uploadEvidenceFile(ACTOR, PROJECT_ID, input(), uploadedFile(), AUDIT))
      .rejects.toMatchObject({ status: 503, code: "PO_UPLOAD_COMMIT_UNCERTAIN" });

    await expect(fs.readFile(durablePath())).resolves.toEqual(PDF);
  });

  it("rollback confirmé préserve un remplacement B au lieu de le supprimer", async () => {
    mocks.withTransaction.mockImplementation(async (work) => {
      await work({ query: vi.fn() });
      const target = durablePath();
      await fs.unlink(target);
      await fs.writeFile(target, "contenu B", { flag: "wx", mode: 0o600 });
      throw new Error("business rollback");
    });

    await expect(uploadEvidenceFile(ACTOR, PROJECT_ID, input(), uploadedFile(), AUDIT))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });

    await expect(fs.readFile(durablePath(), "utf8")).resolves.toBe("contenu B");
  });

  it("rollback confirmé rend le cleanup impossible strictement observable", async () => {
    let rollbackConfirmed = false;
    mocks.withTransaction.mockImplementation(async (work) => {
      await work({ query: vi.fn() });
      rollbackConfirmed = true;
      throw new Error("business rollback");
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (candidate, target) => {
      if (
        rollbackConfirmed
        && createdStorageKey
        && path.resolve(String(candidate)) === path.resolve(durablePath())
      ) {
        throw Object.assign(new Error("locked"), { code: "EACCES" });
      }
      return realRename(candidate, target);
    });

    await expect(uploadEvidenceFile(ACTOR, PROJECT_ID, input(), uploadedFile(), AUDIT))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });

    await expect(fs.readFile(durablePath())).resolves.toEqual(PDF);
  });
});
