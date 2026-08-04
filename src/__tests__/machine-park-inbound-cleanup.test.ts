import fs from "node:fs/promises";
import path from "node:path";

import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadMachineDocument } from "../module/production/controllers/machine-park.controller";
import {
  registerIncomingUploadStagingForTests,
  setOwnedPathRemovalHookForTests,
} from "../shared/uploads/secure-upload";
import { getTmpStoragePath } from "../utils/cerpStorage";

const temporaryDirectories: string[] = [];

async function stagingFile(): Promise<Express.Multer.File> {
  const directory = await fs.mkdtemp(path.join(getTmpStoragePath(), "machine-inbound-cleanup-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "upload.part");
  await fs.writeFile(filePath, "%PDF-1.7", { mode: 0o600 });
  const file = {
    fieldname: "document",
    originalname: "manual.pdf",
    encoding: "7bit",
    mimetype: "application/pdf",
    destination: directory,
    filename: "upload.part",
    path: filePath,
    size: 8,
    stream: undefined as never,
    buffer: Buffer.alloc(0),
  } as Express.Multer.File;
  await registerIncomingUploadStagingForTests([file]);
  return file;
}

async function invoke(file: Express.Multer.File, data: unknown): Promise<unknown> {
  const next = vi.fn() as unknown as NextFunction;
  const req = {
    params: { id: "11111111-1111-4111-8111-111111111111" },
    body: data === undefined ? {} : { data },
    file,
  } as unknown as Request;
  await Promise.resolve(uploadMachineDocument(req, {} as Response, next));
  return (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

afterEach(async () => {
  setOwnedPathRemovalHookForTests(null);
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("machine document inbound cleanup", () => {
  for (const [label, data, code] of [
    ["métadonnées absentes", undefined, "MACHINE_DOCUMENT_METADATA_REQUIRED"],
    ["JSON invalide", "{", "INVALID_JSON"],
    ["schéma invalide", JSON.stringify({}), "VALIDATION_ERROR"],
  ] as const) {
    it(`conserve le 400 et confirme le cleanup pour ${label}`, async () => {
      const file = await stagingFile();
      const error = await invoke(file, data);
      expect(error).toMatchObject({ status: 400, ...(code ? { code } : {}) });
      await expect(fs.lstat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("remplace le 400 par un 503 observable si le cleanup ne peut pas être confirmé", async () => {
    const file = await stagingFile();
    setOwnedPathRemovalHookForTests(() => {
      throw Object.assign(new Error("injected cleanup failure"), { code: "EACCES" });
    });

    const error = await invoke(file, undefined);
    expect(error).toMatchObject({ status: 503, code: "UPLOAD_CLEANUP_FAILED" });
    await expect(fs.readFile(file.path, "utf8")).resolves.toBe("%PDF-1.7");
  });
});
