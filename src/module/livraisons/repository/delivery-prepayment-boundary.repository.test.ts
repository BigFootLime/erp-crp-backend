import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
vi.mock("../../../config/database", () => ({ default: {} }))
import { proformaOrderSourceRevision, type ProformaOrderSource } from "../../facturation/repository/proforma-source.repository"
import { assertDeliveryPrepaymentBoundary, lockDeliveryPrepaymentRead, lockDeliveryPrepaymentSources, readDeliveryPrepaymentBoundary } from "./delivery-prepayment-boundary.repository"

const source: ProformaOrderSource = {
  allocation_id: 12, commande_id: "10", commande_ligne_id: "20", livraison_affaire_id: "30", client_id: "TEST-A",
  currency: "EUR", client_blocked: false, order_type: "FERME", affaire_status: "OUVERTE", delivery_address_id: null,
  contract_id: null, article_id: "TEST-PART", piece_technique_version_id: null, code_piece: "TEST-PART", designation: "Pièce recette",
  quantity: "100.000", unit: "u", unit_price_ex_tax: "10.0000", discount_percent: "0.0000", global_discount_percent: "0.0000",
  tax_rate_percent: "20.0000", billing_shares: [], prepayment_requirement: "PROFORMA", bound_proforma_id: "PF-A",
  bound_proforma_status: "ISSUED", bound_proforma_reference: "PF-TEST", affaire_reference: "AF-TEST",
}
const receipt = { id: "RECEIPT-A", paymentAllocationId: "PA-A", billedClientId: "TEST-A", currency: "EUR", amount: "1200.00",
  releasedAmount: "0.00", paymentStatus: "ALLOCATED", paymentWorkflowStatus: "ALLOCATED", reversalOfId: null, depositDocumentStatus: "ISSUED" }

