import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  poolQuery: vi.fn(),
  generateCode: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock("../config/database", () => ({
  default: { connect: mocks.poolConnect, query: mocks.poolQuery },
}))

vi.mock("../shared/codes/code-generator.service", () => ({
  generateCommandeFournisseurCode: mocks.generateCode,
}))

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAudit,
}))

import { repoValidateReplenishmentProposal } from "../module/commande-fournisseur/repository/replenishment-proposal.repository"
import { authoritativePdfQueueDbMock } from "./helpers/authoritative-pdf-queue-db-mock"

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111"
const ARTICLE_ID = "22222222-2222-4222-8222-222222222222"
const STOCK_LEVEL_ID = "33333333-3333-4333-8333-333333333333"
const MAGASIN_ID = "44444444-4444-4444-8444-444444444444"
const CATALOGUE_ID = "55555555-5555-4555-8555-555555555555"
const SUPPLIER_ID = "66666666-6666-4666-8666-666666666666"
const CANCELLED_ORDER_ID = "77777777-7777-4777-8777-777777777777"
const NEW_ORDER_ID = "88888888-8888-4888-8888-888888888888"
const NEW_LINE_ID = "99999999-9999-4999-8999-999999999999"

const audit = {
  user_id: 42,
  ip: "127.0.0.1",
  user_agent: "vitest",
  device_type: null,
  os: null,
  browser: null,
  path: `/api/v1/replenishment-proposals/${PROPOSAL_ID}/validate`,
  page_key: "commandes-fournisseurs",
  client_session_id: "replenishment-test",
}

let activeCoverageConflict = false

function dispatch(sqlRaw: unknown, values?: unknown[]) {
  const sql = String(sqlRaw)
  const authoritativePdf = authoritativePdfQueueDbMock(sql, values)
  if (authoritativePdf) return authoritativePdf
  if (sql.includes("FROM public.commande_fournisseur cf") && sql.includes("JOIN public.fournisseurs f")) {
    return {
      rows: [{
        code: "BCF-2026-0002", statut: "BROUILLON", issued_at: "2026-08-23T12:00:00.000Z", devise: "EUR",
        need_date: null, incoterm: null, payment_terms: null, transport_mode: null, public_comment: null,
        delivery_address: null, supplier_code: "FOU-001", supplier_name: "Fournisseur test",
        supplier_street: null, supplier_house_no: null, supplier_postal_code: null, supplier_city: null, supplier_country: null,
        total_ht: "20", total_remise: "0", total_tva: "4", freight_ht: "0", total_ttc: "24",
      }], rowCount: 1,
    }
  }
  if (sql.includes("SELECT position::int") && sql.includes("FROM public.commande_fournisseur_ligne") && sql.includes("statut_ligne = 'ACTIVE'")) {
    return { rows: [{ position: 1, reference: null, designation: "Article agrégé", unit: "u", quantity: "10", unit_price_ht: "2", discount_pct: "0", vat_pct: "20", net_ht: "20", need_date: null }], rowCount: 1 }
  }
  if (sql.includes("SELECT updated_at::text AS source_revision") && sql.includes("public.commande_fournisseur")) {
    return { rows: [{ source_revision: "2026-08-23T12:00:00.000Z" }], rowCount: 1 }
  }
  if (sql.includes("FROM public.replenishment_proposal_idempotence")) return { rows: [], rowCount: 0 }
  if (sql.includes("FROM public.replenishment_proposals p") && sql.includes("FOR UPDATE OF p")) {
    return {
      rows: [{
        id: PROPOSAL_ID,
        version: 1,
        status: "CONVERTIE",
        article_id: ARTICLE_ID,
        magasin_id: MAGASIN_ID,
        stock_level_ids: [STOCK_LEVEL_ID],
        commande_fournisseur_id: CANCELLED_ORDER_ID,
        commande_code: "BCF-2026-0001",
        commande_statut: "ANNULEE",
      }],
      rowCount: 1,
    }
  }
  if (sql.includes("SELECT id FROM public.stock_levels") && sql.includes("FOR UPDATE")) {
    return { rows: [{ id: STOCK_LEVEL_ID }], rowCount: 1 }
  }
  if (sql.includes("WITH stock_rows AS")) {
    return {
      rows: [{
        stock_level_ids: [STOCK_LEVEL_ID],
        stock_level_count: 1,
        article_id: ARTICLE_ID,
        article_code: "ART-TEST-000001",
        article_designation: "Article agrégé",
        stock_unit: "u",
        magasin_id: MAGASIN_ID,
        magasin_name: "Site test",
        qty_on_hand: 0,
        qty_reserved: 0,
        qty_available: 0,
        qty_open_orders: 0,
        open_order_conversion_missing: false,
        stock_unit_conflict: false,
        min_qty: 10,
        safety_stock_qty: 0,
        target_stock_qty: 10,
        reorder_qty: null,
        order_lot_size: 1,
        preferred_catalogue_id: CATALOGUE_ID,
        preferred_supplier_id: SUPPLIER_ID,
      }],
      rowCount: 1,
    }
  }
  if (sql.includes("FROM public.fournisseur_catalogue")) {
    return {
      rows: [{
        catalogue_id: CATALOGUE_ID,
        supplier_id: SUPPLIER_ID,
        supplier_code: "FOU-001",
        supplier_name: "Fournisseur test",
        purchase_unit: "u",
        stock_unit: "u",
        stock_units_per_purchase_unit: null,
        moq: 1,
        purchase_lot_size: 1,
        lead_time_days: 2,
        catalogue_price: 2,
        currency: "EUR",
        last_order_unit_price: null,
        last_order_date: null,
        preferred: true,
      }],
      rowCount: 1,
    }
  }
  if (sql.includes("FROM public.replenishment_budgets")) {
    return { rows: [{ amount_limit: 100, committed: 0 }], rowCount: 1 }
  }
  if (sql.includes("INSERT INTO public.commande_fournisseur_ligne_besoin")) {
    if (activeCoverageConflict) throw Object.assign(new Error("active coverage already exists"), { code: "23505" })
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes("INSERT INTO public.commande_fournisseur_ligne") && !sql.includes("ligne_besoin")) {
    return { rows: [{ id: NEW_LINE_ID }], rowCount: 1 }
  }
  if (sql.includes("INSERT INTO public.commande_fournisseur") && !sql.includes("_ligne")) {
    return { rows: [{ id: NEW_ORDER_ID }], rowCount: 1 }
  }
  if (sql.includes("INSERT INTO public.replenishment_proposal_idempotence")) {
    expect(values?.[3]).toBe(PROPOSAL_ID)
  }
  return { rows: [], rowCount: 0 }
}

