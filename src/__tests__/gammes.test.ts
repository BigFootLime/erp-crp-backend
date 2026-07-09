import { describe, it, expect } from "vitest"
import {
  addGammeOperationSchema,
  createGammeSchema,
  gammeStatutSchema,
  operationTypeSchema,
  reorderOperationsSchema,
  updateGammeSchema,
} from "../module/gammes/validators/gammes.validators"

// GPAO B2.2 — validators gammes + opérations. (Le flux DB réel — création gamme, opérations,
// reorder sans écraser phase, lisibilité des opérations legacy — est prouvé par le script
// verify SQL sur cerp_test.)

describe("Gammes — validators", () => {
  it("exige un nom de gamme", () => {
    expect(createGammeSchema.safeParse({ body: { nom: "Gamme principale" } }).success).toBe(true)
    expect(createGammeSchema.safeParse({ body: {} }).success).toBe(false)
  })

  it("statut par défaut BROUILLON + enum aligné sur la version", () => {
    const parsed = createGammeSchema.safeParse({ body: { nom: "G" } })
    expect(parsed.success && parsed.data.body.statut).toBe("BROUILLON")
    expect(gammeStatutSchema.options).toEqual(["BROUILLON", "EN_VALIDATION", "APPLICABLE", "OBSOLETE"])
    expect(createGammeSchema.safeParse({ body: { nom: "G", statut: "WRONG" } }).success).toBe(false)
  })

  it("update partiel + expected_updated_at", () => {
    expect(updateGammeSchema.safeParse({ body: { is_current: true, expected_updated_at: "2026-07-08" } }).success).toBe(true)
    expect(updateGammeSchema.safeParse({ body: {} }).success).toBe(true)
  })
})

describe("Gammes — opérations", () => {
  it("exige une désignation ; défauts temps/coef ; type_operation optionnel", () => {
    const ok = addGammeOperationSchema.safeParse({ body: { designation: "Tournage ébauche", type_operation: "TOURNAGE" } })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.body.qte).toBe(1)
      expect(ok.data.body.coef).toBe(1)
      expect(ok.data.body.numero_operation).toBe(10)
    }
    expect(addGammeOperationSchema.safeParse({ body: {} }).success).toBe(false)
  })

  it("découpage usinage — types d'opération attendus", () => {
    expect(operationTypeSchema.options).toEqual([
      "TOURNAGE",
      "FRAISAGE",
      "REPRISE",
      "CONTROLE",
      "LAVAGE",
      "SOUS_TRAITANCE",
      "EMBALLAGE",
      "AUTRE",
    ])
    expect(addGammeOperationSchema.safeParse({ body: { designation: "x", type_operation: "USINAGE" } }).success).toBe(false)
  })

  it("reorder exige une liste d'uuid", () => {
    expect(reorderOperationsSchema.safeParse({ body: { order: ["11111111-1111-1111-1111-111111111111"] } }).success).toBe(true)
    expect(reorderOperationsSchema.safeParse({ body: { order: [] } }).success).toBe(false)
    expect(reorderOperationsSchema.safeParse({ body: { order: ["not-a-uuid"] } }).success).toBe(false)
  })
})
