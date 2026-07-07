import { describe, it, expect } from "vitest"
import { isValidVersionTransition } from "../module/pieces-techniques/services/versions.service"
import {
  createNextVersionSchema,
  createVersionSchema,
  versionStatusSchema,
} from "../module/pieces-techniques/validators/versions.validators"

// GPAO B2.1 — règles de cycle de vie des versions.
// (La règle "une seule APPLICABLE" est en plus garantie par l'index unique partiel DB
//  piece_technique_versions_one_applicable_uq — prouvé sur cerp_test.)

describe("Versions — transitions de statut", () => {
  it("autorise le parcours nominal BROUILLON → EN_VALIDATION → APPLICABLE → OBSOLETE", () => {
    expect(isValidVersionTransition("BROUILLON", "EN_VALIDATION")).toBe(true)
    expect(isValidVersionTransition("EN_VALIDATION", "APPLICABLE")).toBe(true)
    expect(isValidVersionTransition("APPLICABLE", "OBSOLETE")).toBe(true)
  })

  it("autorise le retour EN_VALIDATION → BROUILLON et same→same", () => {
    expect(isValidVersionTransition("EN_VALIDATION", "BROUILLON")).toBe(true)
    expect(isValidVersionTransition("BROUILLON", "BROUILLON")).toBe(true)
    expect(isValidVersionTransition("APPLICABLE", "APPLICABLE")).toBe(true)
  })

  it("interdit les sauts et sorties non permises", () => {
    expect(isValidVersionTransition("BROUILLON", "APPLICABLE")).toBe(false) // pas de saut de validation
    expect(isValidVersionTransition("APPLICABLE", "BROUILLON")).toBe(false) // une applicable ne redevient pas brouillon
    expect(isValidVersionTransition("APPLICABLE", "EN_VALIDATION")).toBe(false)
    expect(isValidVersionTransition("OBSOLETE", "BROUILLON")).toBe(false) // terminal
    expect(isValidVersionTransition("OBSOLETE", "APPLICABLE")).toBe(false)
  })
})

describe("Versions — validators", () => {
  it("exige un indice à la création", () => {
    expect(createVersionSchema.safeParse({ body: { indice: "A" } }).success).toBe(true)
    expect(createVersionSchema.safeParse({ body: {} }).success).toBe(false)
    expect(createVersionSchema.safeParse({ body: { indice: "" } }).success).toBe(false)
  })

  it("accepte les champs évolution/modification", () => {
    const parsed = createVersionSchema.safeParse({
      body: {
        indice: "B",
        plan_reference: "PL-4567",
        matiere_prevue: "Alu 7075",
        type_changement: "MODIFICATION",
        raison_changement: "Cote critique changée",
        impact_interchangeabilite: true,
        impact_parents: "Revoir l'ensemble X",
      },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.body.type_changement).toBe("MODIFICATION")
  })

  it("rejette un type_changement inconnu et un statut inconnu", () => {
    expect(createVersionSchema.safeParse({ body: { indice: "C", type_changement: "AUTRE" } }).success).toBe(false)
    expect(versionStatusSchema.safeParse({ body: { next_statut: "APPLICABLE" } }).success).toBe(true)
    expect(versionStatusSchema.safeParse({ body: { next_statut: "WRONG" } }).success).toBe(false)
  })

  it("create-next exige aussi un indice", () => {
    expect(createNextVersionSchema.safeParse({ body: { indice: "B", type_changement: "EVOLUTION" } }).success).toBe(true)
    expect(createNextVersionSchema.safeParse({ body: {} }).success).toBe(false)
  })
})
