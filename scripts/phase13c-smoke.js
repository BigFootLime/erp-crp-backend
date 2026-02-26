#!/usr/bin/env node
/* eslint-disable no-console */

// Phase 13C smoke test (integration): Socket.IO realtime events + DB-backed entity locks.
// Usage: node scripts/phase13c-smoke.js

process.env.NODE_ENV = process.env.NODE_ENV ?? "development"
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/erp-database"
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret"

const http = require("http")
const crypto = require("crypto")

const jwt = require("jsonwebtoken")
const { Client } = require("pg")
const { io } = require("socket.io-client")

const appMod = require("../dist/config/app")
const app = appMod.default ?? appMod

const sockMod = require("../dist/sockets/sockeServer")
const initSocketServer = sockMod.initSocketServer

const auditListenerMod = require("../dist/shared/realtime/audit-notify.listener")
const startAuditNotifyListener = auditListenerMod.startAuditNotifyListener

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function asJson(res) {
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) return await res.json()
  return await res.text()
}

function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

function waitForSocket(socket, eventName, predicate, timeoutMs) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (payload) => {
        try {
          if (predicate(payload)) {
            socket.off(eventName, handler)
            resolve(payload)
          }
        } catch {
          // ignore predicate errors
        }
      }
      socket.on(eventName, handler)
    }),
    timeoutMs,
    `socket event ${eventName}`
  )
}

async function waitConnect(socket) {
  if (socket.connected) return
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("connect_error", reject)
    }),
    8000,
    "socket connect"
  )
}

