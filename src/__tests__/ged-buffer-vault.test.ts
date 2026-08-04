import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupOwnedVaultBlob,
  computeSha256,
  storageKeyForSha256,
  writeBlob,
} from "../module/ged/services/ged-vault.service";

describe("GED buffer vault publication", () => {
  let temporaryRoot: string;
  let vaultRoot: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-buffer-"));
    vaultRoot = path.join(temporaryRoot, "ged-volume");
    await fs.mkdir(vaultRoot, { mode: 0o700 });
    process.env.CERP_GED_VAULT_ROOT = vaultRoot;
    process.env.CERP_GED_REQUIRE_SENTINEL = "false";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CERP_GED_VAULT_ROOT;
    delete process.env.CERP_GED_REQUIRE_SENTINEL;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("publie depuis un staging privé puis distingue ownership créé et dédupliqué", async () => {
    const pdf = Buffer.from("%PDF-1.7\nGED buffer\n", "ascii");

    const first = await writeBlob(pdf);
    const second = await writeBlob(pdf);
    const destination = path.join(vaultRoot, ...first.storage_key.split("/"));
    const stagingDirectory = path.join(vaultRoot, "staging", "buffer");

    expect(first).toMatchObject({
      sha256: computeSha256(pdf),
      size_bytes: pdf.byteLength,
      deduplicated: false,
      ownership: { kind: "created", destination },
    });
    expect(second).toMatchObject({
      sha256: first.sha256,
      deduplicated: true,
      ownership: { kind: "deduplicated" },
    });
    await expect(fs.readFile(destination)).resolves.toEqual(pdf);
    await expect(fs.readdir(stagingDirectory)).resolves.toEqual([]);
    if (process.platform !== "win32") {
      expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(stagingDirectory)).mode & 0o777).toBe(0o700);
    }

    await cleanupOwnedVaultBlob(second.ownership);
    await expect(fs.readFile(destination)).resolves.toEqual(pdf);
    await cleanupOwnedVaultBlob(first.ownership);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ne publie aucun nom final partiel sur ENOSPC et permet un retry propre", async () => {
    const pdf = Buffer.from("%PDF-1.7\ncontenu complet à réessayer\n", "utf8");
    const sha256 = computeSha256(pdf);
    const destination = path.join(vaultRoot, ...storageKeyForSha256(sha256).split("/"));
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (!injected && String(args[0]).endsWith(".part")) {
          injected = true;
          const realWrite = handle.write.bind(handle);
          Object.defineProperty(handle, "writeFile", {
            configurable: true,
            value: async (buffer: Buffer) => {
              await realWrite(buffer, 0, Math.min(5, buffer.byteLength), 0);
              throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
            },
          });
        }
        return handle;
      }
    );

    await expect(writeBlob(pdf)).rejects.toMatchObject({
      status: 507,
      code: "GED_VAULT_FULL",
    });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(path.join(vaultRoot, "staging", "buffer"))).resolves.toEqual([]);

    openSpy.mockRestore();
    const retried = await writeBlob(pdf);
    expect(retried).toMatchObject({ deduplicated: false, ownership: { kind: "created" } });
    await expect(fs.readFile(destination)).resolves.toEqual(pdf);
  });
});
