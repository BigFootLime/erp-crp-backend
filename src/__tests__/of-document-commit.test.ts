import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  readBlob: vi.fn(),
  compensate: vi.fn(),
}));

vi.mock("../module/production/repository/of-versioning.repository", () => ({
  reconcileOfDocumentMetadataCommit: mocks.reconcile,
}));

vi.mock("../module/ged/services/ged-vault.service", () => ({
  readBlob: mocks.readBlob,
}));

vi.mock("../module/production/services/of-document-archive", () => ({
  compensateOfDocumentArchive: mocks.compensate,
}));

import {
  reconcileOfDocumentCommit,
  type OfDocumentCommitContext,
} from "../module/production/services/of-document-commit";

type PublicResult = Readonly<{
  document: { id: string };
  replayed: false;
  archive: {
    archived: true;
    gedDocumentId: string;
    gedVersionId: string;
    skippedReason: null;
  };
}>;

function context(): OfDocumentCommitContext<PublicResult> {
  return {
    publicResult: {
      document: { id: "document-id" },
      replayed: false,
      archive: {
        archived: true,
        gedDocumentId: "ged-document-id",
        gedVersionId: "ged-version-id",
        skippedReason: null,
      },
    },
    expectation: {
      documentId: "document-id",
      ofId: 42,
      revisionId: "revision-id",
      payloadSha256: "payload-sha",
      pdfSha256: "pdf-sha",
      pdfByteSize: 4,
      gedDocumentId: "ged-document-id",
      gedVersionId: "ged-version-id",
      gedBlobStorageKey: "vault/sha256/aa/bb/pdf-sha",
      gedVersionStatus: "BROUILLON",
      gedDocumentWasPreexisting: false,
    },
    archiveOwnership: {
      archived: true,
      gedDocumentId: "ged-document-id",
      gedVersionId: "ged-version-id",
      skippedReason: null,
      blobOwnership: {
        kind: "created",
        destination: "C:\\private\\vault\\blob",
        dev: "1",
        ino: "2",
      },
      blobSha256: "pdf-sha",
      blobStorageKey: "vault/sha256/aa/bb/pdf-sha",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.compensate.mockResolvedValue(undefined);
  mocks.readBlob.mockResolvedValue(Buffer.from("pdf!"));
});

describe("OF document COMMIT reconciliation", () => {
  it("retourne le succès seulement après métadonnées, hash et taille physiques exacts", async () => {
    mocks.reconcile.mockResolvedValue("committed");
    const expected = context();

    await expect(reconcileOfDocumentCommit(expected)).resolves.toBe(expected.publicResult);

    expect(mocks.readBlob).toHaveBeenCalledWith(
      expected.expectation.gedBlobStorageKey,
      expected.expectation.pdfSha256
    );
    expect(mocks.compensate).not.toHaveBeenCalled();
    const serialized = JSON.stringify(expected.publicResult);
    expect(serialized).not.toContain("blobOwnership");
    expect(serialized).not.toContain("blobStorageKey");
    expect(serialized).not.toContain("destination");
    expect(serialized).not.toContain("dev");
    expect(serialized).not.toContain("ino");
  });

  it("compense l'inode créé et rend une erreur réessayable si le COMMIT est absent", async () => {
    mocks.reconcile.mockResolvedValue("not-committed");
    const expected = context();

    await expect(reconcileOfDocumentCommit(expected)).rejects.toMatchObject({
      status: 503,
      code: "OF_DOCUMENT_COMMIT_NOT_APPLIED",
    });

    expect(mocks.compensate).toHaveBeenCalledOnce();
    expect(mocks.compensate).toHaveBeenCalledWith(expected.archiveOwnership);
    expect(mocks.readBlob).not.toHaveBeenCalled();
  });

  it.each(["uncertain", "metadata-inaccessible"] as const)(
    "préserve sans compensation un état %s",
    async (mode) => {
      if (mode === "uncertain") mocks.reconcile.mockResolvedValue("uncertain");
      else mocks.reconcile.mockRejectedValue(new Error("database unavailable"));

      await expect(reconcileOfDocumentCommit(context())).rejects.toMatchObject({
        status: 503,
        code: "OF_DOCUMENT_COMMIT_UNCERTAIN",
      });

      expect(mocks.compensate).not.toHaveBeenCalled();
      expect(mocks.readBlob).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["absent", null],
    ["taille partielle", Buffer.from("x")],
  ] as const)("préserve si le fichier rapproché est %s", async (_label, blob) => {
    mocks.reconcile.mockResolvedValue("committed");
    if (blob === null) mocks.readBlob.mockRejectedValue(new Error("vault unavailable"));
    else mocks.readBlob.mockResolvedValue(blob);

    await expect(reconcileOfDocumentCommit(context())).rejects.toMatchObject({
      status: 503,
      code: "OF_DOCUMENT_COMMIT_UNCERTAIN",
    });

    expect(mocks.compensate).not.toHaveBeenCalled();
  });
});
