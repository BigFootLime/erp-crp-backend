import { describe, expect, it } from "vitest"

import { addAchatSchema } from "../module/pieces-techniques/validators/pieces-techniques.validators"

// GPAO B4 — le write-path des achats accepte la catégorie type_achat (défaut DIVERS).
describe("addAchatSchema — type_achat (B4)", () => {
  it("défaut à DIVERS quand type_achat est absent (rétro-compatible)", () => {
    const r = addAchatSchema.parse({ body: { quantite: 1 } })
    expect(r.body.type_achat).toBe("DIVERS")
  })

  it("accepte les 7 catégories", () => {
    const cats = [
      "MATIERE",
      "VISSERIE",
      "COMPOSANT_CATALOGUE",
      "TRAITEMENT",
      "SOUS_TRAITANCE",
      "CERTIFICAT",
      "DIVERS",
    ] as const
    for (const t of cats) {
      const r = addAchatSchema.parse({ body: { quantite: 1, type_achat: t } })
      expect(r.body.type_achat).toBe(t)
    }
  })

  it("rejette une catégorie inconnue", () => {
    expect(() => addAchatSchema.parse({ body: { quantite: 1, type_achat: "BOGUS" } })).toThrow()
  })
})
