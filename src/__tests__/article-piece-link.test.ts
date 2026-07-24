import { describe, expect, it } from "vitest"

import { createArticleSchema } from "../module/stock/validators/stock.validators"

// GPAO B5 — invariant fondamental : un article fabriqué exige une pièce technique (et réciproquement,
// un article non-fabriqué ne peut pas en porter). Les scénarios link/doublon/create-from-piece/
// transaction bidirectionnelle/audit sont validés en E2E API sur cerp_test (B5.5).
const UUID = "11111111-1111-4111-8111-111111111111"

describe("B5 — cohérence article fabriqué ↔ pièce technique (schéma de création)", () => {
  it("rejette un article 'fabrique' SANS piece_technique_id", () => {
    expect(() =>
      createArticleSchema.parse({
        body: { designation: "Test", family_code: "FAB", article_category: "fabrique" },
      })
    ).toThrow()
  })

  it("accepte un article 'fabrique' AVEC piece_technique_id", () => {
    const r = createArticleSchema.parse({
      body: {
        designation: "Test",
        family_code: "FAB",
        article_category: "fabrique",
        piece_technique_id: UUID,
      },
    })
    expect(r.body.piece_technique_id).toBe(UUID)
    expect(r.body.article_category).toBe("fabrique")
  })

  it("rejette un piece_technique_id sur un article NON fabriqué ('achat')", () => {
    expect(() =>
      createArticleSchema.parse({
        body: {
          designation: "Test",
          family_code: "ACH",
          article_category: "achat",
          piece_technique_id: UUID,
        },
      })
    ).toThrow()
  })
})
