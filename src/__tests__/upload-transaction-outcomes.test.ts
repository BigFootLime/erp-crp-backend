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
    const afterRollback = vi.fn();
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

    await expect(withGedTransaction(
      async () => { throw new Error("business failure"); },
      { afterConfirmedRollback: afterRollback }
    )).rejects.toBeInstanceOf(GedRollbackUncertainError);

    expect(afterRollback).not.toHaveBeenCalled();
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
});
