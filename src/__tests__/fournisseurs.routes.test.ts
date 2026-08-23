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
    req.user = { id: 1, username: "test-admin", email: "admin@example.test", role: "administrateur" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Le gate d'accès module (#326) est monté globalement dans v1.routes.ts. Ce fichier
// ne teste pas le filtrage par module : on le neutralise pour qu'il ne consomme pas
// une réponse de `pool.query` destinée à la route sous test.
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app"
import { authoritativePdfQueueDbMock } from "./helpers/authoritative-pdf-queue-db-mock"

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

function createdFournisseurRow(id: string) {
  return {
    id, code: "FOU-001", nom: "Fournisseur pilote", actif: true, status: "actif", type_principal: null,
    tva: null, siret: null, email: null, telephone: null, site_web: null, adresse_ligne: null,
    house_no: null, postcode: null, city: null, country: null, nom_commercial: null, logo: null, notes: null,
    archived_at: null, created_at: "2026-07-27T00:00:00.000Z", updated_at: "2026-07-27T00:00:00.000Z",
    created_by: 1, updated_by: 1, domaines: [], relations: null, homologation: null, adresses: [],
    contacts_count: 0, catalogue_count: 0, documents_count: 0, events_count: 0, adresses_count: 0,
    homologations_count: 0,
  }
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

  it("POST /api/v1/fournisseurs explicitly types duplicated SQL parameters", async () => {
    const token = makeToken()
    const fournisseurId = "22222222-2222-4222-8222-222222222222"

    mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const query = String(sql)
      const authoritativePdf = authoritativePdfQueueDbMock(sql, params)
      if (authoritativePdf) return authoritativePdf
      if (query.includes("SELECT updated_at::text AS updated_at FROM public.fournisseurs")) {
        return { rows: [{ updated_at: "2026-08-23T12:00:00.000Z" }] }
      }
      if (query.includes("fn_next_issued_code_value")) {
        return { rows: [{ v: "1" }] }
      }
      if (query.includes("INSERT INTO public.fournisseurs")) {
        return { rows: [{ id: fournisseurId }] }
      }
      return { rows: [] }
    })
    mocks.poolQuery.mockResolvedValueOnce({ rows: [createdFournisseurRow(fournisseurId)] })

    const res = await request(app)
      .post("/api/v1/fournisseurs")
      .set("Authorization", `Bearer ${token}`)
      .send({ nom: "Fournisseur pilote" })

    expect(res.status).toBe(201)
    const insertCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.fournisseurs")
    )
    expect(insertCall).toBeDefined()
    expect(String(insertCall?.[0])).toContain("$1::text,$1::varchar(30)")
    expect(String(insertCall?.[0])).toContain("$2::text,$2::varchar(255)")
  })

  it("archives the same normalized primary domain that it persists", async () => {
    const token = makeToken()
    const fournisseurId = "33333333-3333-4333-8333-333333333333"
    mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const query = String(sql)
      const authoritativePdf = authoritativePdfQueueDbMock(sql, params)
      if (authoritativePdf) return authoritativePdf
      if (query.includes("SELECT updated_at::text AS updated_at FROM public.fournisseurs")) {
        return { rows: [{ updated_at: "2026-08-23T12:00:00.000Z" }] }
      }
      if (query.includes("fn_next_issued_code_value")) return { rows: [{ v: "1" }] }
      if (query.includes("INSERT INTO public.fournisseurs")) return { rows: [{ id: fournisseurId }] }
      return { rows: [] }
    })
    mocks.poolQuery.mockResolvedValueOnce({ rows: [createdFournisseurRow(fournisseurId)] })

    const res = await request(app)
      .post("/api/v1/fournisseurs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nom: "Fournisseur pilote",
        domaines: [
          { domaine_code: "usinage", is_primary: false },
          { domaine_code: "traitement", is_primary: false },
        ],
      })

    expect(res.status).toBe(201)
    const domainCalls = mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.fournisseur_domaine_lien"))
    expect(domainCalls.map((call) => call[1]?.[2])).toEqual([true, false])
    const archiveCall = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.authoritative_pdf_archives"))
    const snapshot = JSON.parse(String(archiveCall?.[1]?.[8])) as { sections: Array<{ title: string; table?: { rows: Array<Record<string, string>> } }> }
    expect(snapshot.sections.find((section) => section.title === "Domaines")?.table?.rows).toEqual([
      { domaine: "usinage", principal: "Oui" },
      { domaine: "traitement", principal: "Non" },
    ])
  })
})
