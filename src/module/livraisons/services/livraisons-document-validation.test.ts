import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  removeTemporaryLivraisonDocuments,
  validateLivraisonDocuments,
} from "./livraisons-document-validation"

const temporaryDirectories: string[] = []

async function fileFixture(
  originalname: string,
  mimetype: string,
  bytes: Buffer
): Promise<Express.Multer.File> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-livraison-doc-"))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, "upload")
  await fs.writeFile(filePath, bytes)
  return {
    fieldname: "documents",
    originalname,
    encoding: "7bit",
    mimetype,
    destination: directory,
    filename: "upload",
    path: filePath,
    size: bytes.length,
    stream: undefined as never,
    buffer: bytes,
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
})

describe("validation des documents Livraison #226", () => {
  it("accepte un PDF dont extension, MIME et signature concordent", async () => {
    const file = await fileFixture(
      "preuve.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7\npreuve synthétique")
    )

    await expect(validateLivraisonDocuments([file])).resolves.toBeUndefined()
  })

  it("refuse une extension non autorisée", async () => {
    const file = await fileFixture(
      "preuve.exe",
      "application/octet-stream",
      Buffer.from("MZ")
    )

    await expect(validateLivraisonDocuments([file])).rejects.toMatchObject({
      status: 415,
      code: "LIVRAISON_DOCUMENT_EXTENSION_UNSUPPORTED",
    })
  })

  it("refuse un MIME incohérent avec l'extension", async () => {
    const file = await fileFixture(
      "preuve.pdf",
      "image/png",
      Buffer.from("%PDF-1.7")
    )

    await expect(validateLivraisonDocuments([file])).rejects.toMatchObject({
      status: 415,
      code: "LIVRAISON_DOCUMENT_MIME_MISMATCH",
    })
  })

  it("refuse une signature binaire incohérente", async () => {
    const file = await fileFixture(
      "preuve.pdf",
      "application/pdf",
      Buffer.from("faux document")
    )

    await expect(validateLivraisonDocuments([file])).rejects.toMatchObject({
      status: 415,
      code: "LIVRAISON_DOCUMENT_SIGNATURE_MISMATCH",
    })
  })

  it("refuse les lots de plus de dix documents", async () => {
    const file = await fileFixture(
      "preuve.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7")
    )

    await expect(
      validateLivraisonDocuments(Array.from({ length: 11 }, () => file))
    ).rejects.toMatchObject({
      status: 400,
      code: "LIVRAISON_DOCUMENT_LIMIT",
    })
  })

  it("refuse un fichier vide", async () => {
    const file = await fileFixture("vide.txt", "text/plain", Buffer.alloc(0))

    await expect(validateLivraisonDocuments([file])).rejects.toMatchObject({
      status: 400,
      code: "LIVRAISON_DOCUMENT_EMPTY",
    })
  })

  it("supprime le fichier temporaire après traitement", async () => {
    const file = await fileFixture(
      "preuve.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7")
    )

    await removeTemporaryLivraisonDocuments([file])

    await expect(fs.stat(file.path)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
