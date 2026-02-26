import request from "supertest"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "events"
import jwt from "jsonwebtoken"

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}))

vi.mock("pg", () => {
  const emitter = new EventEmitter()

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  }

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  })

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  }
})

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}))

import app from "../config/app"

beforeEach(() => {
  mocks.poolQuery.mockReset()
  mocks.poolConnect.mockReset()
  mocks.clientQuery.mockReset()
  mocks.clientRelease.mockReset()

  mocks.poolQuery.mockResolvedValue({ rows: [] })
  mocks.clientQuery.mockResolvedValue({ rows: [] })

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  })
})

function makeToken() {
  process.env.JWT_SECRET = "test-secret"
  return jwt.sign({ id: 1, username: "test", email: "test@example.com", role: "admin" }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  })
}

describe("/api/v1/qualite", () => {
  it("GET /api/v1/qualite/dashboard returns dashboard payload", async () => {
    const token = makeToken()

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // open controls
      .mockResolvedValueOnce({ rows: [{ total: 2 }] }) // rejected controls
      .mockResolvedValueOnce({ rows: [{ total: 3 }] }) // open NC
      .mockResolvedValueOnce({ rows: [{ total: 4 }] }) // overdue actions
      .mockResolvedValueOnce({ rows: [{ blocked: 5, quarantine: 6 }] }) // lots
      .mockResolvedValueOnce({ rows: [{ total: 7 }] }) // overdue NC

    const res = await request(app).get("/api/v1/qualite/dashboard").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      kpis: {
        open_controls: 1,
        rejected_controls: 2,
        open_non_conformities: 3,
        actions_overdue: 4,
      },
      lots: { blocked: 5, quarantine: 6 },
      non_conformities: { overdue: 7 },
    })
    expect(mocks.poolQuery).toHaveBeenCalled()
  })

  it("POST /api/v1/qualite/non-conformities/:id/status returns 404 when NC is missing", async () => {
    const token = makeToken()

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // selectNcSnapshot -> null
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    const res = await request(app)
      .post("/api/v1/qualite/non-conformities/11111111-1111-1111-1111-111111111111/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ note: "test", status: "CLOSED" })

    expect(res.status).toBe(404)
  })

  it("POST /api/v1/qualite/non-conformities/:id/dispositions returns 404 when NC is missing", async () => {
    const token = makeToken()

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // lock NC -> not found
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    const res = await request(app)
      .post("/api/v1/qualite/non-conformities/11111111-1111-1111-1111-111111111111/dispositions")
      .set("Authorization", `Bearer ${token}`)
      .send({ note: "test", disposition_type: "HOLD" })

    expect(res.status).toBe(404)
  })
})
