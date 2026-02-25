#!/usr/bin/env node
/* eslint-disable no-console */

// Operation dossiers smoke test (integration):
// - Lazy create dossier header for an operation
// - Create version 1 with 2 docs
// - Create version 2 by replacing one slot (copy-forward others)
// - Download an older version document
//
// Usage: node scripts/operation-dossiers-smoke.js

process.env.NODE_ENV = process.env.NODE_ENV ?? "development"
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/erp-database"
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret"

const http = require("http")
const crypto = require("crypto")
const jwt = require("jsonwebtoken")
const { Client } = require("pg")

const appMod = require("../dist/config/app")
const app = appMod.default ?? appMod

async function asJson(res) {
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) return await res.json()
  return await res.text()
}

async function asBuffer(res) {
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function findSlot(version, slotKey) {
  const docs = version?.documents ?? []
  return docs.find((d) => d.slot_key === slotKey) ?? null
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()

  try {
    const reg = (await pg.query("SELECT to_regclass('public.operation_dossiers') AS reg")).rows[0]?.reg
    assert(reg, "Missing DB patch: public.operation_dossiers")

    const userIdRaw = (await pg.query("SELECT id FROM public.users ORDER BY id LIMIT 1")).rows[0]?.id
    const userId = Number(userIdRaw)
    assert(Number.isFinite(userId), "Missing seed user")

    const server = http.createServer(app)
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve())))

    try {
      const port = server.address().port
      const base = `http://127.0.0.1:${port}`
      const token = jwt.sign(
        { id: userId, username: "smoke", email: "smoke@example.test", role: "Administrateur Systeme et Reseau" },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
      )
      const hAuth = { Authorization: `Bearer ${token}` }

      const opId = `SMOKE-OP-${crypto.randomUUID().slice(0, 8)}`

      const opUrl = `${base}/api/v1/dossiers/operation?operation_type=PIECE_TECHNIQUE_OPERATION&operation_id=${encodeURIComponent(
        opId
      )}&dossier_type=TECHNIQUE`
      const get0 = await fetch(opUrl, { headers: hAuth })
      const get0Body = await asJson(get0)
      assert(get0.ok, `GET dossier (0) failed ${get0.status}: ${JSON.stringify(get0Body)}`)
      const dossierId = get0Body?.dossier?.id
      assert(typeof dossierId === "string", "Missing dossier.id")

      // Create version 1 with 2 docs (DOC_01 + DOC_02)
      const fd1 = new FormData()
      fd1.append("commentaire", `Smoke v1 ${opId}`)
      fd1.append("docComment[DOC_01]", "Plan de fabrication")
      fd1.append("docComment[DOC_02]", "Contrôle")
      fd1.append("documents[DOC_01]", new Blob([Buffer.from(`DOC_01 ${opId} v1`)], { type: "text/plain" }), "doc01.txt")
      fd1.append("documents[DOC_02]", new Blob([Buffer.from(`DOC_02 ${opId} v1`)], { type: "text/plain" }), "doc02.txt")

      const post1 = await fetch(`${base}/api/v1/dossiers/${dossierId}/versions`, { method: "POST", headers: hAuth, body: fd1 })
      const post1Body = await asJson(post1)
      assert(post1.status === 201, `POST version1 failed ${post1.status}: ${JSON.stringify(post1Body)}`)
      assert(post1Body?.version === 1, `Expected version=1, got ${JSON.stringify(post1Body)}`)

      const get1 = await fetch(opUrl, { headers: hAuth })
      const get1Body = await asJson(get1)
      assert(get1.ok, `GET dossier (1) failed ${get1.status}: ${JSON.stringify(get1Body)}`)
      assert(get1Body?.latest?.version === 1, `Expected latest.version=1, got ${JSON.stringify(get1Body?.latest)}`)
      assert(Array.isArray(get1Body?.latest?.documents), "Missing latest.documents")
      assert(get1Body.latest.documents.length === 8, `Expected 8 slots, got ${get1Body.latest.documents.length}`)

      const v1Doc01 = findSlot(get1Body.latest, "DOC_01")
      const v1Doc02 = findSlot(get1Body.latest, "DOC_02")
      assert(v1Doc01?.document_id, "Missing DOC_01 document_id in v1")
      assert(v1Doc02?.document_id, "Missing DOC_02 document_id in v1")

      // Create version 2: only replace DOC_01
      const fd2 = new FormData()
      fd2.append("commentaire", `Smoke v2 ${opId}`)
      fd2.append("documents[DOC_01]", new Blob([Buffer.from(`DOC_01 ${opId} v2`)], { type: "text/plain" }), "doc01-v2.txt")

      const post2 = await fetch(`${base}/api/v1/dossiers/${dossierId}/versions`, { method: "POST", headers: hAuth, body: fd2 })
      const post2Body = await asJson(post2)
      assert(post2.status === 201, `POST version2 failed ${post2.status}: ${JSON.stringify(post2Body)}`)
      assert(post2Body?.version === 2, `Expected version=2, got ${JSON.stringify(post2Body)}`)

      const get2 = await fetch(opUrl, { headers: hAuth })
      const get2Body = await asJson(get2)
      assert(get2.ok, `GET dossier (2) failed ${get2.status}: ${JSON.stringify(get2Body)}`)
      assert(get2Body?.latest?.version === 2, `Expected latest.version=2, got ${JSON.stringify(get2Body?.latest)}`)

      const v2Doc01 = findSlot(get2Body.latest, "DOC_01")
      const v2Doc02 = findSlot(get2Body.latest, "DOC_02")
      assert(v2Doc01?.document_id, "Missing DOC_01 document_id in v2")
      assert(v2Doc02?.document_id, "Missing DOC_02 document_id in v2")
      assert(v2Doc01.document_id !== v1Doc01.document_id, "DOC_01 should have been replaced")
      assert(v2Doc02.document_id === v1Doc02.document_id, "DOC_02 should be copied forward")

      // Download an older doc
      const dl = await fetch(`${base}/api/v1/dossiers/documents/${v1Doc02.document_id}/download?download=1`, { headers: hAuth })
      if (!dl.ok) throw new Error(`Download failed ${dl.status}: ${JSON.stringify(await asJson(dl))}`)
      const buf = await asBuffer(dl)
      assert(buf.toString("utf8").includes(`DOC_02 ${opId} v1`), "Downloaded bytes mismatch")

      // DB verification
      const q1 = await pg.query("SELECT COUNT(*)::int AS n FROM public.operation_dossiers WHERE operation_id = $1", [opId])
      const q2 = await pg.query(
        "SELECT COUNT(*)::int AS n FROM public.operation_dossier_versions WHERE dossier_id = $1::uuid",
        [dossierId]
      )
      const q3 = await pg.query(
        "SELECT COUNT(*)::int AS n FROM public.operation_dossier_version_documents WHERE dossier_version_id IN (SELECT id FROM public.operation_dossier_versions WHERE dossier_id = $1::uuid)",
        [dossierId]
      )

      console.log(
        JSON.stringify(
          {
            dossierId,
            operation: { operation_type: "PIECE_TECHNIQUE_OPERATION", operation_id: opId, dossier_type: "TECHNIQUE" },
            version1: { doc01: v1Doc01.document_id, doc02: v1Doc02.document_id },
            version2: { doc01: v2Doc01.document_id, doc02: v2Doc02.document_id },
            counts: { dossiers: q1.rows[0]?.n, versions: q2.rows[0]?.n, docs: q3.rows[0]?.n },
          },
          null,
          2
        )
      )
    } finally {
      await new Promise((resolve) => server.close(() => resolve()))
    }
  } finally {
    await pg.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error("OP_DOSSIERS_SMOKE_FAIL", e && e.stack ? e.stack : String(e))
  process.exit(1)
})
