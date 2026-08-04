import fs from "node:fs/promises";
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

export async function assertSecureDownloadPath(filePath: string, allowedRoots: readonly string[]): Promise<string> {
  if (!allowedRoots.length) {
    throw new HttpError(500, "DOWNLOAD_ROOT_MISSING", "Le stockage documentaire n’est pas configuré.");
  }
  let realFile: string;
  try {
    realFile = await fs.realpath(path.resolve(filePath));
  } catch {
    throw new HttpError(404, "DOCUMENT_FILE_NOT_FOUND", "Le fichier demandé est introuvable.");
  }
  const roots = await Promise.all(allowedRoots.map(realExistingDirectory));
  if (!roots.some((root) => isPathInsideDirectory(root, realFile))) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Le chemin de stockage du document est invalide.");
  }
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) {
    throw new HttpError(404, "DOCUMENT_FILE_NOT_FOUND", "Le fichier demandé est introuvable.");
  }
  return realFile;
}

export async function sendSecureStoredFile(
  res: Response,
  options: {
    filePath: string;
    allowedRoots: readonly string[];
    filename: string;
    mimeType?: string | null;
    download?: boolean;
  }
): Promise<void> {
  const realFile = await assertSecureDownloadPath(options.filePath, options.allowedRoots);
  setSecureDownloadHeaders(res, options);
  await new Promise<void>((resolve, reject) => {
    res.sendFile(realFile, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
