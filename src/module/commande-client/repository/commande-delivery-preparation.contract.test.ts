import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { repoRoot } from "../../../__tests__/helpers/repo-paths"

const source = readFileSync(
  resolve(repoRoot, "src/module/commande-client/repository/commande-client.repository.ts"),
  "utf8"
)

describe("customer-order delivery preparation boundary", () => {
  it("reserves stock for Atelier BL without creating a BL during order launch", () => {
    const start = source.indexOf("export async function repoGenerateAffairesFromOrder")
    const end = source.indexOf("\ntype AffaireCreationInput", start)
    const lifecycle = source.slice(start, end)

    expect(lifecycle).toContain("reserveCommandeStockForLaterDelivery")
    expect(lifecycle).toContain("const bonLivraisonId = null")
    expect(lifecycle).not.toContain("createPreparedLivraisonForStock(")
  })
})
