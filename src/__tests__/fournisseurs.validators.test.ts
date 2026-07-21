import { describe, it, expect } from "vitest"
import {
  createAdresseSchema,
  createCatalogueSchema,
  createFournisseurSchema,
  createHomologationSchema,
  doublonQuerySchema,
  updateFournisseurSchema,
} from "../module/fournisseurs/validators/fournisseurs.validators"

// Pure Zod contract tests for #163 (no DB). Enforce the key invariants of the
// Fournisseur 360 request contract.
describe("fournisseurs validators (#163)", () => {
  it("create rejects a client-provided code (server-generated, immutable)", () => {
    const r = createFournisseurSchema.safeParse({ body: { nom: "ACME", code: "FOU-999" } })
    expect(r.success).toBe(false)
  })

  it("create accepts a minimal body and typed addresses", () => {
    const r = createFournisseurSchema.safeParse({
      body: { nom: "ACME", adresses: [{ type: "commande", city: "Lyon", is_primary: true }] },
    })
    expect(r.success).toBe(true)
  })

  it("create validates email format and coerces empty string to null", () => {
    expect(createFournisseurSchema.safeParse({ body: { nom: "X", email: "not-an-email" } }).success).toBe(false)
    const ok = createFournisseurSchema.safeParse({ body: { nom: "X", email: "" } })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.body.email).toBeNull()
  })

  it("update is tri-state (all optional), accepts expected_updated_at, rejects code", () => {
    expect(updateFournisseurSchema.safeParse({ body: {} }).success).toBe(true)
    expect(updateFournisseurSchema.safeParse({ body: { expected_updated_at: new Date().toISOString() } }).success).toBe(true)
    expect(updateFournisseurSchema.safeParse({ body: { code: "FOU-1" } }).success).toBe(false)
  })

  it("catalogue enforces the incoterm enum and requires designation + type", () => {
    expect(createCatalogueSchema.safeParse({ body: { type: "MATIERE", designation: "Acier", incoterm: "EXW" } }).success).toBe(true)
    expect(createCatalogueSchema.safeParse({ body: { type: "MATIERE", designation: "Acier", incoterm: "ZZZ" } }).success).toBe(false)
    expect(createCatalogueSchema.safeParse({ body: { type: "MATIERE" } }).success).toBe(false)
  })

  it("homologation defaults statut to a_qualifier and validates its enum", () => {
    const r = createHomologationSchema.safeParse({ body: {} })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.statut).toBe("a_qualifier")
    expect(createHomologationSchema.safeParse({ body: { statut: "invalide" } }).success).toBe(false)
    expect(createHomologationSchema.safeParse({ body: { valid_from: "not-a-date" } }).success).toBe(false)
  })

  it("adresse requires a valid type", () => {
    expect(createAdresseSchema.safeParse({ body: { type: "commande" } }).success).toBe(true)
    expect(createAdresseSchema.safeParse({ body: { type: "siege" } }).success).toBe(false)
  })

  it("doublon query passes through optional filters", () => {
    expect(doublonQuerySchema.safeParse({ siret: "123", tva: "FR1" }).success).toBe(true)
    expect(doublonQuerySchema.safeParse({}).success).toBe(true)
  })
})
