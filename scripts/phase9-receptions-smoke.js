#!/usr/bin/env node
/* eslint-disable no-console */

// Phase 9 smoke test (integration): receptions fournisseur + incoming inspection + lot release/block + stock receipt + blocked lot enforcement.
// Usage: node scripts/phase9-receptions-smoke.js

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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function getErrorCode(body) {
  if (!body || typeof body !== "object") return null
  return typeof body.code === "string" ? body.code : null
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()

  try {
    const reg = (await pg.query("SELECT to_regclass('public.receptions_fournisseurs') AS reg")).rows[0]?.reg
    assert(reg, "Missing DB patch: public.receptions_fournisseurs")

    const suf = crypto.randomUUID().slice(0, 8)

    const userIdRaw = (await pg.query("SELECT id FROM public.users ORDER BY id LIMIT 1")).rows[0]?.id
    const userId = Number(userIdRaw)
    assert(Number.isFinite(userId), "Missing seed user")

    // Seed warehouse/location/magasin/emplacement (with mapping: emplacement.location_id -> location.warehouse_id)
    const warehouseId = (
      await pg.query(
        "INSERT INTO public.warehouses (id, code, name, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id::text AS id",
        [`SMOKE9-WH-${suf}`, `Smoke9 WH ${suf}`]
      )
    ).rows[0]?.id

    const locationId = (
      await pg.query(
        "INSERT INTO public.locations (id, warehouse_id, code, description, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2, $3, now(), now()) RETURNING id::text AS id",
        [warehouseId, `SMOKE9-LOC-${suf}`, `Smoke9 loc ${suf}`]
      )
    ).rows[0]?.id

    const magasinCode = `SMOKE9-${suf}`
    const magasinId = (
      await pg.query(
        "INSERT INTO public.magasins (id, code_magasin, libelle, is_active, code, name, warehouse_id, created_by, updated_by) VALUES (gen_random_uuid(), $1::text, $2::text, true, $1::text, $2::text, $3::uuid, $4, $4) RETURNING id::text AS id",
        [magasinCode, `Smoke9 magasin ${suf}`, warehouseId, userId]
      )
    ).rows[0]?.id

    const emplacementId = (
      await pg.query(
        "INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, location_id, created_at, updated_at, created_by, updated_by) VALUES ($1::uuid, $2, $3, false, true, $4::uuid, now(), now(), $5, $5) RETURNING id::int AS id",
        [magasinId, `SMOKE9-EM-${suf}`, `Smoke9 emp ${suf}`, locationId, userId]
      )
    ).rows[0]?.id

    assert(warehouseId && locationId && magasinId && emplacementId, "Failed to seed stock location entities")

    // Configure deterministic shipping location (needed for BL READY->SHIPPED)
    await pg.query(
      "INSERT INTO public.erp_settings (key, value_json, created_by, updated_by) VALUES ($1, $2::jsonb, $3, $3) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now(), updated_by = EXCLUDED.updated_by",
      ["stock.default_shipping_location", JSON.stringify({ magasin_id: magasinId, emplacement_id: emplacementId }), userId]
    )

    // Seed fournisseur (schema may have legacy column names)
    const fournisseurColsInfo = (
      await pg.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fournisseurs'"
      )
    ).rows

    const fournisseurCols = new Set(
      fournisseurColsInfo.map((r) => r?.column_name).filter((v) => typeof v === "string")
    )

    const fournisseurIdCandidate = crypto.randomUUID()
    const fournisseurCode = `SMOKE9-F-${suf}`
    const fournisseurNom = `Smoke9 Fournisseur ${suf}`

    const insertCols = []
    const insertVals = []
    const insertParams = []
    const push = (v) => {
      insertParams.push(v)
      return `$${insertParams.length}`
    }

    const setCol = (name, value, opts) => {
      if (!fournisseurCols.has(name)) return
      if (insertCols.includes(name)) return
      insertCols.push(name)

      if (opts?.sql) {
        insertVals.push(opts.sql)
        return
      }
      if (opts?.cast) {
        insertVals.push(`${push(value)}::${opts.cast}`)
        return
      }
      insertVals.push(push(value))
    }

    const defaultFor = (colName, dataType) => {
      if (colName === "id") return { kind: "param", value: fournisseurIdCandidate, cast: "uuid" }
      if (colName === "created_at" || colName === "updated_at") return { kind: "sql", sql: "now()" }
      if (colName === "actif" || dataType === "boolean") return { kind: "sql", sql: "true" }
      if (dataType === "uuid") return { kind: "param", value: crypto.randomUUID(), cast: "uuid" }
      if (dataType === "date") return { kind: "sql", sql: "CURRENT_DATE" }
      if (dataType === "timestamp with time zone" || dataType === "timestamp without time zone") return { kind: "sql", sql: "now()" }
      if (dataType === "integer" || dataType === "bigint" || dataType === "numeric") return { kind: "sql", sql: "0" }

      // Text-ish fallbacks
      if (colName === "code" || colName === "code_fournisseur") return { kind: "param", value: fournisseurCode }
      if (colName === "nom" || colName === "nom_fournisseur" || colName === "raison_sociale") return { kind: "param", value: fournisseurNom }
      return { kind: "param", value: `SMOKE9-${suf}` }
    }

    // Preferred explicit fields (when present)
    setCol("id", fournisseurIdCandidate, { cast: "uuid" })
    setCol("code", fournisseurCode)
    setCol("code_fournisseur", fournisseurCode)
    setCol("nom", fournisseurNom)
    setCol("nom_fournisseur", fournisseurNom)
    setCol("raison_sociale", fournisseurNom)
    setCol("actif", true, { sql: "true" })
    setCol("created_at", null, { sql: "now()" })
    setCol("updated_at", null, { sql: "now()" })
    setCol("created_by", userId)
    setCol("updated_by", userId)

    // Ensure required NOT NULL columns are satisfied.
    for (const col of fournisseurColsInfo) {
      const name = typeof col?.column_name === "string" ? col.column_name : null
      const dataType = typeof col?.data_type === "string" ? col.data_type : null
      const isNullable = typeof col?.is_nullable === "string" ? col.is_nullable : null
      const hasDefault = col?.column_default != null
      if (!name || !dataType) continue
      if (insertCols.includes(name)) continue
      if (isNullable !== "NO") continue
      if (hasDefault) continue

      const d = defaultFor(name, dataType)
      if (d.kind === "sql") setCol(name, null, { sql: d.sql })
      else setCol(name, d.value, d.cast ? { cast: d.cast } : undefined)
    }

    assert(insertCols.length > 0, "Unexpected fournisseurs schema (no columns found)")

    const fournisseurId = (
      await pg.query(
        `INSERT INTO public.fournisseurs (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")}) RETURNING id::text AS id`,
        insertParams
      )
    ).rows[0]?.id
    assert(fournisseurId, "Failed to seed fournisseur")

    // Seed stock article
    const articleId = (
      await pg.query(
        "INSERT INTO public.articles (code, designation, article_type, unite, lot_tracking, is_active, created_at, updated_at, created_by, updated_by) VALUES ($1, $2, 'PURCHASED', 'u', true, true, now(), now(), $3, $3) RETURNING id::text AS id",
        [`SMOKE9-PART-${suf}`, `Smoke9 part ${suf}`, userId]
      )
    ).rows[0]?.id
    assert(articleId, "Failed to seed article")

    // Start API server
    const server = http.createServer(app)
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve())))

    try {
      const port = server.address().port
      const token = jwt.sign({ id: userId, username: "smoke", email: "smoke@example.test", role: "ADMIN" }, process.env.JWT_SECRET, {
        expiresIn: "10m",
      })

      const base = `http://127.0.0.1:${port}`
      const hJson = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      const hAuth = { Authorization: `Bearer ${token}` }

      // Create reception
      const rCreate = await fetch(`${base}/api/v1/receptions`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({
          fournisseur_id: fournisseurId,
          reception_date: "2026-02-25",
          supplier_reference: `SMOKE9-${suf}`,
        }),
      })
      const rCreateBody = await asJson(rCreate)
      assert(rCreate.status === 201, `create reception ${rCreate.status}: ${JSON.stringify(rCreateBody)}`)
      const receptionId = rCreateBody.id
      assert(typeof receptionId === "string", "missing receptionId")

      // Create line A (will be BLOQUE)
      const lCreateA = await fetch(`${base}/api/v1/receptions/${receptionId}/lines`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ article_id: articleId, qty_received: 5, unite: "u", supplier_lot_code: `SUP-A-${suf}` }),
      })
      const lCreateABody = await asJson(lCreateA)
      assert(lCreateA.status === 201, `create line A ${lCreateA.status}: ${JSON.stringify(lCreateABody)}`)
      const lineAId = lCreateABody.id
      assert(typeof lineAId === "string", "missing lineAId")

      const lotA = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineAId}/create-lot`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({}),
      })
      const lotABody = await asJson(lotA)
      assert(lotA.status === 201, `create lot A ${lotA.status}: ${JSON.stringify(lotABody)}`)
      const lotAId = lotABody.lot_id
      assert(typeof lotAId === "string", "missing lotAId")

      const inspA = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineAId}/inspection/start`, {
        method: "POST",
        headers: hAuth,
      })
      const inspABody = await asJson(inspA)
      assert(inspA.ok, `start insp A ${inspA.status}: ${JSON.stringify(inspABody)}`)

      const measA = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineAId}/inspection/measurements`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ characteristic: "Diametre", nominal_value: 10, tolerance_min: -0.1, tolerance_max: 0.1, measured_value: 10.3, unit: "mm", result: "NOK" }),
      })
      const measABody = await asJson(measA)
      assert(measA.status === 201, `add measurement A ${measA.status}: ${JSON.stringify(measABody)}`)

      const decideA = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineAId}/inspection/decide`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ decision: "BLOQUE", decision_note: "Hors tol" }),
      })
      const decideABody = await asJson(decideA)
      assert(decideA.ok, `decide A ${decideA.status}: ${JSON.stringify(decideABody)}`)

      const receiptBlocked = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineAId}/stock-receipt`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ qty: 1, dst_magasin_id: magasinId, dst_emplacement_id: emplacementId, unite: "u" }),
      })
      const receiptBlockedBody = await asJson(receiptBlocked)
      assert(receiptBlocked.status === 409, `expected 409 when stock-receipt on blocked lot, got ${receiptBlocked.status}: ${JSON.stringify(receiptBlockedBody)}`)
      assert(getErrorCode(receiptBlockedBody) === "LOT_NOT_RELEASED", `expected LOT_NOT_RELEASED, got ${JSON.stringify(receiptBlockedBody)}`)

      // Create line B (will be LIBERE)
      const lCreateB = await fetch(`${base}/api/v1/receptions/${receptionId}/lines`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ article_id: articleId, qty_received: 5, unite: "u", supplier_lot_code: `SUP-B-${suf}` }),
      })
      const lCreateBBody = await asJson(lCreateB)
      assert(lCreateB.status === 201, `create line B ${lCreateB.status}: ${JSON.stringify(lCreateBBody)}`)
      const lineBId = lCreateBBody.id
      assert(typeof lineBId === "string", "missing lineBId")

      const lotB = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineBId}/create-lot`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({}),
      })
      const lotBBody = await asJson(lotB)
      assert(lotB.status === 201, `create lot B ${lotB.status}: ${JSON.stringify(lotBBody)}`)
      const lotBId = lotBBody.lot_id
      assert(typeof lotBId === "string", "missing lotBId")

      const inspB = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineBId}/inspection/start`, {
        method: "POST",
        headers: hAuth,
      })
      const inspBBody = await asJson(inspB)
      assert(inspB.ok, `start insp B ${inspB.status}: ${JSON.stringify(inspBBody)}`)

      const decideB = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineBId}/inspection/decide`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ decision: "LIBERE" }),
      })
      const decideBBody = await asJson(decideB)
      assert(decideB.ok, `decide B ${decideB.status}: ${JSON.stringify(decideBBody)}`)

      const receiptOk = await fetch(`${base}/api/v1/receptions/${receptionId}/lines/${lineBId}/stock-receipt`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ qty: 5, dst_magasin_id: magasinId, dst_emplacement_id: emplacementId, unite: "u" }),
      })
      const receiptOkBody = await asJson(receiptOk)
      assert(receiptOk.status === 201, `stock receipt B ${receiptOk.status}: ${JSON.stringify(receiptOkBody)}`)
      assert(typeof receiptOkBody?.stock_movement_id === "string", "missing stock_movement_id")

      // Blocked lot must not be allocatable
      const clientId = (await pg.query("SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1")).rows[0]?.client_id
      assert(clientId, "Missing seed client")

      const blCreate = await fetch(`${base}/api/v1/livraisons`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({
          client_id: String(clientId),
          commentaire_interne: `smoke9 ${suf}`,
          lignes: [{ designation: `Smoke9 line ${suf}`, code_piece: "IGNORED", quantite: 3, unite: "u" }],
        }),
      })
      const blCreateBody = await asJson(blCreate)
      assert(blCreate.status === 201, `create BL ${blCreate.status}: ${JSON.stringify(blCreateBody)}`)
      const blId = blCreateBody.id
      assert(typeof blId === "string", "missing blId")

      const blGet = await fetch(`${base}/api/v1/livraisons/${blId}`, { headers: hAuth })
      const blGetBody = await asJson(blGet)
      assert(blGet.ok, `get BL ${blGet.status}: ${JSON.stringify(blGetBody)}`)
      const blLineId = blGetBody?.lignes?.[0]?.id
      assert(typeof blLineId === "string", "missing blLineId")

      const readyRes = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ statut: "READY", commentaire: "smoke9" }),
      })
      assert(readyRes.ok, `READY ${readyRes.status}: ${JSON.stringify(await asJson(readyRes))}`)

      const allocBlocked = await fetch(`${base}/api/v1/livraisons/${blId}/lignes/${blLineId}/allocations`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ article_id: articleId, lot_id: lotAId, quantite: 1, unite: "u" }),
      })
      const allocBlockedBody = await asJson(allocBlocked)
      assert(allocBlocked.status === 409, `expected 409 allocating blocked lot, got ${allocBlocked.status}: ${JSON.stringify(allocBlockedBody)}`)
      assert(getErrorCode(allocBlockedBody) === "LOT_BLOCKED", `expected LOT_BLOCKED, got ${JSON.stringify(allocBlockedBody)}`)

      // Shipping should be blocked if a previously allocated lot becomes BLOQUE.
      const allocOk = await fetch(`${base}/api/v1/livraisons/${blId}/lignes/${blLineId}/allocations`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ article_id: articleId, lot_id: lotBId, quantite: 3, unite: "u" }),
      })
      const allocOkBody = await asJson(allocOk)
      assert(allocOk.status === 201, `alloc ok ${allocOk.status}: ${JSON.stringify(allocOkBody)}`)

      await pg.query("UPDATE public.lots SET lot_status = 'BLOQUE', updated_at = now(), updated_by = $2 WHERE id = $1::uuid", [
        lotBId,
        userId,
      ])

      const shipBlocked = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
        method: "POST",
        headers: hJson,
        body: JSON.stringify({ statut: "SHIPPED", commentaire: "smoke9" }),
      })
      const shipBlockedBody = await asJson(shipBlocked)
      assert(shipBlocked.status === 409, `expected 409 shipping with blocked allocated lot, got ${shipBlocked.status}: ${JSON.stringify(shipBlockedBody)}`)
      assert(getErrorCode(shipBlockedBody) === "LOT_BLOCKED", `expected LOT_BLOCKED, got ${JSON.stringify(shipBlockedBody)}`)

      console.log("OK phase9 receptions smoke")
      console.log(JSON.stringify({ receptionId, lineAId, lotAId, lineBId, lotBId, blId }, null, 2))
    } finally {
      server.close()
    }
  } finally {
    await pg.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