async function joinRoom(socket, room) {
  const ack = await withTimeout(
    new Promise((resolve) => {
      socket.emit("room:join", { room }, (r) => resolve(r))
    }),
    5000,
    `room:join ${room}`
  )

  assert(ack && typeof ack === "object" && ack.ok === true, `room:join failed for ${room}: ${JSON.stringify(ack)}`)
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()

  try {
    const reg = (await pg.query("SELECT to_regclass('public.entity_locks') AS reg")).rows[0]?.reg
    assert(reg, "Missing DB patch: public.entity_locks")

    const users = (
      await pg.query(
        "SELECT id::int AS id, username, email, role FROM public.users ORDER BY id ASC LIMIT 2"
      )
    ).rows
    assert(users.length >= 1, "Missing seed user")
    const u1 = users[0]

    const smokeSuf = crypto.randomUUID().slice(0, 8)

    let u2 = users[1]
    if (!u2) {
      u2 = (
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
            RETURNING id::int AS id, username
          `,
          [
            `smoke2-${smokeSuf}`,
            "smoke",
            "Smoke",
            "Two",
            `smoke2-${smokeSuf}@example.test`,
            "+33600000000",
            "Directeur",
            "Male",
            "Smoke Street",
            "Lane",
            "1",
            "69000",
            "1990-01-01",
            `SMOKE-${smokeSuf}`,
          ]
        )
      ).rows[0]
    }

    let clientId = (await pg.query("SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1")).rows[0]?.client_id
    if (!clientId) {
      for (let i = 1; i <= 50 && !clientId; i++) {
        const candidate = String(i).padStart(3, "0")
        const r = await pg.query(
          "INSERT INTO public.clients (client_id, company_name) VALUES ($1,$2) ON CONFLICT (client_id) DO NOTHING RETURNING client_id",
          [candidate, `Client Smoke ${smokeSuf}`]
        )
        clientId = r.rows[0]?.client_id
      }
    }
    assert(clientId != null, "Missing seed client")

    // Start API + Socket server on ephemeral port
    const server = http.createServer(app)
    initSocketServer(server)
    const stopAuditNotifyListener = await startAuditNotifyListener()
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve())))

    try {
      const port = server.address().port
      const base = `http://127.0.0.1:${port}`

      const token1 = jwt.sign(
        {
          id: u1.id,
          username: u1.username ?? "smoke1",
          email: u1.email ?? "smoke1@example.test",
          role: u1.role ?? "Directeur",
        },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
      )
      const token2 = jwt.sign(
        {
          id: u2.id,
          username: u2.username ?? "smoke2",
          email: u2.email ?? "smoke2@example.test",
          role: u2.role ?? "Directeur",
        },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
      )

      const hJson1 = { Authorization: `Bearer ${token1}`, "Content-Type": "application/json" }
      const hJson2 = { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" }

      const s1 = io(base, { transports: ["websocket"], auth: { token: token1 }, reconnection: false })
      const s2 = io(base, { transports: ["websocket"], auth: { token: token2 }, reconnection: false })
      await waitConnect(s1)
      await waitConnect(s2)

      // --- Lock flow (acquire -> conflict -> heartbeat -> release)
      const lockEntityId = crypto.randomUUID()
      const lockRoom = `BON_LIVRAISON:${lockEntityId}`
      await joinRoom(s1, lockRoom)
      await joinRoom(s2, lockRoom)

      const lockUpdatedP = waitForSocket(
        s2,
        "lock:updated",
        (p) => p && p.entityId === lockEntityId && p.locked === true && p.lock && p.lock.lockedBy && p.lock.lockedBy.id === u1.id,
        8000
      )

      const acq = await fetch(`${base}/api/v1/locks/acquire`, {
        method: "POST",
        headers: hJson1,
        body: JSON.stringify({ entity_type: "BON_LIVRAISON", entity_id: lockEntityId, reason: "smoke" }),
      })
      const acqBody = await asJson(acq)
      assert(acq.status === 200, `acquire lock ${acq.status}: ${JSON.stringify(acqBody)}`)
      assert(acqBody && acqBody.lock && acqBody.lock.lockedBy && acqBody.lock.lockedBy.id === u1.id, "acquire lock: missing lockedBy")

      await lockUpdatedP

      const conflict = await fetch(`${base}/api/v1/locks/acquire`, {
        method: "POST",
        headers: hJson2,
        body: JSON.stringify({ entity_type: "BON_LIVRAISON", entity_id: lockEntityId }),
      })
      const conflictBody = await asJson(conflict)
      assert(conflict.status === 409, `expected 409 on conflicting acquire, got ${conflict.status}: ${JSON.stringify(conflictBody)}`)
      assert(conflictBody && conflictBody.code === "ENTITY_LOCKED", `expected ENTITY_LOCKED, got ${JSON.stringify(conflictBody)}`)
      assert(conflictBody.lock && conflictBody.lock.lockedBy && conflictBody.lock.lockedBy.id === u1.id, "conflict: missing lock owner")

      const heartbeatP = waitForSocket(
        s2,
        "lock:updated",
        (p) => p && p.entityId === lockEntityId && p.locked === true,
        8000
      )
      const hb = await fetch(`${base}/api/v1/locks/heartbeat`, {
        method: "POST",
        headers: hJson1,
        body: JSON.stringify({ entity_type: "BON_LIVRAISON", entity_id: lockEntityId }),
      })
      const hbBody = await asJson(hb)
      assert(hb.status === 200, `heartbeat ${hb.status}: ${JSON.stringify(hbBody)}`)
      await heartbeatP

      const releaseP = waitForSocket(
        s2,
        "lock:updated",
        (p) => p && p.entityId === lockEntityId && p.locked === false,
        8000
      )
      const rel = await fetch(`${base}/api/v1/locks/release`, {
        method: "POST",
        headers: hJson1,
        body: JSON.stringify({ entity_type: "BON_LIVRAISON", entity_id: lockEntityId }),
      })
      const relBody = await asJson(rel)
      assert(rel.status === 200, `release ${rel.status}: ${JSON.stringify(relBody)}`)
      await releaseP

      // --- Audit new (explicit audit log creation)
      const auditNewP = waitForSocket(
        s2,
        "audit:new",
        (p) => p && typeof p.auditId === "string" && p.auditId.trim(),
        12000
      )
      const auditCreate = await fetch(`${base}/api/v1/audit-logs`, {
        method: "POST",
        headers: hJson1,
        body: JSON.stringify({
          event_type: "ACTION",
          action: "phase13c.smoke",
          page_key: "smoke",
          path: "/api/v1/audit-logs",
          details: { run: smokeSuf },
        }),
      })
      const auditCreateBody = await asJson(auditCreate)
      assert(auditCreate.status === 201, `create audit ${auditCreate.status}: ${JSON.stringify(auditCreateBody)}`)
      await auditNewP

      // --- Entity changed (create BL -> status change)
      const createdP = waitForSocket(
        s2,
        "entity:changed",
        (p) => p && p.entityType === "BON_LIVRAISON" && p.action === "created" && p.module === "livraisons",
        12000
      )

      const blCreate = await fetch(`${base}/api/v1/livraisons`, {
        method: "POST",
        headers: hJson1,
        body: JSON.stringify({
          client_id: String(clientId),
          commentaire_interne: "phase13c smoke",
          lignes: [{ designation: "Smoke13C", code_piece: "IGNORED", quantite: 1, unite: "u" }],
        }),
      })
      const blBody = await asJson(blCreate)
      assert(blCreate.status === 201, `create BL ${blCreate.status}: ${JSON.stringify(blBody)}`)
      const blId = blBody.id
      assert(typeof blId === "string" && blId.length > 0, "create BL: missing id")

      const createdEvt = await createdP
      assert(createdEvt.entityId === blId, `entity:changed entityId mismatch: expected ${blId}, got ${createdEvt.entityId}`)
      assert(createdEvt.by && createdEvt.by.id === u1.id, "entity:changed: missing by")
      assert(Array.isArray(createdEvt.invalidateKeys), "entity:changed: missing invalidateKeys")

      // Join entity room and change status
      await joinRoom(s2, `BON_LIVRAISON:${blId}`)
      const statusEvtP = waitForSocket(
        s2,
        "entity:changed",
        (p) => p && p.entityType === "BON_LIVRAISON" && p.entityId === blId && p.action === "status_changed",
        12000
      )

      const blStatus = await fetch(`${base}/api/v1/livraisons/${blId}/status`, {
        method: "POST",
        headers: hJson1,
        body: JSON.stringify({ statut: "READY", commentaire: "smoke" }),
      })
      assert(blStatus.ok, `BL status ${blStatus.status}: ${JSON.stringify(await asJson(blStatus))}`)
      await statusEvtP

      s1.close()
      s2.close()

      console.log("OK phase13c smoke")
      console.log(JSON.stringify({ lockEntityId, blId }, null, 2))
    } finally {
      if (typeof stopAuditNotifyListener === "function") await stopAuditNotifyListener()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  } finally {
    await pg.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
