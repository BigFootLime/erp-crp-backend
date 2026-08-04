import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSecureUpload,
  removeOwnedPathSafely,
  writeSecureBufferToDestination,
} from "../shared/uploads/secure-upload";

const roots: string[] = [];
const originalTmpRoot = process.env.CERP_TMP_ROOT;

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function directoryLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

afterEach(async () => {
  if (originalTmpRoot === undefined) delete process.env.CERP_TMP_ROOT;
  else process.env.CERP_TMP_ROOT = originalTmpRoot;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("private upload directory symlink hardening", () => {
  it("refuse une .secure-delete préexistante comme symlink/junction", async () => {
    const root = await temporaryRoot("cerp-secure-delete-root-");
    const outside = await temporaryRoot("cerp-secure-delete-outside-");
    const destination = path.join(root, "owned.pdf");
    await fs.writeFile(destination, "owned", { flag: "wx", mode: 0o600 });
    const identity = await fs.stat(destination, { bigint: true });
    await directoryLink(outside, path.join(root, ".secure-delete"));

    await expect(removeOwnedPathSafely(destination, identity))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("owned");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("refuse une .secure-buffer-staging préexistante comme symlink/junction", async () => {
    const root = await temporaryRoot("cerp-secure-buffer-root-");
    const outside = await temporaryRoot("cerp-secure-buffer-outside-");
    const destination = path.join(root, "evidence.pdf");
    await directoryLink(outside, path.join(root, ".secure-buffer-staging"));

    await expect(writeSecureBufferToDestination(Buffer.from("evidence"), destination))
      .rejects.toMatchObject({ status: 503, code: "UPLOAD_STAGING_PERMISSION_FAILED" });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("refuse upload-quarantine/<usage> préexistant comme symlink/junction", async () => {
    const root = await temporaryRoot("cerp-quarantine-root-");
    const outside = await temporaryRoot("cerp-quarantine-outside-");
    const quarantine = path.join(root, "upload-quarantine");
    await fs.mkdir(quarantine, { mode: 0o700 });
    await directoryLink(outside, path.join(quarantine, "business-document"));
    process.env.CERP_TMP_ROOT = root;

    expect(() => createSecureUpload("business-document"))
      .toThrow(expect.objectContaining({ status: 503, code: "UPLOAD_STAGING_PERMISSION_FAILED" }));
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});
