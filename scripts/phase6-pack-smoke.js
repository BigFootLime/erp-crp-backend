#!/usr/bin/env node
/* eslint-disable no-console */

// Phase 6 smoke test (integration): BL pack preview/generate/download/versioning.
// Usage: node scripts/phase6-pack-smoke.js

process.env.NODE_ENV = process.env.NODE_ENV ?? "development"
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/erp-database"
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret"

const http = require("http")
const crypto = require("crypto")

const jwt = require("jsonwebtoken")
const { Client } = require("pg")

const appMod = require("../dist/config/app")
const app = appMod.default ?? appMod
const stockRepo = require("../dist/module/stock/repository/stock.repository")
const { svcRenderPackBonLivraisonPdf, svcRenderPackCofcPdf } = require("../dist/module/livraisons/services/pack-pdf.service")

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

function sha256(buffers) {
  const h = crypto.createHash("sha256")
  for (const b of buffers) h.update(b)
  return h.digest("hex")
}

async function getUserLabel(pg, userId) {
  const row = (await pg.query("SELECT username, name, surname FROM public.users WHERE id = $1", [userId])).rows[0] ?? null
  if (!row) throw new Error("Missing user")
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null
  const surname = typeof row.surname === "string" && row.surname.trim() ? row.surname.trim() : null
  if (name && surname) return `${name} ${surname}`
  return row.username
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()

  try {
    const reg = (await pg.query("SELECT to_regclass('public.bon_livraison_pack_versions') AS reg"))
      .rows[0]?.reg
    assert(reg, "Missing DB patch: public.bon_livraison_pack_versions")

    const suf = crypto.randomUUID().slice(0, 8)

    const clientId = (await pg.query("SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1")).rows[0]?.client_id
    const userIdRaw = (await pg.query("SELECT id FROM public.users ORDER BY id LIMIT 1")).rows[0]?.id
    const userId = Number(userIdRaw)
    assert(clientId, "Missing seed client")
    assert(Number.isFinite(userId), "Missing seed user")

    // Seed warehouse/location/magasin/emplacement (with mapping: emplacement.location_id -> location.warehouse_id)
    const warehouseId = (
      await pg.query(
        "INSERT INTO public.warehouses (id, code, name, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id::text AS id",
        [`SMOKE6-WH-${suf}`, `Smoke6 WH ${suf}`]
      )
    ).rows[0]?.id

    const locationId = (
      await pg.query(
        "INSERT INTO public.locations (id, warehouse_id, code, description, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2, $3, now(), now()) RETURNING id::text AS id",
        [warehouseId, `SMOKE6-LOC-${suf}`, `Smoke6 loc ${suf}`]
      )
    ).rows[0]?.id

    const magasinCode = `SMOKE6-${suf}`
    const magasinId = (
      await pg.query(
        "INSERT INTO public.magasins (id, code_magasin, libelle, is_active, code, name, warehouse_id, created_by, updated_by) VALUES (gen_random_uuid(), $1::text, $2::text, true, $1::text, $2::text, $3::uuid, $4, $4) RETURNING id::text AS id",
        [magasinCode, `Smoke6 magasin ${suf}`, warehouseId, userId]
      )
    ).rows[0]?.id

    const emplacementId = (
      await pg.query(
        "INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, location_id, created_at, updated_at, created_by, updated_by) VALUES ($1::uuid, $2, $3, false, true, $4::uuid, now(), now(), $5, $5) RETURNING id::int AS id",
        [magasinId, `SMOKE6-EM-${suf}`, `Smoke6 emp ${suf}`, locationId, userId]
      )
    ).rows[0]?.id

    assert(warehouseId && locationId && magasinId && emplacementId, "Failed to seed stock location entities")

    // Configure deterministic shipping location
    await pg.query(
      "INSERT INTO public.erp_settings (key, value_json, created_by, updated_by) VALUES ($1, $2::jsonb, $3, $3) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now(), updated_by = EXCLUDED.updated_by",
      ["stock.default_shipping_location", JSON.stringify({ magasin_id: magasinId, emplacement_id: emplacementId }), userId]
    )

    // Seed article + lot
    const articleCode = `SMOKE6-PART-${suf}`
    const articleId = (
      await pg.query(
        "INSERT INTO public.articles (code, designation, article_type, unite, lot_tracking, is_active, created_at, updated_at, created_by, updated_by) VALUES ($1, $2, 'PURCHASED', 'u', true, true, now(), now(), $3, $3) RETURNING id::text AS id",
        [articleCode, `Smoke6 part ${suf}`, userId]
      )
    ).rows[0]?.id

    const lotCode = `LOT-${suf}`
    const lotId = (
      await pg.query(
        "INSERT INTO public.lots (article_id, lot_code, created_at, updated_at, created_by, updated_by) VALUES ($1::uuid, $2, now(), now(), $3, $3) RETURNING id::text AS id",
        [articleId, lotCode, userId]
      )
    ).rows[0]?.id

    assert(articleId && lotId, "Failed to seed article/lot")

    const audit = {
      user_id: userId,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      path: "/smoke6",
      page_key: "smoke6",
      client_session_id: null,
    }

    // Receipt stock: +10
    const inMov = await stockRepo.repoCreateMovement(
      {
        movement_type: "IN",
        effective_at: new Date().toISOString(),
        source_document_type: "SMOKE6",
        source_document_id: suf,
        reason_code: "SMOKE6_RECEIPT",
        notes: `Smoke6 receipt ${suf}`,
        idempotency_key: `smoke6:${suf}:in:${articleId}:${lotId}`,
        lines: [
          {
            line_no: 1,
            article_id: articleId,
            lot_id: lotId,
            qty: 10,
            unite: "u",
            dst_magasin_id: magasinId,
            dst_emplacement_id: emplacementId,
            note: "receipt",
          },
        ],
      },
      audit
    )
    await stockRepo.repoPostMovement(inMov.movement.id, audit)

    // Start API server
    const server = http.createServer(app)
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve())))

    try {
      const port = server.address().port
      const token = jwt.sign(
        { id: userId, username: "smoke", email: "smoke@example.test", role: "ADMIN" },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
      )

      const base = `http://127.0.0.1:${port}`
      const hJson = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      const hAuth = { Authorization: `Bearer ${token}` }

      // Create BL with one line
      const createRes = await fetch(`${base}/api/v1/livraisons`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({
          client_id: String(clientId),
          commentaire_interne: `smoke6 ${suf}`,
          lignes: [{ designation: `Smoke6 line ${suf}`, code_piece: "IGNORED", quantite: 3, unite: "u" }],
        }),
      })

      const createBody = await asJson(createRes)
      assert(createRes.status === 201, `create livraison ${createRes.status}: ${JSON.stringify(createBody)}`)
      const blId = createBody.id

      // Fetch detail to get line id
      const get1 = await fetch(`${base}/api/v1/livraisons/${blId}`, { headers: hAuth })
      const getBody1 = await asJson(get1)
      assert(get1.ok, `get livraison ${get1.status}: ${JSON.stringify(getBody1)}`)
      const lineId = getBody1?.lignes?.[0]?.id
      assert(typeof lineId === "string", `missing lineId: ${JSON.stringify(getBody1)}`)

      // DRAFT -> READY
      const readyRes = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ statut: "READY", commentaire: "smoke6" }),
      })
      assert(readyRes.ok, `READY ${readyRes.status}: ${JSON.stringify(await asJson(readyRes))}`)

      // Add allocation
      const allocRes = await fetch(`${base}/api/v1/livraisons/${blId}/lignes/${lineId}/allocations`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ article_id: articleId, lot_id: lotId, quantite: 3, unite: "u" }),
      })
      const allocBody = await asJson(allocRes)
      assert(allocRes.status === 201, `alloc ${allocRes.status}: ${JSON.stringify(allocBody)}`)

      // READY -> SHIPPED
      const shipRes = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ statut: "SHIPPED", commentaire: "smoke6" }),
      })
      assert(shipRes.ok, `SHIPPED ${shipRes.status}: ${JSON.stringify(await asJson(shipRes))}`)

      // Preview pack
      const prev1Res = await fetch(`${base}/api/v1/livraisons/${blId}/pack/preview`, { headers: hAuth })
      const prev1 = await asJson(prev1Res)
      assert(prev1Res.ok, `pack preview ${prev1Res.status}: ${JSON.stringify(prev1)}`)
      assert(prev1?.checks?.allocations_ok === true, `allocations_ok=false: ${JSON.stringify(prev1?.checks)}`)
      assert(prev1?.checks?.shipped_or_ready === true, `shipped_or_ready=false: ${JSON.stringify(prev1?.checks)}`)
      assert(prev1?.checks?.stock_link_ok === true, `stock_link_ok=false: ${JSON.stringify(prev1?.checks)}`)
      assert(Array.isArray(prev1?.stock_movements) && prev1.stock_movements.length > 0, "Missing stock_movements")

      // Generate pack
      const commentairePack = `Smoke6 dossier ${suf}`
      const genRes = await fetch(`${base}/api/v1/livraisons/${blId}/pack/generate`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ include_documents: true, commentaire_pack: commentairePack, signataire_user_id: userId }),
      })
      const genBody = await asJson(genRes)
      assert(genRes.status === 201, `pack generate ${genRes.status}: ${JSON.stringify(genBody)}`)

      const packVersionId = genBody.pack_version_id
      const version = genBody.version
      const blDocId = genBody.bl_document_id
      const cofcDocId = genBody.cofc_document_id
      assert(typeof packVersionId === "string", "Missing pack_version_id")
      assert(typeof version === "number" && Number.isInteger(version) && version > 0, "Missing/invalid version")
      assert(typeof blDocId === "string", "Missing bl_document_id")
      assert(typeof cofcDocId === "string", "Missing cofc_document_id")

      // Download PDFs
      const dlBl = await fetch(`${base}/api/v1/livraisons/${blId}/pack/download/${blDocId}?download=1`, { headers: hAuth })
      if (!dlBl.ok) throw new Error(`download BL PDF ${dlBl.status}: ${JSON.stringify(await asJson(dlBl))}`)
      const blPdf = await asBuffer(dlBl)
      assert(blPdf.subarray(0, 5).toString("ascii") === "%PDF-", "BL PDF is not a PDF")

      const dlCofc = await fetch(`${base}/api/v1/livraisons/${blId}/pack/download/${cofcDocId}?download=1`, { headers: hAuth })
      if (!dlCofc.ok) throw new Error(`download CofC PDF ${dlCofc.status}: ${JSON.stringify(await asJson(dlCofc))}`)
      const cofcPdf = await asBuffer(dlCofc)
      assert(cofcPdf.subarray(0, 5).toString("ascii") === "%PDF-", "CofC PDF is not a PDF")

      // Preview after generation + checksum verification
      const prev2Res = await fetch(`${base}/api/v1/livraisons/${blId}/pack/preview`, { headers: hAuth })
      const prev2 = await asJson(prev2Res)
      assert(prev2Res.ok, `pack preview2 ${prev2Res.status}: ${JSON.stringify(prev2)}`)

      const vRow = (prev2?.pack_versions ?? []).find((v) => v.id === packVersionId) ?? null
      assert(vRow, `Missing pack version in preview2: ${packVersionId}`)
      assert(vRow.version === version, `Preview2 version mismatch: expected ${version}, got ${vRow.version}`)
      assert(vRow.status === "GENERATED", `Unexpected status: ${vRow.status}`)

      const expectedChecksum = sha256([blPdf, cofcPdf])
      assert(typeof vRow.checksum_sha256 === "string", "Missing checksum_sha256")
      assert(vRow.checksum_sha256 === expectedChecksum, `Checksum mismatch: ${vRow.checksum_sha256} != ${expectedChecksum}`)

      // Determinism: renderer should be stable for same inputs
      const signataireLabel = await getUserLabel(pg, userId)
      const blPdfA = await svcRenderPackBonLivraisonPdf({ preview: prev2, version })
      const blPdfB = await svcRenderPackBonLivraisonPdf({ preview: prev2, version })
      assert(blPdfA.equals(blPdfB), "Non-deterministic BL PDF renderer")
      assert(blPdfA.equals(blPdf), "Rendered BL PDF differs from downloaded file")

      const cofcPdfA = await svcRenderPackCofcPdf({
        preview: prev2,
        version,
        signataireLabel,
        commentairePack,
        includeDocuments: true,
      })
      const cofcPdfB = await svcRenderPackCofcPdf({
        preview: prev2,
        version,
        signataireLabel,
        commentairePack,
        includeDocuments: true,
      })
      assert(cofcPdfA.equals(cofcPdfB), "Non-deterministic CofC PDF renderer")
      assert(cofcPdfA.equals(cofcPdf), "Rendered CofC PDF differs from downloaded file")

      // Revoke
      const revokeRes = await fetch(`${base}/api/v1/livraisons/${blId}/pack/revoke/${packVersionId}`, {
        method: "POST",
        headers: hJson,
        body: "{}",
      })
      const revokeBody = await asJson(revokeRes)
      assert(revokeRes.ok, `revoke ${revokeRes.status}: ${JSON.stringify(revokeBody)}`)

      const prev3Res = await fetch(`${base}/api/v1/livraisons/${blId}/pack/preview`, { headers: hAuth })
      const prev3 = await asJson(prev3Res)
      assert(prev3Res.ok, `pack preview3 ${prev3Res.status}: ${JSON.stringify(prev3)}`)
      const vRow3 = (prev3?.pack_versions ?? []).find((v) => v.id === packVersionId) ?? null
      assert(vRow3?.status === "REVOKED", `Expected REVOKED, got ${vRow3?.status}`)

      console.log(
        JSON.stringify(
          {
            blId,
            lineId,
            packVersionId,
            version,
            blDocId,
            cofcDocId,
            checksum: expectedChecksum,
            checks: prev1.checks,
            revoke: revokeBody,
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
  console.error("PHASE6_SMOKE_FAIL", e && e.stack ? e.stack : String(e))
  process.exit(1)
})
