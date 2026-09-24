import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), audit: vi.fn() }))
vi.mock("../../../config/database", () => ({ default: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }))
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }))
import { repoCorrectPreparationStock, repoVerifyPreparationLot } from "./livraisons.repository"

beforeEach(() => vi.resetAllMocks())
describe("correction TR du stock OLD puis second contrôle", () => {
  it("remplace la référence courante, conserve la précédente dans l’audit et accepte le nouveau contrôle", async () => {
    let canonical = "6987"
    let references = ["6987"]
    const reservation = { reservation_id: "reservation", article_id: "article", lot_article_id: "article", lot_id: "lot", lot_code: "LOT-1194", tr_reference: canonical, mp_reference: null, source_scope: "OLD", of_id: null, of_numero: null, stock_batch_id: "batch", stock_level_id: "level", batch_qty_total: 15, batch_qty_reserved: 15, level_qty_total: 15, level_qty_reserved: 15, magasin_id: "warehouse", emplacement_id: 1, unite: "U" }
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO public.stock_reservation_corrections")) return { rows: [{ id: "correction" }], rowCount: 1 }
      if (sql.includes("FOR UPDATE OF r, sl, sb, l")) return { rows: [reservation] }
      if (sql.includes("SELECT reference_type, reference_value")) return { rows: references.map(reference_value => ({ reference_type: "TRAITEMENT_LOT", reference_value })) }
      if (sql.includes("DELETE FROM public.stock_lot_trace_references")) references = []
      if (sql.includes("INSERT INTO public.stock_lot_trace_references")) references.push(String(params[2]))
      if (sql.includes("UPDATE public.lots") && sql.includes("tr_reference = $3")) canonical = String(params[2])
      if (sql.includes("FOR UPDATE OF r, l")) return { rows: [{ ...reservation, qty_available: 2, tr_reference: references.join(" · ") || canonical }] }
      return { rows: [], rowCount: 1 }
    })
    const result = await repoCorrectPreparationStock({ body: { reservation_id: "reservation", tr_reference: "6988", reason: "Erreur de saisie du stock OLD" }, user_id: 21, idempotency_key: "test-tr-correction" })
    expect(references).toEqual(["6988"])
    expect(canonical).toBe("6988")
    expect(result.previous_snapshot.trace_references).toEqual([{ reference_type: "TRAITEMENT_LOT", reference_value: "6987" }])
    expect(result.corrected_snapshot.tr_reference).toBe("6988")
    expect(result.corrected_snapshot.verified_qty).toBe(0)
    await expect(repoVerifyPreparationLot({ reservation_id: "reservation", scanned_lot_code: "LOT-1194", qty: 2, tr_reference: "6988" }, 21)).resolves.toMatchObject({ snapshot: { tr_reference: "6988" }, verified_qty: 2 })
    await expect(repoVerifyPreparationLot({ reservation_id: "reservation", scanned_lot_code: "LOT-1194", qty: 2, tr_reference: "6987" }, 21)).rejects.toMatchObject({ code: "TR_SCAN_MISMATCH" })
    expect(mocks.audit).toHaveBeenCalled()
  })
})
