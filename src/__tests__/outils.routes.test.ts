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

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; username: string; email: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, username: "test-admin", email: "admin@example.test", role: "Administrateur Systeme et Reseau" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Le gate d'accès module (#326) est monté globalement dans v1.routes.ts. Ce fichier
// ne teste pas le filtrage par module : on le neutralise pour qu'il ne consomme pas
// une réponse de `pool.query` destinée à la route sous test.
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (req: { accountModuleAccess?: unknown }, _res: unknown, next: () => void) => {
    req.accountModuleAccess = { userId: 1, moduleKey: "outillage", granted: true, elevated: true };
    next();
  },
}));

import app from "../config/app"
import { withRealtimeOutboxDbMock } from "./helpers/realtime-outbox-db-mock"

beforeEach(() => {
  mocks.poolQuery.mockReset()
  mocks.poolConnect.mockReset()
  mocks.clientQuery.mockReset()
  mocks.clientRelease.mockReset()

  mocks.poolQuery.mockResolvedValue({ rows: [] })
  mocks.clientQuery.mockResolvedValue({ rows: [] })
  mocks.poolConnect.mockResolvedValue({
    query: withRealtimeOutboxDbMock(mocks.clientQuery),
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

  it("POST /api/v1/outils/reapprovisionner rejects the retired legacy supplier-price fields", async () => {
    const token = makeToken()
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

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "VALIDATION_ERROR" })
    expect(res.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "prix_unitaire_ht" }),
      expect.objectContaining({ field: "fournisseur_id" }),
      expect.objectContaining({ field: "idempotency_key" }),
    ]))
  })

  it("POST /api/v1/outils/reapprovisionner records an idempotent master-supplier receipt", async () => {
    const token = makeToken()
    const supplierId = "11111111-1111-4111-8111-111111111111"

    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const statement = String(sql)
      if (statement.includes("to_regclass('public.outillage_tool_actual_purchase_prices')")) {
        return { rows: [{ table_name: "outillage_tool_actual_purchase_prices", idempotence_table_name: "outillage_tool_receipt_idempotence" }] }
      }
      if (statement.includes("SELECT request_hash,result FROM outillage_tool_receipt_idempotence")) return { rows: [] }
      if (statement.includes("FROM fournisseurs f JOIN fournisseur_domaine_lien")) return { rows: [{ ok: 1 }] }
      if (statement.includes("INSERT INTO gestion_outils_mouvement_stock")) {
        return { rows: [{ id_mouvement: "movement-99", date_mouvement: "2026-03-10T09:00:00.000Z" }] }
      }
      return { rows: [], rowCount: 1 }
    })

    const res = await request(app)
      .post("/api/v1/outils/reapprovisionner")
      .set("Authorization", `Bearer ${token}`)
      .send({
        id_outil: 42,
        quantite: 5,
        prix_unitaire_ht: 12.5,
        fournisseur_id: supplierId,
        purchased_at: "2026-03-10",
        devise: "EUR",
        unite: "piece",
        reception_ref: "BL-99",
        idempotency_key: "outillage-receipt-99",
        reason: "reappro",
      })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, id_outil: 42, reception_ref: "BL-99", actual_purchase_price_recorded: true, idempotent_replay: false })

    const actualPriceInsert = mocks.clientQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO outillage_tool_actual_purchase_prices")
    )
    expect(actualPriceInsert).toBeTruthy()
    expect(actualPriceInsert?.[1]).toEqual(expect.arrayContaining([supplierId, 12.5, "EUR", "piece", "2026-03-10", "BL-99"]))

    const idempotenceInsert = mocks.clientQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO outillage_tool_receipt_idempotence")
    )
    expect(idempotenceInsert).toBeTruthy()
  })
})
