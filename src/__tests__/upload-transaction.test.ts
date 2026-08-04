import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { promoteSecureUpload, registerUploadDestination } from "../shared/uploads/secure-upload";
import {
  UploadCommitUncertainError,
  UploadRollbackUncertainError,
  classifyUploadReconciliation,
  withUploadTransaction,
} from "../shared/uploads/upload-transaction";

type FakeClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

const roots: string[] = [];

async function ownedFile(): Promise<{ source: string; destination: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-tx-"));
  roots.push(root);
  const source = path.join(root, "upload.part");
  const destination = path.join(root, "durable.pdf");
  await fs.writeFile(destination, "%PDF-1.7\n");
  registerUploadDestination({ path: source }, destination);
  return { source, destination };
}

function clientWith(handler?: (sql: string) => Promise<unknown>): FakeClient {
  return {
    query: vi.fn(async (sql: string) => handler ? handler(sql) : { rows: [] }),
    release: vi.fn(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("shared upload transaction lifecycle", () => {
  it("tracks a staging file after promotion mutates its path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-promote-"));
    roots.push(root);
    const stagingPath = path.join(root, "machine.part");
    const durableDirectory = path.join(root, "images");
    await fs.writeFile(stagingPath, "safe image");
    const file = {
      path: stagingPath,
      originalname: "machine.png",
      fieldname: "image",
      encoding: "7bit",
      mimetype: "image/png",
      size: 10,
      destination: path.dirname(stagingPath),
      filename: path.basename(stagingPath),
      stream: null,
      buffer: Buffer.alloc(0),
    } as unknown as Express.Multer.File;
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [file],
      context: "test.promoted-path",
      work: async () => promoteSecureUpload(file, durableDirectory, "machine.png"),
      reconcile: async () => "uncertain",
    })).resolves.toBe(path.resolve(durableDirectory, "machine.png"));

    expect(file.path).toBe(path.resolve(durableDirectory, "machine.png"));
    await expect(fs.stat(file.path)).resolves.toBeDefined();
  });

  it("removes an in-transaction promotion after a confirmed downstream rejection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-promote-reject-"));
    roots.push(root);
    const stagingPath = path.join(root, "machine.part");
    const durableDirectory = path.join(root, "images");
    await fs.writeFile(stagingPath, "safe image");
    const file = {
      path: stagingPath,
      originalname: "machine.png",
      fieldname: "image",
      encoding: "7bit",
      mimetype: "image/png",
      size: 10,
      destination: path.dirname(stagingPath),
      filename: path.basename(stagingPath),
      stream: null,
      buffer: Buffer.alloc(0),
    } as unknown as Express.Multer.File;
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [file],
      context: "test.promoted-path-rejected",
      work: async () => {
        await promoteSecureUpload(file, durableDirectory, "machine.png");
        throw new Error("downstream 422");
      },
      reconcile: async () => "uncertain",
    })).rejects.toThrow("downstream 422");

    await expect(fs.stat(path.join(durableDirectory, "machine.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a normal commit terminal and preserves its durable destination", async () => {
    const file = await ownedFile();
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.normal",
      work: async () => ({ id: "doc-1" }),
      reconcile: async () => "uncertain",
    })).resolves.toEqual({ id: "doc-1" });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledWith(false);
    await expect(fs.readFile(file.destination, "utf8")).resolves.toContain("%PDF");
  });

  it("removes durable files only after a confirmed pre-COMMIT rollback", async () => {
    const file = await ownedFile();
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.rollback",
      work: async () => { throw new Error("downstream rejected"); },
      reconcile: async () => "uncertain",
    })).rejects.toThrow("downstream rejected");

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    await expect(fs.stat(file.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats COMMIT ACK loss with a matching fresh row as success and never rolls back", async () => {
    const file = await ownedFile();
    const client = clientWith(async (sql) => {
      if (sql === "COMMIT") throw new Error("connection reset after commit");
      return { rows: [] };
    });

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.ack-loss-present",
      work: async () => ({ id: "doc-2" }),
      reconcile: async () => "committed",
    })).resolves.toEqual({ id: "doc-2" });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledWith(true);
    await expect(fs.stat(file.destination)).resolves.toBeDefined();
  });

  it("cleans after a fresh read proves a lost COMMIT was not applied", async () => {
    const file = await ownedFile();
    const client = clientWith(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit rejected");
      return { rows: [] };
    });

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.ack-loss-absent",
      work: async () => ({ id: "doc-3" }),
      reconcile: async () => "not-committed",
    })).rejects.toThrow("commit rejected");

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    await expect(fs.stat(file.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves ownership when COMMIT reconciliation is unavailable or partial", async () => {
    const file = await ownedFile();
    const client = clientWith(async (sql) => {
      if (sql === "COMMIT") throw new Error("ack lost");
      return { rows: [] };
    });

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.ack-loss-unknown",
      work: async () => ({ id: "doc-4" }),
      reconcile: async () => "uncertain",
    })).rejects.toBeInstanceOf(UploadCommitUncertainError);
    await expect(fs.stat(file.destination)).resolves.toBeDefined();
  });

  it("preserves ownership when rollback itself cannot be confirmed", async () => {
    const file = await ownedFile();
    const client = clientWith(async (sql) => {
      if (sql === "ROLLBACK") throw new Error("rollback connection lost");
      return { rows: [] };
    });

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.rollback-unknown",
      work: async () => { throw new Error("business failure"); },
      reconcile: async () => "uncertain",
    })).rejects.toBeInstanceOf(UploadRollbackUncertainError);
    expect(client.release).toHaveBeenCalledWith(true);
    await expect(fs.stat(file.destination)).resolves.toBeDefined();
  });

  it("classifies exact, absent, and partial fresh identities deterministically", () => {
    expect(classifyUploadReconciliation(["a", "b"], ["b", "a"])).toBe("committed");
    expect(classifyUploadReconciliation(["a", "b"], [])).toBe("not-committed");
    expect(classifyUploadReconciliation(["a", "b"], ["a"])).toBe("uncertain");
    expect(classifyUploadReconciliation(["a"], ["different"])).toBe("uncertain");
  });
});
