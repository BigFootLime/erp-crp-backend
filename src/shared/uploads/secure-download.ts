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

type SecureDownloadHookPhase = "after-validation" | "after-open" | "during-integrity" | "before-stream";
type SecureDownloadHook = (
  phase: SecureDownloadHookPhase,
  context: Readonly<{
    candidatePath: string;
    realPath: string;
    response?: Response;
    fileHandle?: FileHandle;
  }>
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

    await secureDownloadHook?.("after-open", { candidatePath, realPath, fileHandle: handle });

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

export type SecureStoredFileSendOutcome = "completed" | "aborted";

export async function sendSecureStoredFile(
  res: Response,
  options: {
    filePath: string;
    allowedRoots: readonly string[];
    filename: string;
    mimeType?: string | null;
    download?: boolean;
    expectedSha256?: string;
    /**
     * Read verified bytes into memory and send that immutable snapshot. This is
     * deliberately opt-in: regular document downloads retain their streaming
     * behaviour, while small high-sensitivity assets can close the in-place
     * write window between hashing an fd and piping it to the response.
     */
    snapshotVerifiedBytes?: boolean;
    /** Maximum accepted snapshot size, required when snapshotting is enabled. */
    maxSnapshotBytes?: number;
    integrityError?: Readonly<{ status: number; code: string; message: string }>;
  }
): Promise<SecureStoredFileSendOutcome> {
  let opened: SecureOpenedFile | null = null;
  let stream: ReturnType<typeof createReadStream> | null = null;
  let responseClosed = res.destroyed;
  let settleStreaming: ((outcome: SecureStoredFileSendOutcome) => void) | null = null;
  let closeHandlePromise: Promise<void> | null = null;
  let verifiedSnapshot: Buffer | null = null;

  const closeHandleOnce = (): Promise<void> => {
    if (!opened) return Promise.resolve();
    if (!closeHandlePromise) {
      closeHandlePromise = opened.handle.close().catch(() => undefined);
    }
    return closeHandlePromise;
  };

  const onResponseClose = () => {
    responseClosed = true;
    stream?.destroy();
    settleStreaming?.("aborted");
    void closeHandleOnce();
  };

  // Arm cancellation before path validation/opening and, crucially, before
  // the potentially long integrity pass.
  res.once("close", onResponseClose);
  try {
    const integrityFailure = () => options.integrityError ?? {
      status: 503,
      code: "DOCUMENT_INTEGRITY_ERROR",
      message: "L’intégrité du document ne peut pas être confirmée.",
    };
    // A snapshot without a full expected digest would silently fall back to a
    // mutable stream. Reject it before opening or allocating anything.
    if (options.snapshotVerifiedBytes && (
      typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedSha256)
    )) {
      const failure = integrityFailure();
      throw new HttpError(failure.status, failure.code, failure.message);
    }
    if (responseClosed || res.destroyed) return "aborted";
    opened = await openSecureDownloadPath(options.filePath, options.allowedRoots);
    if (responseClosed || res.destroyed) return "aborted";

    if (options.expectedSha256) {
      if (options.snapshotVerifiedBytes && (
        !Number.isSafeInteger(options.maxSnapshotBytes)
        || (options.maxSnapshotBytes ?? 0) < 0
        || opened.size > (options.maxSnapshotBytes ?? 0)
      )) {
        const failure = integrityFailure();
        throw new HttpError(failure.status, failure.code, failure.message);
      }
      const hash = createHash("sha256");
      if (opened.size > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, opened.size));
        const snapshot = options.snapshotVerifiedBytes ? Buffer.allocUnsafe(opened.size) : null;
        let offset = 0;
        let integrityHookCalled = false;
        while (offset < opened.size) {
          if (responseClosed || res.destroyed) return "aborted";
          const requested = Math.min(buffer.length, opened.size - offset);
          const { bytesRead } = await opened.handle.read(buffer, 0, requested, offset);
          if (bytesRead === 0) {
            const failure = integrityFailure();
            throw new HttpError(failure.status, failure.code, failure.message);
          }
          hash.update(buffer.subarray(0, bytesRead));
          if (snapshot) buffer.copy(snapshot, offset, 0, bytesRead);
          offset += bytesRead;
          if (!integrityHookCalled && secureDownloadHook) {
            integrityHookCalled = true;
            await secureDownloadHook("during-integrity", {
              candidatePath: path.resolve(options.filePath),
              realPath: opened.realPath,
              response: res,
            });
            if (responseClosed || res.destroyed) return "aborted";
          }
        }
        verifiedSnapshot = snapshot;
      }
      if (responseClosed || res.destroyed) return "aborted";
      if (hash.digest("hex") !== options.expectedSha256.toLowerCase()) {
        const failure = integrityFailure();
        throw new HttpError(failure.status, failure.code, failure.message);
      }
      if (options.snapshotVerifiedBytes && opened.size === 0) verifiedSnapshot = Buffer.alloc(0);
    }

    await secureDownloadHook?.("before-stream", {
      candidatePath: path.resolve(options.filePath),
      realPath: opened.realPath,
      response: res,
    });
    if (responseClosed || res.destroyed) return "aborted";

    setSecureDownloadHeaders(res, options);
    res.setHeader("Content-Length", String(verifiedSnapshot?.length ?? opened.size));
    if (responseClosed || res.destroyed) return "aborted";
    if (verifiedSnapshot || opened.size === 0) {
      return await new Promise<SecureStoredFileSendOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: SecureStoredFileSendOutcome) => {
          if (settled) return;
          settled = true;
          res.off("finish", finish);
          res.off("close", close);
          resolve(outcome);
        };
        const finish = () => settle("completed");
        const close = () => settle(res.writableFinished ? "completed" : "aborted");
        res.once("finish", finish);
        res.once("close", close);
        res.end(verifiedSnapshot ?? undefined);
      });
    }

    stream = createReadStream(opened.realPath, {
      fd: opened.handle.fd,
      autoClose: false,
      start: 0,
      end: opened.size - 1,
    });

    return await new Promise<SecureStoredFileSendOutcome>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        res.off("finish", finish);
        stream?.off("error", fail);
        settleStreaming = null;
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const finish = () => {
        settle(() => resolve("completed"));
      };
      const fail = (error: Error) => {
        settle(() => reject(error));
      };
      settleStreaming = (outcome) => settle(() => resolve(outcome));
      res.once("finish", finish);
      stream?.once("error", fail);
      if (responseClosed || res.destroyed) {
        settleStreaming("aborted");
        return;
      }
      stream?.pipe(res);
    });
  } finally {
    res.off("close", onResponseClose);
    stream?.destroy();
    await closeHandleOnce();
  }
}
