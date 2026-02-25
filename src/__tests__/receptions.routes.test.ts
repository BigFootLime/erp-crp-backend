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

describe("/api/v1/receptions", () => {
  it("GET /api/v1/receptions returns {items,total} and applies filters", async () => {
    const token = makeToken()

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            reception_no: "RF-00000001",
            fournisseur_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            fournisseur_code: "F-01",
            fournisseur_nom: "ACME",
            status: "OPEN",
            reception_date: "2026-02-25",
            supplier_reference: "BL-9",
            lines_count: 2,
            pending_lines_count: 1,
            blocked_lines_count: 0,
            updated_at: "2026-02-25T10:00:00.000Z",
          },
        ],
      })

    const res = await request(app)
      .get("/api/v1/receptions")
      .set("Authorization", `Bearer ${token}`)
      .query({
        q: "RF-",
        status: "OPEN",
        page: "2",
        pageSize: "5",
        sortBy: "reception_no",
        sortDir: "asc",
      })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      total: 1,
      items: [{ reception_no: "RF-00000001", fournisseur_code: "F-01", lines_count: 2 }],
    })
    expect(typeof res.body.items[0].lines_count).toBe("number")

    expect(mocks.poolQuery).toHaveBeenCalledTimes(2)
    const countCall = mocks.poolQuery.mock.calls[0]
    const dataCall = mocks.poolQuery.mock.calls[1]

    expect(String(countCall[0])).toContain("FROM public.receptions_fournisseurs")
    expect(countCall[1]).toEqual(["%RF-%", "OPEN"])

    expect(String(dataCall[0])).toContain("ORDER BY r.reception_no ASC")
    expect(dataCall[1]).toEqual(["%RF-%", "OPEN", 5, 5])
  })

  it("POST /api/v1/receptions creates a reception with reception_no", async () => {
    const token = makeToken()

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ n: "1" }] }) // nextval reception_fournisseur_no_seq
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            reception_no: "RF-00000001",
            fournisseur_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            status: "OPEN",
            reception_date: "2026-02-25",
            supplier_reference: "BL-9",
            commentaire: null,
            created_at: "2026-02-25T10:00:00.000Z",
            updated_at: "2026-02-25T10:00:00.000Z",
            created_by: 1,
            updated_by: 1,
          },
        ],
      }) // insert reception
      .mockResolvedValueOnce({ rows: [{ id: "1", created_at: "2026-02-25T10:00:00.000Z" }] }) // audit log
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const res = await request(app)
      .post("/api/v1/receptions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fournisseur_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        reception_date: "2026-02-25",
        supplier_reference: "BL-9",
      })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      reception_no: "RF-00000001",
      fournisseur_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "OPEN",
    })

    const insertCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO public.receptions_fournisseurs"))
    expect(insertCall).toBeTruthy()
  })
})
