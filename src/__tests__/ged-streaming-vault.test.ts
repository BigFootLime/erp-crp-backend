import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupUploadsAfterConfirmedRollback,
  clearRegisteredUploadDestinationsForTests,
  getRegisteredUploadDestinationCountForTests,
} from "../shared/uploads/secure-upload";
import { assertAcceptedFileOnDisk } from "../module/ged/domain/ged-content";
import {
  computeFileSha256,
  writeBlobFromPath,
} from "../module/ged/services/ged-vault.service";

const PDF_RULES = {
  class_key: "PLAN_CLIENT",
  allowed_mime_types: ["application/pdf"],
  allowed_extensions: [".pdf"],
  max_size_bytes: 512 * 1024 * 1024,
} as const;

describe("GED — pipeline disque borné", () => {
  let temporaryRoot: string;
  let vaultRoot: string;

  beforeEach(async () => {
    clearRegisteredUploadDestinationsForTests();
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-stream-"));
    vaultRoot = path.join(temporaryRoot, "ged-volume");
    await fs.mkdir(vaultRoot, { mode: 0o700 });
    process.env.CERP_GED_VAULT_ROOT = vaultRoot;
    process.env.CERP_GED_REQUIRE_SENTINEL = "false";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CERP_GED_VAULT_ROOT;
    delete process.env.CERP_GED_REQUIRE_SENTINEL;
    clearRegisteredUploadDestinationsForTests();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  async function largeSparsePdf(name: string): Promise<string> {
    const source = path.join(temporaryRoot, name);
    const handle = await fs.open(source, "wx", 0o600);
    try {
      await handle.write(Buffer.from("%PDF-1.7\n", "ascii"), 0, 9, 0);
      // Large enough to detect accidental whole-file buffering while keeping
      // the suite fast; the transport policy itself remains 512 MiB.
      await handle.truncate(32 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    return source;
  }

  it("valide, hache et promeut un gros fichier sans fs.readFile", async () => {
    const source = await largeSparsePdf("large.pdf.part");
    const readFile = vi.spyOn(fs, "readFile");

    const accepted = await assertAcceptedFileOnDisk({
      path: source,
      originalname: "large.pdf",
      mimetype: "application/pdf",
      size: 32 * 1024 * 1024,
    }, PDF_RULES);
    const expectedHash = await computeFileSha256(source);
    const sourceFile = { path: accepted.path };
    const written = await writeBlobFromPath(sourceFile);

    expect(written).toMatchObject({
      sha256: expectedHash,
      size_bytes: 32 * 1024 * 1024,
      deduplicated: false,
      ownership: { kind: "created" },
    });
    expect(readFile).not.toHaveBeenCalled();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });

    const destination = path.join(vaultRoot, ...written.storage_key.split("/"));
    expect((await fs.stat(destination)).size).toBe(32 * 1024 * 1024);

    // A proven pre-COMMIT rollback owns and removes the promoted blob.
    await cleanupUploadsAfterConfirmedRollback([sourceFile]);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("déduplique par flux et nettoie aussi le second staging", async () => {
    const first = await largeSparsePdf("first.pdf.part");
    const firstWritten = await writeBlobFromPath({ path: first });
    const second = await largeSparsePdf("second.pdf.part");
    const readFile = vi.spyOn(fs, "readFile");

    const secondWritten = await writeBlobFromPath({ path: second });
    expect(secondWritten.sha256).toBe(firstWritten.sha256);
    expect(secondWritten.deduplicated).toBe(true);
    expect(secondWritten.ownership).toEqual({ kind: "deduplicated" });
    expect(readFile).not.toHaveBeenCalled();
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });

    await cleanupUploadsAfterConfirmedRollback([{ path: first }]);
  });

  it("nettoie le hardlink GED si son ouverture post-link échoue", async () => {
    const source = path.join(temporaryRoot, "link-open-failure.pdf.part");
    await fs.writeFile(source, Buffer.from("%PDF-1.7\ncontenu A\n", "ascii"), { mode: 0o600 });
    const expectedHash = await computeFileSha256(source);
    const destination = path.join(
      vaultRoot,
      "vault",
      "sha256",
      expectedHash.slice(0, 2),
      expectedHash.slice(2, 4),
      expectedHash
    );
    const realOpen = fs.open.bind(fs);
    const openError = Object.assign(new Error("post-link open denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (path.resolve(String(args[0])) === path.resolve(destination)) throw openError;
      return realOpen(...args);
    });

    await expect(writeBlobFromPath({ path: source })).rejects.toBe(openError);

    await expect(fs.readFile(source, "utf8")).resolves.toContain("contenu A");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("nettoie le hardlink GED si son chmod post-link échoue", async () => {
    const source = path.join(temporaryRoot, "link-chmod-failure.pdf.part");
    await fs.writeFile(source, Buffer.from("%PDF-1.7\ncontenu A\n", "ascii"), { mode: 0o600 });
    const expectedHash = await computeFileSha256(source);
    const destination = path.join(
      vaultRoot,
      "vault",
      "sha256",
      expectedHash.slice(0, 2),
      expectedHash.slice(2, 4),
      expectedHash
    );
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

    await expect(writeBlobFromPath({ path: source })).rejects.toBe(chmodError);

    await expect(fs.readFile(source, "utf8")).resolves.toContain("contenu A");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuse et préserve B si le chemin GED remplace le hardlink A avant son ouverture", async () => {
    const source = path.join(temporaryRoot, "link-replaced.pdf.part");
    await fs.writeFile(source, Buffer.from("%PDF-1.7\ncontenu A\n", "ascii"), { mode: 0o600 });
    const expectedHash = await computeFileSha256(source);
    const destination = path.join(
      vaultRoot,
      "vault",
      "sha256",
      expectedHash.slice(0, 2),
      expectedHash.slice(2, 4),
      expectedHash
    );
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

    await expect(writeBlobFromPath({ path: source })).rejects.toMatchObject({
      status: 503,
      code: "UPLOAD_CLEANUP_FAILED",
    });

    await expect(fs.readFile(source, "utf8")).resolves.toContain("contenu A");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("contenu B");
  });

  it.each(["link", "copy"] as const)(
    "garde un blob %s altéré observable si sa compensation échoue",
    async (promotionMode) => {
      const source = path.join(temporaryRoot, `${promotionMode}.pdf.part`);
      await fs.writeFile(source, Buffer.from("%PDF-1.7\ncontenu-original\n", "ascii"), { mode: 0o600 });
      const expectedHash = await computeFileSha256(source);
      const sourceFile = { path: source };
      const storageKey = `vault/sha256/${expectedHash.slice(0, 2)}/${expectedHash.slice(2, 4)}/${expectedHash}`;
      const destination = path.join(vaultRoot, ...storageKey.split("/"));

      if (promotionMode === "copy") {
        vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
      }
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (path.resolve(String(args[0])) === path.resolve(destination)) {
          const realChmod = handle.chmod.bind(handle);
          Object.defineProperty(handle, "chmod", {
            configurable: true,
            value: async (mode: number) => {
              await realChmod(mode);
              if (promotionMode === "copy") {
                await handle.truncate(0);
                const corrupted = Buffer.from("contenu-altéré", "utf8");
                await handle.write(corrupted, 0, corrupted.byteLength, 0);
              } else {
                await fs.writeFile(destination, "contenu-altéré", { encoding: "utf8" });
              }
            },
          });
        }
        return handle;
      });
      const realRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (candidate, target) => {
        if (path.resolve(String(candidate)) === path.resolve(destination)) {
          throw Object.assign(new Error("vault locked"), { code: "EACCES" });
        }
        return realRename(candidate, target);
      });

      let observedError: unknown;
      try {
        await writeBlobFromPath(sourceFile);
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });
      expect(String((observedError as Error).message)).not.toContain(temporaryRoot);
      expect(String((observedError as Error).message)).not.toContain("GED_INTEGRITY");
      expect(getRegisteredUploadDestinationCountForTests()).toBe(1);
      await expect(fs.stat(destination)).resolves.toBeDefined();

      // The non-terminal ownership record remains retryable after the
      // filesystem fault is removed.
      renameSpy.mockImplementation(realRename);
      await cleanupUploadsAfterConfirmedRollback([sourceFile]);
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );
});
