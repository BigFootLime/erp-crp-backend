import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { copyGammeOperationsTx } from "./gammes.repository"

describe("shared operation copy for technical and routing revisions", () => {
  it("preserves programme, qualification, rate and duration fields and remaps finishing links", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("information_schema.columns")) {
        const fields = params?.[0] === "pieces_techniques_operations"
          ? ["piece_technique_id", "ordre", "phase", "numero_programme", "machine_id", "poste_id", "machine_family_code", "cf_id", "cf_rate_id", "taux_horaire_source", "tf_unit", "tp", "qte", "coef", "temps_fabrication"]
          : ["finition_id", "quantite", "notes"]
        return { rows: fields.map(column_name => ({ column_name })), rowCount: fields.length }
      }
      if (sql.includes("WITH copied AS")) return { rows: [{ old_id: "old-op-20", new_id: "new-op-20" }], rowCount: 1 }
      if (sql.includes("to_regclass")) return { rows: [{ present: true }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    expect(await copyGammeOperationsTx({ query } as unknown as Pick<PoolClient, "query">, "source", "target", 12)).toBe(1)
    const operationInsert = query.mock.calls.find(([sql]) => sql.includes("WITH copied AS"))!
    expect(operationInsert[1]).toEqual(["source", "target", 12])
    for (const field of ["numero_programme", "machine_family_code", "cf_rate_id", "taux_horaire_source", "temps_fabrication", "tf_unit", "qte", "coef"])
      expect(operationInsert[0]).toContain(`o."${field}"`)
    const finishInsert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.gamme_operation_finitions"))!
    expect(finishInsert[1]).toEqual(["old-op-20", "target", "new-op-20", 12])
    expect(query.mock.calls.some(([sql]) => /UPDATE public.pieces_techniques_operations|DELETE FROM/.test(sql))).toBe(false)
    expect(query.mock.calls[0][1]?.[1]).toEqual(expect.arrayContaining(["id", "gamme_id", "created_at", "updated_at", "created_by", "updated_by"]))
  })

  it("propagates a failed copy so the enclosing revision transaction can roll back", async () => {
    const query = vi.fn().mockRejectedValue(new Error("copy failed"))
    await expect(copyGammeOperationsTx({ query } as unknown as Pick<PoolClient, "query">, "source", "target", 12)).rejects.toThrow("copy failed")
  })
})
