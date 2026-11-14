import { describe, expect, it, vi } from "vitest"
import path from "node:path"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  storagePath: vi.fn(),
}))

vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }))
vi.mock("../../../utils/cerpStorage", () => ({ ensureDocumentStoragePath: mocks.storagePath }))
vi.mock("node:fs/promises", () => ({
  default: { mkdir: mocks.mkdir, readdir: mocks.readdir, stat: mocks.stat },
}))

import {
  repoFindDocumentFilePath,
  repoGetDocumentName,
  repoIsLivraisonDocumentLinked,
} from "./delivery-document-reads.repository"

describe("delivery document read owner", () => {
  it("keeps blank document names absent and preserves the metadata query", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ document_name: "  " }] })
    await expect(repoGetDocumentName("document-1")).resolves.toBeNull()
    expect(mocks.query).toHaveBeenCalledWith(
      "SELECT document_name FROM documents_clients WHERE id = $1",
      ["document-1"]
    )
  })

  it("prefers the durable PDF path without enumerating storage", async () => {
    mocks.storagePath.mockReturnValueOnce("C:/delivery-documents")
    mocks.mkdir.mockResolvedValueOnce(undefined)
    mocks.stat.mockResolvedValueOnce({ isFile: () => true })
    await expect(repoFindDocumentFilePath("document-2")).resolves.toBe(path.join("C:/delivery-documents", "document-2.pdf"))
    expect(mocks.readdir).not.toHaveBeenCalled()
  })

  it("falls back to the extension-safe stored attachment and hides missing files", async () => {
    mocks.storagePath.mockReturnValue("C:/delivery-documents")
    mocks.mkdir.mockResolvedValue(undefined)
    mocks.stat.mockRejectedValueOnce(new Error("not pdf")).mockRejectedValueOnce(new Error("gone"))
    mocks.readdir.mockResolvedValueOnce(["document-3.png"])
    await expect(repoFindDocumentFilePath("document-3")).resolves.toBeNull()

    mocks.stat.mockRejectedValueOnce(new Error("not pdf")).mockResolvedValueOnce({ isFile: () => true })
    mocks.readdir.mockResolvedValueOnce(["document-3.png"])
    await expect(repoFindDocumentFilePath("document-3")).resolves.toBe(path.join("C:/delivery-documents", "document-3.png"))
  })

  it("keeps linkage scoped to both delivery and document identifiers", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1 })
    await expect(repoIsLivraisonDocumentLinked("delivery-1", "document-4")).resolves.toBe(true)
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("bon_livraison_id = $1::uuid"), ["delivery-1", "document-4"])
  })
})
