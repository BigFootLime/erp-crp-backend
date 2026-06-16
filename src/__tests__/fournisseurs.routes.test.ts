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

describe("/api/v1/fournisseurs", () => {
  it("GET /api/v1/fournisseurs/domaines is not handled as a fournisseur id", async () => {
    const token = makeToken()

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          code: "outillage",
          label: "Outillage",
          description: null,
          icon: "Wrench",
          sort_order: 10,
          is_active: true,
        },
      ],
    })

    const res = await request(app).get("/api/v1/fournisseurs/domaines").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      expect.objectContaining({
        code: "outillage",
        label: "Outillage",
      }),
    ])
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain("FROM public.fournisseur_domaines")
  })

  it("GET /api/v1/fournisseurs/domaines falls back before the ecosystem patch is applied", async () => {
    const token = makeToken()
    const missingTable = new Error("relation does not exist") as Error & { code: string }
    missingTable.code = "42P01"
    mocks.poolQuery.mockRejectedValueOnce(missingTable)

    const res = await request(app).get("/api/v1/fournisseurs/domaines").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "outillage",
          label: "Outillage",
        }),
      ])
    )
  })
})
