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

describe("/api/v1/metrologie", () => {
  it("GET /api/v1/metrologie/kpis returns KPIs", async () => {
    const token = makeToken()

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          total: 2,
          actifs: 1,
          critiques: 1,
          en_retard: 0,
          en_retard_critiques: 0,
          echeance_30j: 1,
        },
      ],
    })

    const res = await request(app).get("/api/v1/metrologie/kpis").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      kpis: {
        total: 2,
        actifs: 1,
        critiques: 1,
        en_retard: 0,
        en_retard_critiques: 0,
        echeance_30j: 1,
      },
    })

    expect(mocks.poolQuery).toHaveBeenCalledTimes(1)
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain("FROM public.metrologie_equipements")
  })

  it("GET /api/v1/metrologie/alerts returns overdue critical list", async () => {
    const token = makeToken()

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 3 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            code: "EQ-1",
            designation: "Micrometre",
            localisation: "Atelier",
            criticite: "CRITIQUE",
            next_due_date: "2026-02-01",
            days_overdue: 24,
          },
        ],
      })

    const res = await request(app).get("/api/v1/metrologie/alerts").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      overdue_critical_count: 3,
      overdue_critical: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          code: "EQ-1",
          criticite: "CRITIQUE",
          next_due_date: "2026-02-01",
          days_overdue: 24,
        },
      ],
    })

    expect(mocks.poolQuery).toHaveBeenCalledTimes(2)
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain("FROM public.metrologie_equipements")
    expect(String(mocks.poolQuery.mock.calls[1]?.[0])).toContain("FROM public.metrologie_equipements")
  })

  it("GET /api/v1/metrologie/alerts/summary returns counts", async () => {
    const token = makeToken()

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ overdue_count: 2, due_soon_count: 1, oot_count: 3 }],
    })

    const res = await request(app).get("/api/v1/metrologie/alerts/summary").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      overdue_count: 2,
      due_soon_count: 1,
      oot_count: 3,
    })

    expect(mocks.poolQuery).toHaveBeenCalledTimes(1)
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain("FROM public.metrologie_equipements")
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain("public.metrologie_plan")
  })

  it("GET /api/v1/metrologie/equipements returns {items,total} and applies filters", async () => {
    const token = makeToken()

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            code: "EQ-1",
            designation: "Micrometre",
            localisation: "Atelier",
            criticite: "CRITIQUE",
            statut: "ACTIF",
            last_done_date: "2026-01-15",
            next_due_date: "2026-02-15",
            is_overdue: false,
            updated_at: "2026-02-20T10:00:00.000Z",
            created_at: "2026-01-01T10:00:00.000Z",
          },
        ],
      })

    const res = await request(app)
      .get("/api/v1/metrologie/equipements")
      .set("Authorization", `Bearer ${token}`)
      .query({
        q: "EQ",
        criticite: "CRITIQUE",
        overdue: "true",
        page: "2",
        pageSize: "5",
        sortBy: "code",
        sortDir: "asc",
      })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      total: 1,
      items: [{ code: "EQ-1", criticite: "CRITIQUE", statut: "ACTIF", is_overdue: false }],
    })

    expect(mocks.poolQuery).toHaveBeenCalledTimes(2)
    const countCall = mocks.poolQuery.mock.calls[0]
    const dataCall = mocks.poolQuery.mock.calls[1]

    expect(String(countCall?.[0])).toContain("FROM public.metrologie_equipements")
    expect(countCall?.[1]).toEqual(["%EQ%", "CRITIQUE"])

    expect(String(dataCall?.[0])).toContain("ORDER BY e.code ASC")
    expect(dataCall?.[1]).toEqual(["%EQ%", "CRITIQUE", 5, 5])
  })

  it("POST /api/v1/metrologie/equipements creates an equipement", async () => {
    const token = makeToken()
    const equipementId = "11111111-1111-1111-1111-111111111111"

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: equipementId }] }) // INSERT metrologie_equipements
      .mockResolvedValueOnce({ rows: [] }) // INSERT metrologie_event_log
      .mockResolvedValueOnce({ rows: [{ id: "1", created_at: "2026-02-25T10:00:00.000Z" }] }) // INSERT erp_audit_logs
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: equipementId,
            code: "EQ-001",
            designation: "Pied a coulisse",
            categorie: null,
            marque: null,
            modele: null,
            numero_serie: null,
            localisation: "Atelier",
            criticite: "CRITIQUE",
            statut: "ACTIF",
            notes: null,
            created_at: "2026-02-25T10:00:00.000Z",
            updated_at: "2026-02-25T10:00:00.000Z",
            created_by_id: 1,
            created_by_username: "test",
            created_by_name: null,
            created_by_surname: null,
            updated_by_id: 1,
            updated_by_username: "test",
            updated_by_name: null,
            updated_by_surname: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // plan
      .mockResolvedValueOnce({ rows: [] }) // certificats
      .mockResolvedValueOnce({
        rows: [
          {
            id: "evt-1",
            equipement_id: equipementId,
            event_type: "EQUIPEMENT_CREATE",
            old_values: null,
            new_values: { id: equipementId, designation: "Pied a coulisse" },
            created_at: "2026-02-25T10:00:00.000Z",
            user_id: 1,
            username: "test",
            name: null,
            surname: null,
          },
        ],
      })

    const res = await request(app)
      .post("/api/v1/metrologie/equipements")
      .set("Authorization", `Bearer ${token}`)
      .send({
        code: "EQ-001",
        designation: "Pied a coulisse",
        localisation: "Atelier",
        criticite: "CRITIQUE",
        statut: "ACTIF",
      })

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty("equipement")
    expect(res.body.equipement).toMatchObject({
      id: equipementId,
      code: "EQ-001",
      criticite: "CRITIQUE",
      statut: "ACTIF",
    })
    expect(res.body).toMatchObject({ plan: null, certificats: [] })

    expect(mocks.poolConnect).toHaveBeenCalledTimes(1)
    const insertEquipementCall = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO public.metrologie_equipements")
    )
    expect(insertEquipementCall).toBeTruthy()
  })
})