beforeEach(() => {
  vi.clearAllMocks()
  activeCoverageConflict = false
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease })
  mocks.generateCode.mockResolvedValue("BCF-2026-0002")
  mocks.insertAudit.mockResolvedValue(undefined)
  mocks.clientQuery.mockImplementation(dispatch)
  mocks.poolQuery.mockResolvedValue({ rows: [{ party: { company_name: "CERP Test" } }], rowCount: 1 })
})

describe("repoValidateReplenishmentProposal — remplacement après annulation", () => {
  const body = {
    catalogue_id: CATALOGUE_ID,
    expected_version: 1,
    idempotency_key: "replenishment-replacement-1",
  }

  it("traduit le conflit 23505 d'une couverture encore active en conflit métier", async () => {
    activeCoverageConflict = true

    await expect(repoValidateReplenishmentProposal(PROPOSAL_ID, body, audit)).rejects.toMatchObject({
      status: 409,
      code: "REPLENISHMENT_ALREADY_CONVERTED",
    })

    expect(mocks.clientQuery).toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.clientQuery).not.toHaveBeenCalledWith("COMMIT")
  })

  it("crée un nouveau brouillon lorsque la couverture de la commande annulée a été libérée", async () => {
    await expect(repoValidateReplenishmentProposal(PROPOSAL_ID, body, audit)).resolves.toMatchObject({
      converted: true,
      commande_fournisseur_id: NEW_ORDER_ID,
      code: "BCF-2026-0002",
      status: "BROUILLON",
      idempotent_replay: false,
    })

    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.commande_fournisseur_ligne_besoin"),
      [NEW_LINE_ID, STOCK_LEVEL_ID, 10],
    )
    expect(mocks.clientQuery).toHaveBeenCalledWith("COMMIT")
    expect(mocks.clientQuery).not.toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.authoritative_pdf_archives"),
      expect.any(Array),
    )
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.authoritative_pdf_archive_outbox"),
      expect.any(Array),
    )
  })
})
