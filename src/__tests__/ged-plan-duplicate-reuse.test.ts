import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  repoGetClass: vi.fn(),
  repoFindDocumentByBlobHash: vi.fn(),
  repoGetDocumentDetail: vi.fn(),
  repoLockGedBlobSha256: vi.fn(),
  repoUpsertBlob: vi.fn(),
  repoCreateDocumentWithVersion: vi.fn(),
  repoAddLink: vi.fn(),
  repoLogAccess: vi.fn(),
  repoGetQuarantineSession: vi.fn(),
  repoGetQuarantineSessionForUpdate: vi.fn(),
  repoFinalizeUploadSession: vi.fn(),
  repoClearQuarantineKey: vi.fn(),
  withGedTransaction: vi.fn(),
}));

vi.mock("../module/ged/repository/ged.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("../module/ged/repository/ged.repository")>(),
  ...repo,
}));
vi.mock("../module/ged/services/ged-parent-authorization.service", () => ({
  assertGedParentLinkWritable: vi.fn(async (_actorId: number, link: { entity_type: string; entity_id: string }) => ({
    entityType: link.entity_type,
    entityId: link.entity_id,
  })),
  assertGedVersionParentReadable: vi.fn(),
}));
vi.mock("../module/ged/services/ged-automatic-publication.service", () => ({
  automaticallyPublishCleanUpload: vi.fn(),
}));

import { releaseQuarantine, uploadDocument } from "../module/ged/services/ged.service";
import { clearRegisteredUploadDestinationsForTests } from "../shared/uploads/secure-upload";

const ACTOR = { id: 7, role: "Administrateur" };
const REVISION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const SHA256 = crypto.createHash("sha256").update(PDF).digest("hex");
let root: string;

function documentClass(classKey: string) {
  return {
    class_key: classKey,
    domain: "TECHNIQUE",
    label: classKey,
    nature: "SOURCE",
    allowed_mime_types: ["application/pdf"],
    allowed_extensions: [".pdf"],
    max_size_bytes: 1024 * 1024,
    approvals_required: 0,
    retention_months: null,
    hold_on_publish: false,
    is_active: true,
  };
}

function sourcePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    code: "DT-000123",
    class_key: "PLAN_CLIENT",
    archived_at: null,
    links: [{ entity_type: "PIECE_TECHNIQUE_VERSION", entity_id: REVISION_ID, link_role: "PLAN_CLIENT" }],
    ...overrides,
  };
}

async function file(name: string) {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, PDF, { mode: 0o600 });
  return {
    path: filePath,
    originalname: name,
    mimetype: "application/pdf",
    size: PDF.byteLength,
    uploadSecurity: { sha256: SHA256, scanStatus: "clean" as const },
  };
}

function input(class_key: string, link_role: string) {
  return {
    class_key,
    title: "Plan réutilisé",
    link: { entity_type: "PIECE_TECHNIQUE_VERSION", entity_id: REVISION_ID, link_role },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearRegisteredUploadDestinationsForTests();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-plan-duplicate-"));
  process.env.CERP_GED_VAULT_ROOT = path.join(root, "vault");
  process.env.CERP_GED_REQUIRE_SENTINEL = "false";
  process.env.CERP_UPLOAD_SCAN_MODE = "off";
  await fs.mkdir(process.env.CERP_GED_VAULT_ROOT, { recursive: true, mode: 0o700 });
  repo.repoGetClass.mockImplementation(async (classKey: string) => documentClass(classKey));
  repo.repoFindDocumentByBlobHash.mockResolvedValue({ document_id: sourcePlan().id, code: "DT-000123" });
  repo.repoGetDocumentDetail.mockResolvedValue(sourcePlan());
  repo.repoLockGedBlobSha256.mockResolvedValue(undefined);
  repo.repoUpsertBlob.mockResolvedValue({ id: "blob-id" });
  repo.repoCreateDocumentWithVersion.mockResolvedValue({ document_id: "new-document", version_id: "new-version" });
  repo.repoAddLink.mockResolvedValue(true);
  repo.repoLogAccess.mockResolvedValue(undefined);
  repo.repoFinalizeUploadSession.mockResolvedValue(undefined);
  repo.repoClearQuarantineKey.mockResolvedValue(undefined);
  repo.withGedTransaction.mockImplementation(async (work: (tx: object) => Promise<unknown>, hooks?: Record<string, () => Promise<void>>) => {
    const result = await work({ query: vi.fn() });
    await hooks?.beforeCommit?.();
    await hooks?.afterCommit?.();
    return result;
  });
});

