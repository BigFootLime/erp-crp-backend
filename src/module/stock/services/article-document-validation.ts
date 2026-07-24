import fs from "node:fs/promises";
import path from "node:path";

import { HttpError } from "../../../utils/httpError";

const MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip", "application/octet-stream"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip", "application/octet-stream"],
  ".txt": ["text/plain", "application/octet-stream"],
  ".csv": ["text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"],
  ".dxf": ["application/dxf", "image/vnd.dxf", "text/plain", "application/octet-stream"],
  ".step": ["application/step", "model/step", "text/plain", "application/octet-stream"],
  ".stp": ["application/step", "model/step", "text/plain", "application/octet-stream"],
};

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function signatureMatches(ext: string, bytes: Buffer): boolean {
  if (ext === ".pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (ext === ".png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === ".jpg" || ext === ".jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (ext === ".docx" || ext === ".xlsx" || ext === ".pptx") return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);

  if ([".txt", ".csv", ".dxf", ".step", ".stp"].includes(ext)) {
    return !bytes.includes(0x00);
  }
  return false;
}

async function readPrefix(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(512);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function validateArticleDocuments(files: Express.Multer.File[]): Promise<void> {
  if (files.length === 0) throw new HttpError(400, "ARTICLE_DOCUMENT_REQUIRED", "At least one document is required.");
  if (files.length > 10) throw new HttpError(400, "ARTICLE_DOCUMENT_LIMIT", "At most 10 documents may be uploaded at once.");

  for (const file of files) {
    if (!file.size) throw new HttpError(400, "ARTICLE_DOCUMENT_EMPTY", `Document ${file.originalname} is empty.`);
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = MIME_BY_EXTENSION[ext];
    if (!allowedMimes) {
      throw new HttpError(415, "ARTICLE_DOCUMENT_EXTENSION_UNSUPPORTED", `Document extension ${ext || "(none)"} is not allowed.`);
    }
    if (!allowedMimes.includes(file.mimetype.toLowerCase())) {
      throw new HttpError(415, "ARTICLE_DOCUMENT_MIME_MISMATCH", `Document ${file.originalname} has an unexpected MIME type.`);
    }
    const prefix = await readPrefix(file.path);
    if (!signatureMatches(ext, prefix)) {
      throw new HttpError(415, "ARTICLE_DOCUMENT_SIGNATURE_MISMATCH", `Document ${file.originalname} does not match its declared format.`);
    }
  }
}

export async function removeTemporaryArticleDocuments(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
}
