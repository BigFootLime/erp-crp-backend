import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { HttpError } from "../../utils/httpError";

const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".txt", ".csv",
  ".doc", ".docx", ".xls", ".xlsx", ".odt", ".ods", ".stp", ".step", ".stl",
]);

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
  "text/plain", "text/csv", "application/vnd.ms-excel", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
  "model/step", "model/stl", "application/step", "application/sla", "application/octet-stream",
]);

export function safeDocumentExtension(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]+$/.test(extension) && extension.length <= 10 ? extension : "";
}

export function toPosixStoragePath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export async function sha256DocumentFile(filePath: string): Promise<string> {
  const crypto = await import("node:crypto");
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function hasExpectedMagicBytes(filePath: string, extension: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    const head = buffer.subarray(0, bytesRead);
    const startsWith = (signature: number[]) => signature.every((byte, index) => head[index] === byte);
    switch (extension) {
      case ".pdf": return head.subarray(0, 5).toString("latin1") === "%PDF-";
      case ".png": return startsWith([0x89, 0x50, 0x4e, 0x47]);
      case ".jpg":
      case ".jpeg": return startsWith([0xff, 0xd8, 0xff]);
      case ".gif": return head.subarray(0, 3).toString("latin1") === "GIF";
      case ".webp": return head.subarray(0, 4).toString("latin1") === "RIFF";
      case ".docx":
      case ".xlsx":
      case ".ods":
      case ".odt": return startsWith([0x50, 0x4b]);
      case ".doc":
      case ".xls": return startsWith([0xd0, 0xcf, 0x11, 0xe0]);
      default: return true;
    }
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export async function assertDocumentUploadAllowed(file: Express.Multer.File): Promise<string> {
  const extension = safeDocumentExtension(file.originalname);
  if (!extension || !ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new HttpError(400, "UNSUPPORTED_FILE_TYPE", `Extension de fichier non autorisee: ${file.originalname}`);
  }
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
    throw new HttpError(400, "UNSUPPORTED_MIME_TYPE", `Type MIME non autorise: ${file.mimetype}`);
  }
  if (!(await hasExpectedMagicBytes(file.path, extension))) {
    throw new HttpError(400, "FILE_SIGNATURE_MISMATCH", `La signature du fichier ne correspond pas a ${extension}`);
  }
  return extension;
}