afterEach(async () => {
  delete process.env.CERP_GED_VAULT_ROOT;
  delete process.env.CERP_GED_REQUIRE_SENTINEL;
  delete process.env.CERP_UPLOAD_SCAN_MODE;
  clearRegisteredUploadDestinationsForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe("GED plan duplicate exception", () => {
  it("accepts the same renamed bytes as a fabrication plan when they are already the client plan of that PT revision", async () => {
    await expect(uploadDocument(ACTOR, input("GAMME_DOC", "PLAN_FABRICATION"), await file("plan-fabrication-renomme.pdf")))
      .resolves.toMatchObject({ id: sourcePlan().id });
    expect(repo.repoUpsertBlob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sha256: SHA256 }));
    expect(repo.repoCreateDocumentWithVersion).toHaveBeenCalled();
  });

  it.each([
    ["CERTIF_MATIERE", "PLAN_FABRICATION"],
    ["GAMME_DOC", "PLAN_CLIENT"],
  ])("keeps the duplicate refusal outside the exact plan-role pair (%s / %s)", async (classKey, role) => {
    await expect(uploadDocument(ACTOR, input(classKey, role), await file(`${classKey}-${role}.pdf`)))
      .rejects.toMatchObject({ status: 409, code: "GED_FILE_DUPLICATE" });
    expect(repo.repoCreateDocumentWithVersion).not.toHaveBeenCalled();
  });

  it("does not exempt a plan role outside a technical-piece parent", async () => {
    await expect(uploadDocument(ACTOR, {
      ...input("GAMME_DOC", "PLAN_FABRICATION"),
      link: { entity_type: "ARTICLE", entity_id: REVISION_ID, link_role: "PLAN_FABRICATION" },
    }, await file("plan-sur-article.pdf"))).rejects.toMatchObject({ status: 409, code: "GED_FILE_DUPLICATE" });
  });

  it("applies the same exception after quarantine release, while retaining the SHA blob reuse", async () => {
    const quarantinePath = path.join(root, "vault", "quarantine", `${SESSION_ID}.quarantine`);
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    await fs.writeFile(quarantinePath, PDF, { mode: 0o600 });
    const session = {
      id: SESSION_ID,
      class_key: "GAMME_DOC",
      title: "Plan fabrication",
      original_name: "plan-fabrication-renomme.pdf",
      size_bytes: PDF.byteLength,
      sha256: SHA256,
      scan_status: "clean",
      quarantine_status: "quarantined",
      mime_type: "application/pdf",
      quarantine_key: `quarantine/${SESSION_ID}.quarantine`,
      request_metadata: { kind: "new_document", description: null, change_reason: null,
        link: { entity_type: "PIECE_TECHNIQUE_VERSION", entity_id: REVISION_ID, link_role: "PLAN_FABRICATION" } },
    };
    repo.repoGetQuarantineSession.mockResolvedValue(session);
    repo.repoGetQuarantineSessionForUpdate.mockResolvedValue(session);

    await expect(releaseQuarantine(ACTOR, SESSION_ID)).resolves.toMatchObject({ id: sourcePlan().id });
    expect(repo.repoUpsertBlob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sha256: SHA256 }));
    expect(repo.repoCreateDocumentWithVersion).toHaveBeenCalled();
  });
});
