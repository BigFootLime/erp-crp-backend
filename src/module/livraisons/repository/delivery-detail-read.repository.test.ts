import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  proofs: vi.fn(),
}))

vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect } }))
vi.mock("./livraisons-shipment.repository", () => ({
  repoListLivraisonProofs: (...args: unknown[]) => mocks.proofs(...args),
}))

import { repoGetLivraisonDetail } from "./delivery-detail-read.repository"
import { getHeader, intercompanyDestinationAddress } from "./delivery-header.repository"

const deliveryId = "00000000-0000-0000-0000-000000000001"

function header(overrides: Record<string, unknown> = {}) {
  return {
    id: deliveryId, numero: "BL-1", statut: "READY", client_id: "42", client_code: null,
    client_company_name: "Client", commande_id: "7", commande_numero: "CMD-7", commande_numeros: ["CMD-7"],
    affaire_id: "9", affaire_reference: "AFF-9", affaire_references: ["AFF-9"], adresse_livraison_id: null,
    intercompany_request_id: null, intercompany_destination_snapshot: null, al_name: null, al_street: null,
    al_house_number: null, al_postal_code: null, al_city: null, al_country: null, date_creation: "2026-01-01",
    date_expedition: null, date_livraison: null, transporteur: null, tracking_number: null,
    commentaire_interne: null, commentaire_client: null, reception_nom_signataire: null,
    reception_date_signature: null, row_version: 3, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", created_by_id: null, created_by_username: null, created_by_name: null,
    created_by_surname: null, updated_by_id: null, updated_by_username: null, updated_by_name: null,
    updated_by_surname: null, ...overrides,
  }
}

describe("repoGetLivraisonDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
    mocks.proofs.mockResolvedValue([])
  })

  it("preserves query order and maps optional detail sections to their owning line", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [header()] })
      .mockResolvedValueOnce({ rows: [
        { id: "line-b", bon_livraison_id: deliveryId, ordre: 2, designation: "B", code_piece: null, quantite: "2.5", unite: null, commande_ligne_id: null, delai_client: null, created_at: "c", updated_at: "u", created_by_id: null, created_by_username: null, created_by_name: null, created_by_surname: null, updated_by_id: null, updated_by_username: null, updated_by_name: null, updated_by_surname: null },
        { id: "line-a", bon_livraison_id: deliveryId, ordre: 1, designation: "A", code_piece: "P", quantite: 1, unite: "EA", commande_ligne_id: "12", delai_client: null, created_at: "c", updated_at: "u", created_by_id: 4, created_by_username: "u", created_by_name: "N", created_by_surname: "S", updated_by_id: null, updated_by_username: null, updated_by_name: null, updated_by_surname: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: "alloc", bon_livraison_ligne_id: "line-a", article_id: "article", lot_id: null, lot_code: null, lot_status: null, magasin_id: null, magasin_code: null, emplacement_id: null, emplacement_code: null, location_id: null, stock_level_id: null, stock_batch_id: null, reservation_id: null, reservation_status: null, source_scope: "NEW", commande_numero: null, affaire_reference: null, article_reference: null, article_indice: null, article_version: null, quantite_commandee: null, quantite_restante: null, of_numero: null, mp_reference: null, tr_reference: null, verified_at: null, stock_movement_line_id: null, quantite: "1.25", unite: null, created_at: "c", updated_at: "u", created_by_id: null, created_by_username: null, created_by_name: null, created_by_surname: null, updated_by_id: null, updated_by_username: null, updated_by_name: null, updated_by_surname: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const detail = await repoGetLivraisonDetail(deliveryId)

    expect(detail?.bon_livraison.commande).toEqual({ id: 7, numero: "CMD-7" })
    expect(detail?.lignes.map(line => line.id)).toEqual(["line-b", "line-a"])
    expect(detail?.lignes[1]?.allocations).toMatchObject([{ id: "alloc", quantite: 1.25 }])
    expect(detail?.lignes[0]?.allocations).toEqual([])
    expect(mocks.query.mock.calls).toHaveLength(5)
    expect(mocks.proofs).toHaveBeenCalledWith(deliveryId, expect.anything())
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("returns null without child reads and releases the client when the header is absent", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    await expect(repoGetLivraisonDetail(deliveryId)).resolves.toBeNull()
    expect(mocks.query).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("keeps an invalid intercompany snapshot observable and still releases the client", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [header({ intercompany_destination_snapshot: { recipient_name: "x" } })] })
    await expect(repoGetLivraisonDetail(deliveryId)).rejects.toMatchObject({ code: "INTERCOMPANY_DELIVERY_DESTINATION_INVALID" })
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("keeps the write header lock and allocation-derived scope query in the stable shared owner", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [header()] })
    await expect(getHeader({ query } as never, deliveryId, { forUpdate: true })).resolves.toMatchObject({ id: deliveryId })
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE OF bl"), [deliveryId])
    expect(query.mock.calls[0]?.[0]).toContain("bon_livraison_ligne_allocations")
  })

  it("keeps frozen intercompany destinations valid for both read and write consumers", () => {
    expect(intercompanyDestinationAddress(deliveryId, {
      recipient_name: "Atelier partenaire",
      address_line_1: "1 rue des Forges",
      address_line_2: "Bâtiment A",
      postal_code: "69001",
      city: "Lyon",
      country_code: "FR",
    })).toMatchObject({
      id: `intercompany:${deliveryId}`,
      label: "Atelier partenaire, 1 rue des Forges, Bâtiment A, 69001 Lyon, FR",
    })
  })
})
