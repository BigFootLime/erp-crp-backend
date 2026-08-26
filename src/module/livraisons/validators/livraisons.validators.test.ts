import { describe, expect, it } from "vitest"

import { preparationCartQuerySchema } from "./livraisons.validators"

describe("preparationCartQuerySchema", () => {
  it("accepte les filtres de l'atelier BL", () => {
    expect(
      preparationCartQuerySchema.parse({
        q: "CMD-2026",
        client_id: "CLIENT-999",
        source_scope: "OLD",
        page: "2",
        pageSize: "50",
      })
    ).toEqual({
      q: "CMD-2026",
      client_id: "CLIENT-999",
      source_scope: "OLD",
      page: 2,
      pageSize: 50,
    })
  })

  it("refuse un filtre de base inconnu", () => {
    expect(() => preparationCartQuerySchema.parse({ source_scope: "LEGACY" })).toThrow()
  })
})
