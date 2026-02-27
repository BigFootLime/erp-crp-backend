#!/usr/bin/env node
/* eslint-disable no-console */

// Phase 14 smoke test (integration): quick-commande preview + confirm with idempotency replay.
// Usage:
//   npm run build
//   node scripts/phase14-quick-commande-smoke.js

process.env.NODE_ENV = process.env.NODE_ENV ?? "development"
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/erp-database"
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret"

const http = require("http")
const crypto = require("crypto")

const jwt = require("jsonwebtoken")
const { Client } = require("pg")

const appMod = require("../dist/config/app")
const app = appMod.default ?? appMod

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function asJson(res) {
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) return await res.json()
  return await res.text()
}

function pickItems(out) {
  return out?.items ?? out?.data?.items ?? out?.rows ?? out?.data?.rows ?? out?.data ?? out
}

async function httpJson(base, method, path, headers, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const out = await asJson(res)
  if (!res.ok) {
    const code = out && typeof out === "object" ? out.code : null
    const msg = out && typeof out === "object" ? out.message : null
    const err = new Error(`HTTP ${res.status} ${method} ${path}${code ? ` (${code})` : ""}${msg ? `: ${msg}` : ""}`)
    err.status = res.status
    err.code = code
    err.body = out
    throw err
  }
  return out
}

async function ensureSeedUser(pg, suf) {
  const existing = (
    await pg.query("SELECT id::int AS id, username, email, role FROM public.users ORDER BY id ASC LIMIT 1")
  ).rows[0]
  if (existing && Number.isFinite(existing.id)) return existing

  const created = (
    await pg.query(
      `
        INSERT INTO public.users (
          username,
          password,
          name,
          surname,
          email,
          tel_no,
          role,
          gender,
          address,
          lane,
          house_no,
          postcode,
          date_of_birth,
          social_security_number
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id::int AS id, username, email, role
      `,
      [
        `smoke14-${suf}`,
        "smoke",
        "Smoke",
        "Fourteen",
        `smoke14-${suf}@example.test`,
        "+33600000000",
        "Directeur",
        "Male",
        "Smoke Street",
        "Lane",
        "1",
        "69000",
        "1990-01-01",
        `SMOKE14-${suf}`,
      ]
    )
  ).rows[0]
  assert(created && Number.isFinite(created.id), "Failed to create seed user")
  return created
}

async function ensureClientId(pg, suf) {
  let clientId = (await pg.query("SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1")).rows[0]?.client_id
  if (clientId) return clientId

  for (let i = 1; i <= 50 && !clientId; i++) {
    const candidate = String(i).padStart(3, "0")
    const r = await pg.query(
      "INSERT INTO public.clients (client_id, company_name) VALUES ($1,$2) ON CONFLICT (client_id) DO NOTHING RETURNING client_id",
      [candidate, `Client Smoke14 ${suf}`]
    )
    clientId = r.rows[0]?.client_id
  }

  assert(clientId != null, "Missing seed client")
  return clientId
}

async function ensurePiecesFamily(base, suf) {
  const code = `SMOKE14-FAM-${suf}`
  const list = await httpJson(base, "GET", "/api/v1/pieces-families", {}, undefined)
  const items = Array.isArray(list) ? list : pickItems(list)
  const match = (Array.isArray(items) ? items : []).find((f) => String(f.code ?? "").trim() === code)
  if (match && typeof match.id === "string") return match

  const created = await httpJson(base, "POST", "/api/v1/pieces-families", {}, {
    code,
    designation: `Famille SMOKE14 ${suf}`,
    type_famille: "USINAGE",
    section: "SMOKE",
  })

  assert(created && typeof created.id === "string", "Failed to create pieces family")
  return created
}

async function ensurePoste(base, authHeaders, suf) {
  const code = `SMOKE14-P-${suf}`
  const out = await httpJson(base, "GET", "/api/v1/production/postes?pageSize=200", authHeaders, undefined)
  const items = pickItems(out) ?? []
  const match = (Array.isArray(items) ? items : []).find((p) => String(p.code ?? "").trim() === code)
  if (match && typeof match.id === "string") return match

  const created = await httpJson(base, "POST", "/api/v1/production/postes", authHeaders, {
    code,
    label: `Poste Smoke14 ${suf}`,
    machine_id: null,
    hourly_rate_override: null,
    currency: "EUR",
    is_active: true,
    notes: "Smoke test poste",
  })
  assert(created && typeof created.id === "string", "Failed to create poste")
  return created
}

