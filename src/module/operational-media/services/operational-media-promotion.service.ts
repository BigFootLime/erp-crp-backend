import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";

import { getImagesRootPath, normalizeStoredImagePath } from "../../../utils/imageStorage";
import { HttpError } from "../../../utils/httpError";

export type OperationalMediaPromotion =
  | { activated: true; asset_id: string; mime_type: OperationalRasterVerification["mimeType"] }
  | { activated: false; reason: "scanner_unavailable" | "scanner_infected" | "verification_required" };

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
};
const MAX_OPERATIONAL_MEDIA_BYTES = 25 * 1024 * 1024;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameIdentity(a: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>, b: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>): boolean {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino) && String(a.size) === String(b.size);
}

function signatureMime(head: Uint8Array): string | null {
  if (head.length >= 5 && String.fromCharCode(...head.subarray(0, 5)) === "%PDF-") return "application/pdf";
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 12 && String.fromCharCode(...head.subarray(0, 4)) === "RIFF" && String.fromCharCode(...head.subarray(8, 12)) === "WEBP") return "image/webp";
  if (head.length >= 6 && (String.fromCharCode(...head.subarray(0, 6)) === "GIF87a" || String.fromCharCode(...head.subarray(0, 6)) === "GIF89a")) return "image/gif";
  return null;
}

async function hashOpened(handle: Awaited<ReturnType<typeof fs.open>>, size: number, includeBytes: boolean) {
  const hash = createHash("sha256");
  const head = new Uint8Array(Math.min(size, 16));
  const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 64 * 1024));
  const chunks: Buffer[] | null = includeBytes ? [] : null;
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead <= 0) throw new Error("MEDIA_DURABLE_FILE_SHORT_READ");
    if (offset < head.length) head.set(buffer.subarray(0, Math.min(bytesRead, head.length - offset)), offset);
    hash.update(buffer.subarray(0, bytesRead));
    chunks?.push(Buffer.from(buffer.subarray(0, bytesRead)));
    offset += bytesRead;
  }
  return { sha256: hash.digest("hex"), head, bytes: chunks ? Buffer.concat(chunks, size) : undefined };
}

export type OperationalRasterVerification = Readonly<{
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf";
  size: number;
  sha256: string;
  filePath: string;
  /** Exact bytes hashed from the already-opened inode, only when requested. */
  bytes?: Buffer;
}>;

/**
 * Opens the durable object with containment and inode checks, then derives its
 * bytes-only identity. Callers may omit expected values for legacy recovery;
 * they must still apply an independent scanner verdict before activation.
 */
export async function verifyOperationalRaster(params: {
  root: string;
  storageKey: string;
  expectedHash?: string;
  expectedSize?: number;
  includeBytes?: boolean;
}): Promise<OperationalRasterVerification | null> {
  const { root, storageKey: key, expectedHash, expectedSize, includeBytes = false } = params;
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(rootPath, key);
  if (!inside(rootPath, candidatePath)) throw new HttpError(400, "MEDIA_INVALID_STORAGE_KEY", "Clé média invalide.");
  try {
    const rootReal = await fs.realpath(rootPath);
    const before = await fs.lstat(candidatePath, { bigint: true });
    const beforeSize = Number(before.size);
    if (before.isSymbolicLink() || !before.isFile() || beforeSize <= 0 || beforeSize > MAX_OPERATIONAL_MEDIA_BYTES || (expectedSize !== undefined && beforeSize !== expectedSize)) return null;
    const realPath = await fs.realpath(candidatePath);
    if (!inside(rootReal, realPath)) return null;
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await fs.open(realPath, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened) || (expectedSize !== undefined && Number(opened.size) !== expectedSize)) return null;
      if (await fs.realpath(rootPath) !== rootReal || await fs.realpath(candidatePath) !== realPath) return null;
      const after = await fs.lstat(realPath, { bigint: true });
      if (after.isSymbolicLink() || !sameIdentity(opened, after)) return null;
      const actual = await hashOpened(handle, Number(opened.size), includeBytes);
      const mimeType = signatureMime(actual.head);
      if (!mimeType || MIME_BY_EXTENSION[path.extname(key).toLowerCase()] !== mimeType || (expectedHash !== undefined && actual.sha256 !== expectedHash.toLowerCase())) return null;
      const finalStat = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, finalStat)) return null;
      return { mimeType: mimeType as OperationalRasterVerification["mimeType"], size: Number(finalStat.size), sha256: actual.sha256, filePath: realPath, ...(actual.bytes ? { bytes: actual.bytes } : {}) };
    } finally { await handle.close().catch(() => undefined); }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return null;
  }
}

/** Promotes only a clean, durable, byte-verified raster into the asset registry. */
export async function promoteOperationalImage(params: { tx: Pick<PoolClient, "query">; storedPath: string; file: Express.Multer.File }): Promise<OperationalMediaPromotion> {
  const key = normalizeStoredImagePath(params.storedPath);
  if (!key || /^https?:\/\//i.test(key) || key.includes(":")) throw new HttpError(400, "MEDIA_INVALID_STORAGE_KEY", "Clé média invalide.");
  const security = params.file.uploadSecurity;
  // No FS/DB work for a non-clean scanner verdict.
  if (security?.scanStatus === "unavailable" || security?.scanStatus === "pending") return { activated: false, reason: "scanner_unavailable" };
  if (security?.scanStatus === "infected") return { activated: false, reason: "scanner_infected" };
  if (security?.scanStatus !== "clean" || !/^[a-f0-9]{64}$/i.test(security.sha256) || !Number.isSafeInteger(params.file.size) || params.file.size <= 0) return { activated: false, reason: "verification_required" };
  const verified = await verifyOperationalRaster({ root: getImagesRootPath(), storageKey: key, expectedHash: security.sha256, expectedSize: params.file.size });
  if (!verified) return { activated: false, reason: "verification_required" };
  const result = await params.tx.query<{ id: string }>(
    `UPDATE public.operational_media_assets
       SET mime_type=$2, size_bytes=$3, sha256=$4, scan_status='CLEAN', status='ACTIVE'
     WHERE storage_key=$1 AND status = 'LEGACY_UNVERIFIED'
     RETURNING id::text AS id`,
    [key, verified.mimeType, verified.size, verified.sha256]
  );
  return result.rows[0]
    ? { activated: true, asset_id: result.rows[0].id, mime_type: verified.mimeType }
    : { activated: false, reason: "verification_required" };
}
