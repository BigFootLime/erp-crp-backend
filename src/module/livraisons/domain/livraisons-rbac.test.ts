import { describe, expect, it } from "vitest"

import { roleHasLivraisonCapability } from "./livraisons-rbac"

describe("livraisons RBAC", () => {
  it.each([
    ["Administrateur Systeme et Reseau", "ship"],
    ["Directeur", "cancel"],
    ["Responsable Logistique", "allocate"],
    ["Magasinier", "deliver"],
    ["Responsable Qualité", "read"],
    ["Secretaire", "proof_manage"],
  ] as const)("accorde %s -> %s", (role, capability) => {
    expect(roleHasLivraisonCapability(role, capability)).toBe(true)
  })

  it.each([
    [null, "read"],
    ["", "read"],
    ["Employe", "ship"],
    ["Responsable Qualité", "ship"],
    ["Comptable", "allocate"],
    ["Commercial", "cancel"],
  ] as const)("refuse %s -> %s", (role, capability) => {
    expect(roleHasLivraisonCapability(role, capability)).toBe(false)
  })
})