function fake(args: {
  source?: Partial<ProformaOrderSource>
  receipt?: Partial<typeof receipt>
  duplicateLot?: boolean
  inconsistent?: boolean
  identityChanges?: boolean
  unbound?: boolean
  extraCompany?: boolean
} = {}) {
  const current = { ...source, bound_proforma_source_revision: proformaOrderSourceRevision(source, "EUR"), ...args.source }
  let identityReads = 0
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("source.id IS NULL OR")) {
      identityReads++
      const row = { line_id: "LINE-A", allocation_id: args.unbound ? null : args.identityChanges && identityReads > 1 ? "13" : "12", inconsistent: args.inconsistent ?? args.unbound ?? false }
      return { rows: args.duplicateLot ? [row, row] : [row] }
    }
    if (sql.includes("FROM public.commande_ligne_affaire_allocation allocation")) return { rows: [{ ...current, allocation_id: "12" }] }
    if (sql.includes("FROM public.proforma_billing_parts part")) {
      const funded = { id: "PART-A", proforma_id: "PF-A", allocation_id: "12", billed_client_id: "TEST-A", company_name: "Société recette A",
        currency: "EUR", required_amount: "1200.00", credits_amount: "0.00", receipts: [{ ...receipt, ...args.receipt }] }
      return { rows: args.extraCompany ? [funded, { ...funded, id: "PART-B", billed_client_id: "TEST-B", receipts: [] }] : [funded] }
    }
    return { rows: [] }
  })
  return { query, tx: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("BL prepayment from persisted evidence", () => {
  it("accepts cash-covered affairs and exposes a concise company breakdown, not raw receipts", async () => {
    const { tx } = fake()
    const result = await assertDeliveryPrepaymentBoundary(tx, "BL-A")
    expect(result.group_key).toBe("PROFORMA:pf-a")
    expect(result.blockers).toEqual([])
    expect(result.affairs[0]?.billing_parts[0]).toMatchObject({ status: "PAID", requiredAmount: "1200.00", paidAmount: "1200.00" })
    expect(result.affairs[0]?.billing_parts[0]).not.toHaveProperty("receipts")
  })
  it("one affair covered by two physical lots is counted once", async () => {
    const { tx, query } = fake({ duplicateLot: true })
    const result = await readDeliveryPrepaymentBoundary(tx, "BL-A")
    expect(result.affairs).toHaveLength(1)
    expect(result.blockers).toEqual([])
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM public.proforma_billing_parts part"))).toHaveLength(1)
  })
  it.each([{ paymentStatus: "REVERSED" }, { paymentStatus: "REJECTED" }, { releasedAmount: "1.00" }])(
    "rechecks a reversed, rejected or partially released payment at action time: %o", async changed => {
      const { tx } = fake({ receipt: changed })
      await expect(assertDeliveryPrepaymentBoundary(tx, "BL-A")).rejects.toMatchObject({ code: "DELIVERY_PREPAYMENT_BLOCKED",
        details: { blockers: expect.arrayContaining([expect.objectContaining({ code: "DELIVERY_PROFORMA_NOT_PAID", allocationId: 12 })]) } })
    })
  it("every billed company must be covered independently", async () => {
    const result = await readDeliveryPrepaymentBoundary(fake({ extraCompany: true }).tx, "BL-A")
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "DELIVERY_PROFORMA_NOT_PAID" }))
    expect(result.affairs[0]?.billing_parts.map(part => part.status)).toEqual(["PAID", "UNPAID"])
  })
  it("a changed commercial quantity invalidates the issued source even with sufficient cash", async () => {
    const result = await readDeliveryPrepaymentBoundary(fake({ source: { quantity: "80.000" } }).tx, "BL-A")
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "DELIVERY_PROFORMA_SOURCE_CHANGED" }))
  })
  it("requires an explicit decision for historical affairs", async () => {
    const result = await readDeliveryPrepaymentBoundary(fake({ source: { prepayment_requirement: "UNCONFIRMED" } }).tx, "BL-A")
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "DELIVERY_PREPAYMENT_UNCONFIRMED" }))
  })
  it("internal production stock transfers never require a customer proforma", async () => {
    const result = await readDeliveryPrepaymentBoundary(fake({ source: { order_type: "INTERNE", client_id: null,
      prepayment_requirement: "UNCONFIRMED", bound_proforma_id: null, bound_proforma_status: null } }).tx, "BL-A")
    expect(result.group_key).toBe("NONE")
    expect(result.blockers).toEqual([])
  })
  it("rejects unbound lines and mismatched reservation/affair identities", async () => {
    for (const args of [{ unbound: true }, { inconsistent: true }]) {
      const result = await readDeliveryPrepaymentBoundary(fake(args).tx, "BL-A")
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: "DELIVERY_PREPAYMENT_LINE_SOURCE_REQUIRED" }))
    }
  })
  it("locks Finance before source orders, contract binding and the BL; never locks the BL first", async () => {
    const { tx, query } = fake()
    await lockDeliveryPrepaymentSources(tx, "BL-A")
    const calls = query.mock.calls.map(([sql]) => sql)
    expect(calls[0]).toContain("fn_lock_delivery_prepayment_read_1268")
    const order = calls.findIndex(sql => sql.includes("ORDER BY command.id FOR UPDATE"))
    const contract = calls.findIndex(sql => sql.includes("delivery-contract-binding"))
    const header = calls.findIndex(sql => sql.includes("SELECT id FROM public.bon_livraison"))
    expect(order).toBeGreaterThan(0)
    expect(contract).toBeGreaterThan(order)
    expect(header).toBeGreaterThan(contract)
  })
  it("a stale serializable payment snapshot is an actionable conflict, not a server error", async () => {
    const tx = { query: vi.fn().mockRejectedValue({code:"40001"}) } as unknown as Pick<PoolClient,"query">
    await expect(lockDeliveryPrepaymentRead(tx)).rejects.toMatchObject({status:409,code:"DELIVERY_PREPAYMENT_REFRESH_REQUIRED"})
  })
  it("a concurrent BL source rewrite requests a fresh preparation rather than acquiring new orders out of sequence", async () => {
    const { tx } = fake({ identityChanges: true })
    await expect(lockDeliveryPrepaymentSources(tx, "BL-A")).rejects.toMatchObject({ code: "DELIVERY_PREPAYMENT_SOURCE_CHANGED" })
  })
})