async function ensurePieceTechnique(base, authHeaders, clientId, familyId, suf) {
  const code_piece = `SMOKE14-PT-${suf}`
  const list = await httpJson(
    base,
    "GET",
    `/api/v1/pieces-techniques?q=${encodeURIComponent(code_piece)}&pageSize=50`,
    authHeaders,
    undefined
  )
  const items = pickItems(list)
  const match = (Array.isArray(items) ? items : []).find((p) => String(p.code_piece ?? "").trim() === code_piece)
  const existingId = match?.id ?? match?.piece?.id
  if (typeof existingId === "string") return { id: existingId, code_piece, designation: match.designation ?? match.name_piece }

  const created = await httpJson(base, "POST", "/api/v1/pieces-techniques", authHeaders, {
    client_id: clientId,
    code_client: `REF-SMOKE14-${suf}`,
    client_name: null,
    famille_id: familyId,
    name_piece: `Piece technique Smoke14 ${suf}`,
    code_piece,
    designation: `Piece technique Smoke14 ${suf}`,
    designation_2: null,
    prix_unitaire: 199,
    statut: "ACTIVE",
    cycle: 35,
    cycle_fabrication: 40,
    ensemble: false,
    bom: [],
    operations: [
      { phase: 10, designation: "Debit", prix: 5, coef: 1, tp: 5, tf_unit: 0, qte: 1, taux_horaire: 60 },
      { phase: 20, designation: "Usinage", prix: 10, coef: 1, tp: 10, tf_unit: 0, qte: 1, taux_horaire: 75 },
      { phase: 30, designation: "Controle", prix: 3, coef: 1, tp: 3, tf_unit: 0, qte: 1, taux_horaire: 65 },
    ],
    achats: [],
  })

  const createdId = created?.piece?.id ?? created?.id
  assert(typeof createdId === "string", "Failed to create piece technique")
  return { id: createdId, code_piece, designation: created.designation ?? created.name_piece }
}

async function main() {
  const suf = crypto.randomUUID().slice(0, 8).toUpperCase()
  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()

  try {
    const reg = (await pg.query("SELECT to_regclass('public.quick_commande_previews') AS reg")).rows[0]?.reg
    assert(reg, "Missing DB patch: public.quick_commande_previews")

    const server = http.createServer(app)
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve())))

    try {
      const base = `http://127.0.0.1:${server.address().port}`

      const user = await ensureSeedUser(pg, suf)
      const token = jwt.sign(
        {
          id: user.id,
          username: user.username ?? "smoke14",
          email: user.email ?? "smoke14@example.test",
          role: user.role ?? "Directeur",
        },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
      )

      const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Page-Key": "smoke14" }
      const clientId = await ensureClientId(pg, suf)
      const family = await ensurePiecesFamily(base, suf)
      const piece = await ensurePieceTechnique(base, authHeaders, clientId, family.id, suf)
      const poste = await ensurePoste(base, authHeaders, suf)

      const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

      const preview = await httpJson(base, "POST", "/api/v1/quick-commande/preview", authHeaders, {
        client_id: clientId,
        piece_technique_id: piece.id,
        quantity: 2,
        deadline_ts: deadline,
        start_ts: null,
        poste_id: poste.id,
        step_minutes: 15,
        priority: "NORMAL",
      })

      assert(typeof preview.preview_id === "string" && preview.preview_id.length > 0, "preview.preview_id missing")
      assert(preview.piece && preview.piece.piece_technique_id === piece.id, "preview piece mismatch")
      assert(Array.isArray(preview.plan?.operations) && preview.plan.operations.length > 0, "preview plan.operations missing")

      const idempotencyKey = crypto.randomUUID()
      const confirmHeaders = { ...authHeaders, "Idempotency-Key": idempotencyKey }

      const confirmed1 = await httpJson(base, "POST", "/api/v1/quick-commande/confirm", confirmHeaders, {
        preview_id: preview.preview_id,
        overrides: [],
      })

      assert(confirmed1 && typeof confirmed1 === "object", "confirm response missing")
      assert(confirmed1.preview_id === preview.preview_id, "confirm preview_id mismatch")
      assert(Number.isFinite(confirmed1.commande?.id), "confirm commande.id missing")
      assert(typeof confirmed1.commande?.numero === "string" && confirmed1.commande.numero.length > 0, "confirm commande.numero missing")
      assert(Number.isFinite(confirmed1.of?.id), "confirm of.id missing")
      assert(typeof confirmed1.of?.numero === "string" && confirmed1.of.numero.length > 0, "confirm of.numero missing")
      assert(Array.isArray(confirmed1.planning_event_ids) && confirmed1.planning_event_ids.length > 0, "confirm planning_event_ids missing")

      const confirmed2 = await httpJson(base, "POST", "/api/v1/quick-commande/confirm", confirmHeaders, {
        preview_id: preview.preview_id,
        overrides: [],
      })

      assert(
        JSON.stringify(confirmed2) === JSON.stringify(confirmed1),
        `Idempotency replay mismatch\nfirst=${JSON.stringify(confirmed1)}\nsecond=${JSON.stringify(confirmed2)}`
      )

      console.log("[phase14] OK")
      console.log(`  preview_id: ${preview.preview_id}`)
      console.log(`  commande: ${confirmed1.commande.numero} (#${confirmed1.commande.id})`)
      console.log(`  of: ${confirmed1.of.numero} (#${confirmed1.of.id})`)
      console.log(`  planning events: ${confirmed1.planning_event_ids.length}`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    await pg.end().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error("[phase14] FAILED")
  console.error(err)
  process.exitCode = 1
})
