import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupUploadsAfterConfirmedRollback } from "../shared/uploads/secure-upload";
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
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-stream-"));
    vaultRoot = path.join(temporaryRoot, "ged-volume");
    process.env.CERP_GED_VAULT_ROOT = vaultRoot;
    process.env.CERP_GED_REQUIRE_SENTINEL = "false";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CERP_GED_VAULT_ROOT;
    delete process.env.CERP_GED_REQUIRE_SENTINEL;
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
    const written = await writeBlobFromPath(accepted.path);

    expect(written).toMatchObject({
      sha256: expectedHash,
      size_bytes: 32 * 1024 * 1024,
      deduplicated: false,
    });
    expect(readFile).not.toHaveBeenCalled();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });

    const destination = path.join(vaultRoot, ...written.storage_key.split("/"));
    expect((await fs.stat(destination)).size).toBe(32 * 1024 * 1024);

    // A proven pre-COMMIT rollback owns and removes the promoted blob.
    await cleanupUploadsAfterConfirmedRollback([{ path: source }]);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("déduplique par flux et nettoie aussi le second staging", async () => {
    const first = await largeSparsePdf("first.pdf.part");
    const firstWritten = await writeBlobFromPath(first);
    const second = await largeSparsePdf("second.pdf.part");
    const readFile = vi.spyOn(fs, "readFile");

    const secondWritten = await writeBlobFromPath(second);
    expect(secondWritten.sha256).toBe(firstWritten.sha256);
    expect(secondWritten.deduplicated).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });

    await cleanupUploadsAfterConfirmedRollback([{ path: first }]);
  });
});
