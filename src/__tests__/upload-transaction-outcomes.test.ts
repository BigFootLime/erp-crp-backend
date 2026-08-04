import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: {
    connect: database.connect,
    query: database.query,
  },
}));

import {
  GedCommitUncertainError,
  GedRollbackUncertainError,
  repoIsVersionBlobCommitted,
  withGedTransaction,
} from "../module/ged/repository/ged.repository";
import {
  PoCommitUncertainError,
  PoRollbackUncertainError,
  withTransaction as withProjectOfficeTransaction,
} from "../module/project-office/repository/project-office.repository";
import {
  OfCommitUncertainError,
  OfRollbackUncertainError,
  reconcileOfDocumentMetadataCommit,
  withOfTransaction,
  type OfDocumentCommitExpectation,
} from "../module/production/repository/of-versioning.repository";

beforeEach(() => {
  vi.clearAllMocks();
  database.connect.mockResolvedValue({
    query: database.clientQuery,
    release: database.release,
  });
  database.clientQuery.mockResolvedValue({ rows: [] });
});

describe("transactions avec fichiers durables", () => {
  it("GED ne lance jamais ROLLBACK après un COMMIT envoyé dont l’ACK est perdu", async () => {
    database.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("connection lost after commit");
      return { rows: [] };
    });
    const beforeCommit = vi.fn();
    const afterRollback = vi.fn();

    const error = await withGedTransaction(
      async () => ({ documentId: "d", versionId: "v" }),
      { beforeCommit, afterConfirmedRollback: afterRollback }
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(GedCommitUncertainError);
    expect(error.transactionResult).toEqual({ documentId: "d", versionId: "v" });
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(afterRollback).not.toHaveBeenCalled();
    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("GED exécute le nettoyage seulement après un vrai ROLLBACK confirmé", async () => {
    const afterRollback = vi.fn(() => {
      // Compensation may need a fresh pooled connection for the SHA lock.
      expect(database.release).toHaveBeenCalledWith(false);
    });
    const businessError = new Error("validation failed");

    await expect(withGedTransaction(
      async () => { throw businessError; },
      { afterConfirmedRollback: afterRollback }
    )).rejects.toBe(businessError);

    expect(afterRollback).toHaveBeenCalledOnce();
    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("GED preserves the connection and durable ownership when ROLLBACK acknowledgement is lost", async () => {
    database.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback acknowledgement lost");
      return { rows: [] };
    });
    const afterRollback = vi.fn();
    const afterRollbackUncertain = vi.fn();

    await expect(withGedTransaction(
      async () => { throw new Error("business failure"); },
      { afterConfirmedRollback: afterRollback, afterRollbackUncertain }
    )).rejects.toBeInstanceOf(GedRollbackUncertainError);

    expect(afterRollback).not.toHaveBeenCalled();
    expect(afterRollbackUncertain).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it.each([
    [{ version_sha256: "sha", blob_present: true }, "committed"],
    [{ version_sha256: "different", blob_present: true }, "uncertain"],
    [{ version_sha256: null, blob_present: true }, "uncertain"],
    [{ version_sha256: null, blob_present: false }, "not-committed"],
  ] as const)("GED classifies fresh version/blob state without false cleanup: %s", async (row, expected) => {
    database.query.mockResolvedValueOnce({ rows: [row] });
    await expect(repoIsVersionBlobCommitted("version-id", "sha")).resolves.toBe(expected);
  });

  it("Project Office préserve le résultat métier quand seul l’ACK de COMMIT manque", async () => {
    database.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("ack lost");
      return { rows: [] };
    });

    const error = await withProjectOfficeTransaction(async () => ({ file: { id: "file-1" } }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PoCommitUncertainError);
    expect(error.transactionResult).toEqual({ file: { id: "file-1" } });
    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("Project Office nettoie via ROLLBACK sur une erreur pré-COMMIT", async () => {
    const businessError = new Error("insert failed");
    await expect(withProjectOfficeTransaction(async () => {
      throw businessError;
    })).rejects.toBe(businessError);

    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("Project Office destroys a client whose ROLLBACK acknowledgement is uncertain", async () => {
    database.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback acknowledgement lost");
      return { rows: [] };
    });

    await expect(withProjectOfficeTransaction(async () => {
      throw new Error("insert failed");
    })).rejects.toBeInstanceOf(PoRollbackUncertainError);

    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("OF détruit le client incertain et ne lance jamais ROLLBACK après COMMIT", async () => {
    database.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("ack lost");
      return { rows: [] };
    });
    const afterRollback = vi.fn();

    const error = await withOfTransaction(
      async () => ({ documentId: "of-document" }),
      { afterConfirmedRollback: afterRollback }
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(OfCommitUncertainError);
    expect(error.transactionResult).toEqual({ documentId: "of-document" });
    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(database.release).toHaveBeenCalledWith(true);
    expect(afterRollback).not.toHaveBeenCalled();
  });

  it("OF compense seulement après ROLLBACK confirmé et libération du client", async () => {
    const businessError = new Error("insert failed");
    const afterRollback = vi.fn(() => {
      expect(database.release).toHaveBeenCalledWith(false);
    });

    await expect(withOfTransaction(
      async () => { throw businessError; },
      { afterConfirmedRollback: afterRollback }
    )).rejects.toBe(businessError);

    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(afterRollback).toHaveBeenCalledOnce();
  });

  it("OF préserve sans compensation si l'ACK de ROLLBACK est perdu", async () => {
    database.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback ack lost");
      return { rows: [] };
    });
    const afterRollback = vi.fn();

    await expect(withOfTransaction(
      async () => { throw new Error("insert failed"); },
      { afterConfirmedRollback: afterRollback }
    )).rejects.toBeInstanceOf(OfRollbackUncertainError);

    expect(database.release).toHaveBeenCalledWith(true);
    expect(afterRollback).not.toHaveBeenCalled();
  });

  it.each([
    ["exact", {}, "committed"],
    ["business absent", {
      document_id: null,
      of_id: null,
      revision_id: null,
      payload_sha256: null,
      pdf_sha256: null,
      pdf_byte_size: null,
      ged_document_id: null,
      ged_version_id: null,
      ged_document_row_id: null,
      ged_document_current_version_id: null,
      ged_document_archived_at: null,
      ged_version_document_id: null,
      ged_version_status: null,
      ged_blob_sha256: null,
      ged_blob_storage_key: null,
      ged_blob_size_bytes: null,
    }, "not-committed"],
    ["version GED partielle", { document_id: null }, "uncertain"],
    ["current_version GED ancien", { ged_document_current_version_id: "version-old" }, "uncertain"],
    ["statut version inattendu", { ged_version_status: "APPLICABLE" }, "uncertain"],
  ] as const)("OF rapproche l'état frais %s sans faux cleanup", async (_label, overrides, outcome) => {
    const expectation: OfDocumentCommitExpectation = {
      documentId: "00000000-0000-4000-8000-000000000001",
      ofId: 42,
      revisionId: "00000000-0000-4000-8000-000000000002",
      payloadSha256: "payload-sha",
      pdfSha256: "pdf-sha",
      pdfByteSize: 123,
      gedDocumentId: "00000000-0000-4000-8000-000000000003",
      gedVersionId: "00000000-0000-4000-8000-000000000004",
      gedBlobStorageKey: "vault/sha256/aa/bb/pdf-sha",
      gedVersionStatus: "BROUILLON",
      gedDocumentWasPreexisting: false,
    };
    const exactRow = {
      document_id: expectation.documentId,
      of_id: expectation.ofId,
      revision_id: expectation.revisionId,
      payload_sha256: expectation.payloadSha256,
      pdf_sha256: expectation.pdfSha256,
      pdf_byte_size: expectation.pdfByteSize,
      ged_document_id: expectation.gedDocumentId,
      ged_version_id: expectation.gedVersionId,
      ged_document_row_id: expectation.gedDocumentId,
      ged_document_current_version_id: expectation.gedVersionId,
      ged_document_archived_at: null,
      ged_version_document_id: expectation.gedDocumentId,
      ged_version_status: expectation.gedVersionStatus,
      ged_blob_sha256: expectation.pdfSha256,
      ged_blob_storage_key: expectation.gedBlobStorageKey,
      ged_blob_size_bytes: String(expectation.pdfByteSize),
      ...overrides,
    };
    database.query.mockResolvedValueOnce({ rows: [exactRow] });

    await expect(reconcileOfDocumentMetadataCommit(expectation)).resolves.toBe(outcome);
  });

  it("OF classe absent une nouvelle version non appliquée sur un document GED préexistant", async () => {
    const expectation: OfDocumentCommitExpectation = {
      documentId: "00000000-0000-4000-8000-000000000011",
      ofId: 42,
      revisionId: "00000000-0000-4000-8000-000000000012",
      payloadSha256: "payload-sha",
      pdfSha256: "pdf-sha",
      pdfByteSize: 123,
      gedDocumentId: "00000000-0000-4000-8000-000000000013",
      gedVersionId: "00000000-0000-4000-8000-000000000014",
      gedBlobStorageKey: "vault/sha256/aa/bb/pdf-sha",
      gedVersionStatus: "BROUILLON",
      gedDocumentWasPreexisting: true,
    };
    database.query.mockResolvedValueOnce({ rows: [{
      document_id: null,
      ged_version_document_id: null,
      ged_document_row_id: expectation.gedDocumentId,
    }] });

    await expect(reconcileOfDocumentMetadataCommit(expectation)).resolves.toBe("not-committed");
  });
});
