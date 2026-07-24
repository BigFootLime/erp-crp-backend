import fs from "node:fs/promises"
import path from "node:path"

import { HttpError } from "../../../utils/httpError"

const MAX_DOCUMENTS = 10
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
  ],
  ".xlsx": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip",
    "application/octet-stream",
  ],
  ".txt": ["text/plain", "application/octet-stream"],
  ".csv": ["text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"],
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function signatureMatches(extension: string, bytes: Buffer): boolean {
  if (extension === ".pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  if (extension === ".png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff])
  }
  if (extension === ".docx" || extension === ".xlsx") {
    return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  }
  if (extension === ".txt" || extension === ".csv") return !bytes.includes(0x00)
  return false
}

async function readPrefix(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r")
  try {
    const bytes = Buffer.alloc(512)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    return bytes.subarray(0, read.bytesRead)
  } finally {
    await handle.close()
  }
}

export async function validateLivraisonDocuments(
  files: Express.Multer.File[]
): Promise<void> {
  if (!files.length) {
    throw new HttpError(400, "LIVRAISON_DOCUMENT_REQUIRED", "Ajoutez au moins un document.")
  }
  if (files.length > MAX_DOCUMENTS) {
    throw new HttpError(
      400,
      "LIVRAISON_DOCUMENT_LIMIT",
      `Au maximum ${MAX_DOCUMENTS} documents peuvent être ajoutés à la fois.`
    )
  }

  for (const file of files) {
    if (!file.size) {
      throw new HttpError(400, "LIVRAISON_DOCUMENT_EMPTY", "Un document est vide.")
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new HttpError(
        413,
        "LIVRAISON_DOCUMENT_TOO_LARGE",
        "Un document dépasse la taille maximale de 20 Mo."
      )
    }
    const extension = path.extname(file.originalname).toLowerCase()
    const allowedMimes = MIME_BY_EXTENSION[extension]
    if (!allowedMimes) {
      throw new HttpError(
        415,
        "LIVRAISON_DOCUMENT_EXTENSION_UNSUPPORTED",
        "Le format du document n’est pas autorisé."
      )
    }
    if (!allowedMimes.includes(file.mimetype.toLowerCase())) {
      throw new HttpError(
        415,
        "LIVRAISON_DOCUMENT_MIME_MISMATCH",
        "Le type MIME du document ne correspond pas à son extension."
      )
    }
    if (!signatureMatches(extension, await readPrefix(file.path))) {
      throw new HttpError(
        415,
        "LIVRAISON_DOCUMENT_SIGNATURE_MISMATCH",
        "La signature binaire du document ne correspond pas au format déclaré."
      )
    }
  }
}

export async function removeTemporaryLivraisonDocuments(
  files: Express.Multer.File[]
): Promise<void> {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)))
}
