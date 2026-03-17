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

describe("/api/v1/outils", () => {
  it("GET /api/v1/outils/:id/pricing returns pricing analytics payload", async () => {
    const token = makeToken()

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id_historique: 11,
            id_outil: 42,
            id_fournisseur: 7,
            fournisseur_nom: "Fournisseur A",
            date_prix: "2026-03-10T09:00:00.000Z",
            prix: 12.5,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id_fournisseur: 7,
            fournisseur_nom: "Fournisseur A",
            transactions_count: 2,
            min_price: 11.9,
            max_price: 12.5,
            avg_price: 12.2,
            last_price: 12.5,
            last_price_date: "2026-03-10T09:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id_mouvement: 99,
            type_mouvement: "entrée",
            quantite: 5,
            date_mouvement: "2026-03-10T09:00:00.000Z",
            commentaire: null,
            utilisateur: "test",
            user_id: 1,
            reason: "reappro",
            source: "manual",
            note: null,
            affaire_id: null,
            id_fournisseur: 7,
            fournisseur_nom: "Fournisseur A",
            prix_unitaire: 12.5,
          },
        ],
      })

    const res = await request(app).get("/api/v1/outils/42/pricing").set("Authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      supplier_summary: [
        {
          fournisseur_nom: "Fournisseur A",
          last_price: 12.5,
        },
      ],
      replenishments: [
        {
          id_mouvement: 99,
          prix_unitaire: 12.5,
          fournisseur_nom: "Fournisseur A",
        },
      ],
    })
  })

  it("POST /api/v1/outils/scan/entree rejects price without supplier", async () => {
    const token = makeToken()

    const res = await request(app)
      .post("/api/v1/outils/scan/entree")
      .set("Authorization", `Bearer ${token}`)
      .send({ barcode: "ABC-123", quantity: 2, prix: 12.5 })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      error: "VALIDATION_ERROR",
      message: "Certains champs sont invalides",
    })
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "id_fournisseur" }),
      ])
    )
  })

  it("POST /api/v1/outils/reapprovisionner logs supplier and unit price", async () => {
    const token = makeToken()

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await request(app)
      .post("/api/v1/outils/reapprovisionner")
      .set("Authorization", `Bearer ${token}`)
      .send({
        id_outil: 42,
        quantite: 5,
        prix: 12.5,
        id_fournisseur: 7,
        reason: "reappro",
      })

    expect(res.status).toBe(200)

    const movementInsert = mocks.clientQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO gestion_outils_mouvement_stock")
    )
    expect(movementInsert).toBeTruthy()
    expect(String(movementInsert?.[0])).toContain("id_fournisseur")
    expect(String(movementInsert?.[0])).toContain("prix_unitaire")
    expect(movementInsert?.[1]).toEqual(expect.arrayContaining([7, 12.5]))
  })
})
