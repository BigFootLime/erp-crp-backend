import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import request from "supertest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const lotId = "11111111-1111-1111-1111-111111111111"
const docId = "22222222-2222-2222-2222-222222222222"

// Mocks must be defined before importing app
vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}))

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Administrateur Systeme et Reseau" }
    next()
  },
  authorizeRole: (..._roles: string[]) => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock("../module/traceability/services/traceability.service", () => ({
  svcGetTraceabilityChain: vi.fn(async () => ({
    seed: { type: "lot", id: lotId },
    nodes: [{ node_id: `lot:${lotId}`, type: "lot", id: lotId, label: "Lot TEST", meta: null }],
    edges: [],
    highlights: [],
    truncated: { maxDepthReached: false, maxNodesReached: false, maxEdgesReached: false },
  })),
}))

let tmpPdfPath: string | null = null

vi.mock("../module/asbuilt/services/asbuilt.service", () => ({
  svcGetAsbuiltPreview: vi.fn(async () => ({
    lot: {
      id: lotId,
      article_id: "33333333-3333-3333-3333-333333333333",
      article_code: "ART-001",
      article_designation: "Article test",
      lot_code: "LOT-TEST",
      supplier_lot_code: null,
      received_at: null,
      manufactured_at: null,
      expiry_at: null,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    ofs: [],
    bon_livraisons: [],
    non_conformities: [],
    pack_versions: [],
    checks: {
      open_non_conformities: 0,
      overdue_non_conformities: 0,
      has_of_link: false,
      has_shipping_link: false,
    },
  })),
  svcGenerateAsbuiltPack: vi.fn(async () => ({
    asbuilt_version_id: "44444444-4444-4444-4444-444444444444",
    version: 1,
    pdf_document_id: docId,
  })),
  svcResolveAsbuiltDocument: vi.fn(async () => ({
    filePath: tmpPdfPath,
    name: "DOSSIER_LOT_TEST_V1.pdf",
  })),
}))

import app from "../config/app"

describe("🧪 Routes Traceabilite + As-built (/traceability, /asbuilt)", () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asbuilt-"))
    tmpPdfPath = path.join(dir, "fake.pdf")
    await fs.writeFile(tmpPdfPath, Buffer.from("%PDF-1.4\n%fake\n"))
  })

  afterAll(async () => {
    if (tmpPdfPath) {
      const dir = path.dirname(tmpPdfPath)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("✅ GET /api/v1/traceability/chain retourne 200", async () => {
    const res = await request(app).get(`/api/v1/traceability/chain?type=lot&id=${lotId}`)
    expect(res.status).toBe(200)
    expect(res.body?.seed?.type).toBe("lot")
  })

  it("✅ GET /api/v1/asbuilt/lots/:lotId/preview retourne 200", async () => {
    const res = await request(app).get(`/api/v1/asbuilt/lots/${lotId}/preview`)
    expect(res.status).toBe(200)
    expect(res.body?.lot?.id).toBe(lotId)
  })

  it("✅ POST /api/v1/asbuilt/lots/:lotId/generate retourne 201", async () => {
    const res = await request(app)
      .post(`/api/v1/asbuilt/lots/${lotId}/generate`)
      .send({ signataire_user_id: 1, commentaire: "OK" })
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty("pdf_document_id")
  })

  it("✅ GET /api/v1/asbuilt/lots/:lotId/download/:documentId retourne 200", async () => {
    const res = await request(app).get(`/api/v1/asbuilt/lots/${lotId}/download/${docId}`)
    expect(res.status).toBe(200)
    expect(String(res.headers["content-type"] ?? "")).toContain("application/pdf")
  })
})
