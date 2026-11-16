import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query, clientQuery, release, audit, transfer, withUploadTransaction, storagePath } = vi.hoisted(() => ({
  query: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), audit: vi.fn(),
  transfer: vi.fn(), withUploadTransaction: vi.fn(), storagePath: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: { query, connect: vi.fn(async () => ({ query: clientQuery, release })) } }));
vi.mock("../../../shared/uploads/secure-upload", () => ({ transferSecureUploadToDestination: transfer }));
vi.mock("../../../shared/uploads/upload-transaction", () => ({ withUploadTransaction }));
vi.mock("../../../utils/cerpStorage", () => ({ ensureDocumentStoragePath: storagePath }));
vi.mock("./stock-movement-core.repository", () => ({ insertAuditLog: audit }));

import {
  repoGetArticleDocumentForDownload,
  repoListMovementDocuments,
  repoRemoveMovementDocument,
} from "./stock-documents.repository";

const actor = { user_id: 7 } as never;
let temporaryDirectory: string | undefined;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

async function ownedTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-stock-documents-"));
  return temporaryDirectory;
}

describe("stock document owner", () => {
  it("returns null for a missing movement target before listing documents", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(repoListMovementDocuments("00000000-0000-0000-0000-000000000001")).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns authenticated download metadata and audits only a resolved article document", async () => {
    query.mockResolvedValueOnce({ rows: [{ storage_path: "owned/document.pdf", mime_type: "application/pdf", original_name: "document.pdf" }] });
    await expect(repoGetArticleDocumentForDownload("a", "d", actor)).resolves.toEqual({ storage_path: "owned/document.pdf", mime_type: "application/pdf", original_name: "document.pdf" });
    expect(audit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({ action: "stock.articles.documents.download", details: expect.objectContaining({ original_name: "document.pdf" }) }));
  });

  it("rolls back a missing movement document without audit or file mutation", async () => {
    clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ ok: 1 }] }).mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({});
    await expect(repoRemoveMovementDocument("m", "d", actor)).resolves.toBe(false);
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "ROLLBACK"]));
    expect(audit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("attaches an article document through the owned transaction and returns its read model", async () => {
    const directory = await ownedTemporaryDirectory();
    storagePath.mockReturnValue(directory);
    transfer.mockImplementation(async (_document: unknown, destination: string) => {
      await fs.writeFile(destination, "owned bytes");
    });
    withUploadTransaction.mockImplementation(async ({ client, work }: { client: { query: (sql: string) => Promise<unknown> }; work: () => Promise<unknown> }) => {
      await client.query("BEGIN");
      const result = await work();
      await client.query("COMMIT");
      release();
      return result;
    });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "00000000-0000-0000-0000-000000000002", original_name: "plan.pdf", stored_name: "plan.pdf", storage_path: "ignored", mime_type: "application/pdf", size_bytes: "11", sha256: "hash", label: null, created_at: "", updated_at: "", uploaded_by: 7, removed_at: null, removed_by: null }] })
      .mockResolvedValueOnce({});
    query
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({ rows: [{ document_id: "00000000-0000-0000-0000-000000000002", document_name: "plan.pdf" }] });

    const document = { originalname: "plan.pdf", mimetype: "application/pdf", size: 11, path: "staged" } as Express.Multer.File;
    await expect((await import("./stock-documents.repository")).repoAttachArticleDocuments("00000000-0000-0000-0000-000000000001", [document], {}, actor))
      .resolves.toEqual([{ document_id: "00000000-0000-0000-0000-000000000002", document_name: "plan.pdf" }]);
    expect(audit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({ action: "stock.articles.documents.attach" }));
    expect(await fs.readdir(directory)).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the owned temporary destination after transfer file I/O fails before audit", async () => {
    const directory = await ownedTemporaryDirectory();
    storagePath.mockReturnValue(directory);
    transfer.mockImplementation(async (_document: unknown, destination: string) => {
      await fs.writeFile(destination, "partial bytes");
      throw new Error("simulated destination write failure");
    });
    withUploadTransaction.mockImplementation(async ({ client, work }: { client: { query: (sql: string) => Promise<unknown> }; work: () => Promise<unknown> }) => {
      await client.query("BEGIN");
      try {
        return await work();
      } catch (error) {
        await client.query("ROLLBACK");
        await Promise.all((await fs.readdir(directory)).map((entry) => fs.unlink(path.join(directory, entry))));
        release();
        throw error;
      }
    });
    clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ ok: 1 }] }).mockResolvedValueOnce({});
    const document = { originalname: "plan.pdf", mimetype: "application/pdf", size: 13, path: "staged" } as Express.Multer.File;

    await expect((await import("./stock-documents.repository")).repoAttachArticleDocuments("00000000-0000-0000-0000-000000000001", [document], {}, actor))
      .rejects.toThrow("simulated destination write failure");
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "ROLLBACK"]));
    expect(await fs.readdir(directory)).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
