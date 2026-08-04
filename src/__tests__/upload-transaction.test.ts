import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupUploadsAfterConfirmedRollback,
  cleanupSecureBufferDestination,
  clearRegisteredUploadDestinationsForTests,
  getRegisteredUploadDestinationCountForTests,
  promoteSecureUpload,
  registerUploadDestination,
  setOwnedPathRemovalHookForTests,
  transferSecureUploadToDestination,
  verifySecureBufferDestination,
  writeSecureBufferToDestination,
  UploadDestinationCleanupError,
} from "../shared/uploads/secure-upload";
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

function multerFile(source: string, originalname = "document.pdf"): Express.Multer.File {
  return {
    path: source,
    originalname,
    fieldname: "document",
    encoding: "7bit",
    mimetype: "application/pdf",
    size: 10,
    destination: path.dirname(source),
    filename: path.basename(source),
    stream: null,
    buffer: Buffer.alloc(0),
  } as unknown as Express.Multer.File;
}

afterEach(async () => {
  vi.restoreAllMocks();
  setOwnedPathRemovalHookForTests(null);
  clearRegisteredUploadDestinationsForTests();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("shared upload transaction lifecycle", () => {
  it("publie un buffer via une ownership opaque puis vérifie SHA, taille et inode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-buffer-owned-"));
    roots.push(root);
    const destination = path.join(root, "evidence.pdf");
    const buffer = Buffer.from("%PDF-1.7\nbuffer sécurisé\n", "utf8");
    const sha256 = (await import("node:crypto")).createHash("sha256").update(buffer).digest("hex");

    const ownership = await writeSecureBufferToDestination(buffer, destination);

    expect(JSON.stringify(ownership)).toBe("{}");
    await expect(verifySecureBufferDestination(ownership, sha256, buffer.byteLength)).resolves.toBe(true);
    await expect(cleanupSecureBufferDestination(ownership)).resolves.toBe("deleted");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("préserve un remplacement B lors du cleanup d'un buffer appartenant à A", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-buffer-replaced-"));
    roots.push(root);
    const destination = path.join(root, "evidence.pdf");
    const ownership = await writeSecureBufferToDestination(Buffer.from("contenu A"), destination);
    await fs.unlink(destination);
    await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });

    await expect(cleanupSecureBufferDestination(ownership))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
    const tombstones = await fs.readdir(path.join(root, ".secure-delete"));
    expect(tombstones).toHaveLength(1);
    await expect(fs.readFile(path.join(root, ".secure-delete", tombstones[0]!), "utf8"))
      .resolves.toBe("contenu B");
  });

  it("préserve B injecté exactement avant le retrait atomique d'un buffer A", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-buffer-removal-race-"));
    roots.push(root);
    const destination = path.join(root, "evidence.pdf");
    const ownership = await writeSecureBufferToDestination(Buffer.from("contenu A"), destination);
    setOwnedPathRemovalHookForTests(async ({ destination: candidate }) => {
      if (path.resolve(candidate) !== path.resolve(destination)) return;
      setOwnedPathRemovalHookForTests(null);
      await fs.unlink(destination);
      await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });
    });

    await expect(cleanupSecureBufferDestination(ownership))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
  });

  it("conserve B en tombstone si un writer C gagne le chemin avant sa restauration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-buffer-third-writer-"));
    roots.push(root);
    const destination = path.join(root, "evidence.pdf");
    const ownership = await writeSecureBufferToDestination(Buffer.from("contenu A"), destination);
    setOwnedPathRemovalHookForTests(async ({ destination: candidate }) => {
      if (path.resolve(candidate) !== path.resolve(destination)) return;
      setOwnedPathRemovalHookForTests(null);
      await fs.unlink(destination);
      await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });
    });
    const realLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (
        path.dirname(path.resolve(String(source))).endsWith(".secure-delete")
        && path.resolve(String(target)) === path.resolve(destination)
      ) {
        await fs.writeFile(destination, "contenu C", { flag: "wx", mode: 0o600 });
      }
      return realLink(source, target);
    });

    await expect(cleanupSecureBufferDestination(ownership))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu C");
    const tombstones = await fs.readdir(path.join(root, ".secure-delete"));
    expect(tombstones).toHaveLength(1);
    await expect(fs.readFile(path.join(root, ".secure-delete", tombstones[0]!), "utf8"))
      .resolves.toBe("contenu B");
  });

  it("conserve la clé staging après promotion et retourne la destination durable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-promote-"));
    roots.push(root);
    const stagingPath = path.join(root, "machine.part");
    const durableDirectory = path.join(root, "images");
    await fs.writeFile(stagingPath, "safe image");
    const file = multerFile(stagingPath, "machine.png");
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [file],
      context: "test.promoted-path",
      work: async () => promoteSecureUpload(file, durableDirectory, "machine.png"),
      reconcile: async () => "uncertain",
    })).resolves.toBe(path.resolve(durableDirectory, "machine.png"));

    expect(file.path).toBe(stagingPath);
    expect(file.destination).toBe(path.resolve(durableDirectory));
    expect(file.filename).toBe("machine.png");
    await expect(fs.stat(path.resolve(durableDirectory, "machine.png"))).resolves.toBeDefined();
  });

  it("removes an in-transaction promotion after a confirmed downstream rejection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-promote-reject-"));
    roots.push(root);
    const stagingPath = path.join(root, "machine.part");
    const durableDirectory = path.join(root, "images");
    await fs.writeFile(stagingPath, "safe image");
    const file = multerFile(stagingPath, "machine.png");
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

  it("ne transforme jamais une erreur de lien non-EXDEV en copie", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-link-error-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "source");
    const linkError = Object.assign(new Error("access denied"), { code: "EACCES" });
    vi.spyOn(fs, "link").mockRejectedValueOnce(linkError);
    const copySpy = vi.spyOn(fs, "copyFile");

    await expect(transferSecureUploadToDestination(multerFile(source), destination)).rejects.toBe(linkError);

    expect(copySpy).not.toHaveBeenCalled();
    await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuse sans écrasement une collision sur le même système de fichiers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-link-collision-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "nouveau");
    await fs.writeFile(destination, "historique");
    const copySpy = vi.spyOn(fs, "copyFile");

    await expect(transferSecureUploadToDestination(multerFile(source), destination)).rejects.toMatchObject({ code: "EEXIST" });

    expect(copySpy).not.toHaveBeenCalled();
    await expect(fs.readFile(source, "utf8")).resolves.toBe("nouveau");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("historique");
  });

  it("nettoie son hardlink si l'ouverture post-link échoue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-link-open-failure-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu A");
    const file = multerFile(source);
    const realOpen = fs.open.bind(fs);
    const openError = Object.assign(new Error("post-link open denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (path.resolve(String(args[0])) === path.resolve(destination)) throw openError;
      return realOpen(...args);
    });

    await expect(transferSecureUploadToDestination(file, destination)).rejects.toBe(openError);

    await expect(fs.readFile(source, "utf8")).resolves.toBe("contenu A");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("nettoie son hardlink si le chmod post-link échoue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-link-chmod-failure-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu A");
    const file = multerFile(source);
    const realOpen = fs.open.bind(fs);
    const chmodError = Object.assign(new Error("post-link chmod denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(destination)) {
        Object.defineProperty(handle, "chmod", {
          configurable: true,
          value: vi.fn(async () => { throw chmodError; }),
        });
      }
      return handle;
    });

    await expect(transferSecureUploadToDestination(file, destination)).rejects.toBe(chmodError);

    await expect(fs.readFile(source, "utf8")).resolves.toBe("contenu A");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuse et préserve B si la destination remplace le hardlink A avant son ouverture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-link-replaced-"));
    roots.push(root);
    const source = path.join(root, "upload-a.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu A");
    const file = multerFile(source);
    const realOpen = fs.open.bind(fs);
    let replacementInjected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replacementInjected && path.resolve(String(args[0])) === path.resolve(destination)) {
        replacementInjected = true;
        await fs.unlink(destination);
        await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });
      }
      return realOpen(...args);
    });

    await expect(transferSecureUploadToDestination(file, destination)).rejects.toMatchObject({
      status: 503,
      code: "UPLOAD_CLEANUP_FAILED",
    });

    await expect(fs.readFile(source, "utf8")).resolves.toBe("contenu A");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
  });

  it("refuse sans écrasement une collision pendant le fallback EXDEV", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-copy-collision-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "nouveau");
    await fs.writeFile(destination, "historique");
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));

    await expect(transferSecureUploadToDestination(multerFile(source), destination)).rejects.toMatchObject({ code: "EEXIST" });

    await expect(fs.readFile(source, "utf8")).resolves.toBe("nouveau");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("historique");
  });

  it("transfère exclusivement entre volumes, applique 0600 et supprime le staging", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-cross-device-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu sûr");
    const file = multerFile(source);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    const copySpy = vi.spyOn(fs, "copyFile");
    const openSpy = vi.spyOn(fs, "open");
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [file],
      context: "test.cross-device",
      work: async () => transferSecureUploadToDestination(file, destination),
      reconcile: async () => "uncertain",
    })).resolves.toBe(path.resolve(destination));

    expect(copySpy).not.toHaveBeenCalled();
    expect(openSpy.mock.calls.some(([candidate, flags, mode]) =>
      path.resolve(candidate.toString()) === path.resolve(destination)
        && flags === "wx"
        && mode === 0o600
    )).toBe(true);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu sûr");
    // Windows reports synthetic POSIX mode bits; the exclusive open arguments
    // above are the portable contract and Linux must additionally expose 0600.
    if (process.platform !== "win32") {
      expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  it("ne revendique rien si A échoue avant acquisition EXDEV et préserve le fichier ensuite créé par B", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-exdev-before-acquire-"));
    roots.push(root);
    const source = path.join(root, "upload-a.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu A");
    const file = multerFile(source);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("acquisition denied"), { code: "EACCES" }));

    await expect(transferSecureUploadToDestination(file, destination)).rejects.toMatchObject({ code: "EACCES" });
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0);

    await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });
    await cleanupUploadsAfterConfirmedRollback([file]);

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0);
  });

  it("supprime après rollback le fichier partiel dont A a acquis l'inode EXDEV", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-exdev-partial-owned-"));
    roots.push(root);
    const source = path.join(root, "upload-a.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu A");
    const file = multerFile(source);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    const realOpen = fs.open.bind(fs);
    const writeError = Object.assign(new Error("disk write interrupted"), { code: "EIO" });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(destination)) {
        const realWrite = handle.write.bind(handle);
        Object.defineProperty(handle, "write", {
          configurable: true,
          value: async (chunk: Buffer, offset: number, length: number, position: number) => {
            await realWrite(chunk, offset, Math.min(3, length), position);
            throw writeError;
          },
        });
      }
      return handle;
    });

    await expect(transferSecureUploadToDestination(file, destination)).rejects.toBe(writeError);
    expect(getRegisteredUploadDestinationCountForTests()).toBe(1);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await cleanupUploadsAfterConfirmedRollback([file]);
  });

  it("préserve un inode B qui a remplacé la destination enregistrée par A avant le cleanup", async () => {
    const { source, destination } = await ownedFile();
    await fs.unlink(destination);
    await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });

    await expect(cleanupUploadsAfterConfirmedRollback([{ path: source }]))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
    const tombstones = await fs.readdir(path.join(path.dirname(destination), ".secure-delete"));
    expect(tombstones).toHaveLength(1);
    await expect(fs.readFile(
      path.join(path.dirname(destination), ".secure-delete", tombstones[0]!),
      "utf8"
    )).resolves.toBe("contenu B");
  });

  it("préserve B injecté exactement avant le retrait atomique d'une destination enregistrée A", async () => {
    const { source, destination } = await ownedFile();
    setOwnedPathRemovalHookForTests(async ({ destination: candidate }) => {
      if (path.resolve(candidate) !== path.resolve(destination)) return;
      setOwnedPathRemovalHookForTests(null);
      await fs.unlink(destination);
      await fs.writeFile(destination, "contenu B", { flag: "wx", mode: 0o600 });
    });

    await expect(cleanupUploadsAfterConfirmedRollback([{ path: source }]))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
  });

  it("compense la copie durable si son unlink staging échoue avant COMMIT", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-unlink-failure-"));
    roots.push(root);
    const source = path.join(root, "upload.part");
    const destination = path.join(root, "durable.pdf");
    await fs.writeFile(source, "contenu sûr");
    const file = multerFile(source);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    const realRename = fs.rename.bind(fs);
    let sourceFailureInjected = false;
    vi.spyOn(fs, "rename").mockImplementation(async (candidate, target) => {
      if (!sourceFailureInjected && path.resolve(candidate.toString()) === path.resolve(source)) {
        sourceFailureInjected = true;
        throw Object.assign(new Error("staging locked"), { code: "EACCES" });
      }
      return realRename(candidate, target);
    });
    const client = clientWith();

    await expect(withUploadTransaction({
      client: client as never,
      files: [file],
      context: "test.cross-device-unlink-failure",
      work: async () => transferSecureUploadToDestination(file, destination),
      reconcile: async () => "uncertain",
    })).rejects.toMatchObject({ code: "UPLOAD_CLEANUP_FAILED", status: 503 });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    await expect(fs.readFile(source, "utf8")).resolves.toBe("contenu sûr");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("surfaces a durable cleanup failure after a confirmed rollback and keeps ownership observable", async () => {
    const file = await ownedFile();
    const client = clientWith();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (candidate, target) => {
      if (path.resolve(candidate.toString()) === path.resolve(file.destination)) {
        throw Object.assign(new Error("destination locked"), { code: "EACCES" });
      }
      return realRename(candidate, target);
    });

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.rollback-cleanup-failed",
      work: async () => { throw new Error("downstream rejected"); },
      reconcile: async () => "uncertain",
    })).rejects.toBeInstanceOf(UploadDestinationCleanupError);

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith(false);
    expect(getRegisteredUploadDestinationCountForTests()).toBe(1);
    await expect(fs.stat(file.destination)).resolves.toBeDefined();
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

  it("surfaces a cleanup failure after fresh reconciliation proves no commit and retains the registry", async () => {
    const file = await ownedFile();
    const client = clientWith(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit rejected");
      return { rows: [] };
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (candidate, target) => {
      if (path.resolve(candidate.toString()) === path.resolve(file.destination)) {
        throw Object.assign(new Error("destination locked"), { code: "EACCES" });
      }
      return realRename(candidate, target);
    });

    await expect(withUploadTransaction({
      client: client as never,
      files: [{ path: file.source }],
      context: "test.ack-loss-absent-cleanup-failed",
      work: async () => ({ id: "doc-cleanup-failed" }),
      reconcile: async () => "not-committed",
    })).rejects.toBeInstanceOf(UploadDestinationCleanupError);

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(getRegisteredUploadDestinationCountForTests()).toBe(1);
    await expect(fs.stat(file.destination)).resolves.toBeDefined();
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
