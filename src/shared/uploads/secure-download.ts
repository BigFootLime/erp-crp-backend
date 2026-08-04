import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Response } from "express";

import { isPathInsideDirectory } from "../../utils/cerpStorage";
import { HttpError } from "../../utils/httpError";

function asciiFilename(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.normalize("NFKD")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  return normalized && normalized !== "." && normalized !== ".." ? normalized.slice(0, 180) : "document";
}

export function buildContentDisposition(filename: string, download: boolean): string {
  const fallback = asciiFilename(filename);
  const unicodeName = filename
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim() || fallback;
  const encoded = encodeURIComponent(unicodeName).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function setSecureDownloadHeaders(
  res: Response,
  options: { filename: string; mimeType?: string | null; download?: boolean }
): void {
  res.setHeader("Content-Type", options.mimeType?.trim() || "application/octet-stream");
  res.setHeader("Content-Disposition", buildContentDisposition(options.filename, options.download === true));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (options.download !== true) res.setHeader("Content-Security-Policy", "sandbox");
}

async function realExistingDirectory(directory: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(directory));
  } catch {
    return path.resolve(directory);
  }
}

type SecureDownloadHookPhase = "after-validation" | "after-open";
type SecureDownloadHook = (
  phase: SecureDownloadHookPhase,
  context: Readonly<{ candidatePath: string; realPath: string }>
) => void | Promise<void>;

let secureDownloadHook: SecureDownloadHook | null = null;

/** Deterministic race injection for tests; never configured by application code. */
export function setSecureDownloadHookForTests(hook: SecureDownloadHook | null): void {
  secureDownloadHook = hook;
}

function notFound(): HttpError {
  return new HttpError(404, "DOCUMENT_FILE_NOT_FOUND", "Le fichier demandé est introuvable.");
}

function invalidPath(): HttpError {
  return new HttpError(400, "INVALID_STORAGE_PATH", "Le chemin de stockage du document est invalide.");
}

function sameIdentity(
  expected: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>,
  actual: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>
): boolean {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && String(expected.size) === String(actual.size);
}

type SecureOpenedFile = Readonly<{
  handle: FileHandle;
  realPath: string;
  size: number;
}>;

async function openSecureDownloadPath(filePath: string, allowedRoots: readonly string[]): Promise<SecureOpenedFile> {
  if (!allowedRoots.length) {
    throw new HttpError(500, "DOWNLOAD_ROOT_MISSING", "Le stockage documentaire n’est pas configuré.");
  }

  const candidatePath = path.resolve(filePath);
  let realPath: string;
  try {
    const candidateStat = await fs.lstat(candidatePath);
    if (candidateStat.isSymbolicLink()) throw invalidPath();
    if (!candidateStat.isFile()) throw notFound();
    realPath = await fs.realpath(candidatePath);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw notFound();
  }

  const roots = await Promise.all(allowedRoots.map(realExistingDirectory));
  if (!roots.some((root) => isPathInsideDirectory(root, realPath))) throw invalidPath();

  let validatedStat;
  try {
    validatedStat = await fs.lstat(realPath);
  } catch {
    throw notFound();
  }
  if (validatedStat.isSymbolicLink()) throw invalidPath();
  if (!validatedStat.isFile()) throw notFound();

  await secureDownloadHook?.("after-validation", { candidatePath, realPath });

  let handle: FileHandle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await fs.open(realPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw invalidPath();
    throw notFound();
  }

  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameIdentity(validatedStat, openedStat)) throw invalidPath();

    // Re-resolve the caller's path after opening. Together with the inode check
    // this detects both leaf replacement and parent-directory substitution.
    let resolvedAfterOpen: string;
    try {
      resolvedAfterOpen = await fs.realpath(candidatePath);
    } catch {
      throw invalidPath();
    }
    if (resolvedAfterOpen !== realPath) throw invalidPath();
    if (!roots.some((root) => isPathInsideDirectory(root, resolvedAfterOpen))) throw invalidPath();

    await secureDownloadHook?.("after-open", { candidatePath, realPath });

    const finalStat = await handle.stat();
    if (!sameIdentity(openedStat, finalStat)) throw invalidPath();
    return { handle, realPath, size: Number(finalStat.size) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertSecureDownloadPath(filePath: string, allowedRoots: readonly string[]): Promise<string> {
  const opened = await openSecureDownloadPath(filePath, allowedRoots);
  await opened.handle.close();
  return opened.realPath;
}

export async function sendSecureStoredFile(
  res: Response,
  options: {
    filePath: string;
    allowedRoots: readonly string[];
    filename: string;
    mimeType?: string | null;
    download?: boolean;
    expectedSha256?: string;
    integrityError?: Readonly<{ status: number; code: string; message: string }>;
  }
): Promise<void> {
  const opened = await openSecureDownloadPath(options.filePath, options.allowedRoots);
  let stream: ReturnType<typeof createReadStream> | null = null;
  try {
    if (options.expectedSha256) {
      const hash = createHash("sha256");
      if (opened.size > 0) {
        const verifier = createReadStream(opened.realPath, {
          fd: opened.handle.fd,
          autoClose: false,
          start: 0,
          end: opened.size - 1,
        });
        for await (const chunk of verifier) hash.update(chunk as Buffer);
      }
      if (hash.digest("hex") !== options.expectedSha256.toLowerCase()) {
        const failure = options.integrityError ?? {
          status: 503,
          code: "DOCUMENT_INTEGRITY_ERROR",
          message: "L’intégrité du document ne peut pas être confirmée.",
        };
        throw new HttpError(failure.status, failure.code, failure.message);
      }
    }

    setSecureDownloadHeaders(res, options);
    res.setHeader("Content-Length", String(opened.size));
    if (opened.size === 0) {
      res.end();
      return;
    }

    stream = createReadStream(opened.realPath, {
      fd: opened.handle.fd,
      autoClose: false,
      start: 0,
      end: opened.size - 1,
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.off("finish", finish);
        res.off("close", close);
        stream?.off("error", fail);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const close = () => {
        stream?.destroy();
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      res.once("finish", finish);
      res.once("close", close);
      stream?.once("error", fail);
      stream?.pipe(res);
    });
  } finally {
    stream?.destroy();
    await opened.handle.close().catch(() => undefined);
  }
}
