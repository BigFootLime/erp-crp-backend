import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { repoRoot } from "../../../__tests__/helpers/repo-paths"

const source = readFileSync(resolve(repoRoot, "src/module/qualite/repository/quality-360.repository.ts"), "utf8")

describe("delivery lot release decision contract", () => {
  it("releases only a full, exact LOT_RELEASE decision and preserves the delivery/lot lock order", () => {
    expect(source).toContain('execution.trigger_type !== "LOT_RELEASE"')
    expect(source).toContain('decision.decision !== "FULL"')
    expect(source).toContain('decision.object_id !== execution.source_id')
    expect(source).toContain('decision.object_id !== execution.lot_id')
    expect(source.indexOf('`quality-delivery:${execution.bon_livraison_id}`')).toBeLessThan(
      source.indexOf('`quality-lot:${execution.lot_id}`')
    )
  })

  it("changes only QUARANTAINE to LIBERE with immutable lot, quality and audit evidence", () => {
    expect(source).toContain('if (row.lot_status !== "QUARANTAINE")')
    expect(source).toContain("UPDATE public.lots\n      SET lot_status = 'LIBERE'")
    expect(source).toContain("QUALITY_DELIVERY_RELEASED")
    expect(source).toContain("DELIVERY_LOT_RELEASED")
    expect(source).toContain("qualite.executions.delivery_lot.release")
  })

  it("runs the physical transition inside the same decision transaction before the durable receipt", () => {
    expect(source.indexOf("releaseQuarantinedLotForFullDeliveryDecision({")).toBeLessThan(
      source.indexOf("await saveReceipt({", source.indexOf("export async function repoDecideExecution"))
    )
  })
})
