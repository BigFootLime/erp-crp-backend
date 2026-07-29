// Qualification du parc machine (#233 / crp-systems-web#384).
//
// Ce que ces tests protègent :
//   - « à qualifier » reste une valeur ASSUMÉE (`null`), pas un oubli toléré ;
//   - une qualification sans motif écrit n'existe pas ;
//   - le verrou optimiste est obligatoire (deux Méthodes sur la même machine) ;
//   - qualifier est un droit d'écriture du référentiel, pas un droit de lecture.

import { describe, expect, it } from "vitest"

import {
  listMachinesQualificationQuerySchema,
  machineIdParamSchema,
  previewMachineQualificationQuerySchema,
  qualifyMachineSchema,
} from "../module/methodes/validators/methodes.validators"
import { methodesCapabilitiesFor, roleHasMethodesCapability } from "../module/methodes/domain/methodes-policy"

const MACHINE_ID = "33333333-3333-3333-3333-333333333333"
const CF_ID = "44444444-4444-4444-4444-444444444444"
const BASE = {
  machine_family_code: "F",
  cf_id: CF_ID,
  motif: "Centre d'usinage CN, confirmé par les Méthodes le 29/07/2026.",
  expected_updated_at: "2026-07-29T10:00:00.000Z",
}

describe("Qualification machine — contrat d'entrée", () => {
  it("accepte une qualification complète", () => {
    const parsed = qualifyMachineSchema.safeParse(BASE)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.machine_family_code).toBe("F")
      // Validité non fournie = pas de borne, pas une borne à aujourd'hui.
      expect(parsed.data.valid_from).toBeNull()
      expect(parsed.data.valid_to).toBeNull()
    }
  })

  it("accepte explicitement « à qualifier » : famille et centre de frais à null", () => {
    // Dé-qualifier est une décision légitime (machine reclassée, erreur corrigée).
    // Elle passe par le même chemin audité, motif compris.
    const parsed = qualifyMachineSchema.safeParse({ ...BASE, machine_family_code: null, cf_id: null })
    expect(parsed.success).toBe(true)
  })

  it("refuse une qualification sans motif ou avec un motif vide", () => {
    expect(qualifyMachineSchema.safeParse({ ...BASE, motif: undefined }).success).toBe(false)
    expect(qualifyMachineSchema.safeParse({ ...BASE, motif: "   " }).success).toBe(false)
    expect(qualifyMachineSchema.safeParse({ ...BASE, motif: "ok" }).success).toBe(false)
  })

  it("exige le verrou optimiste : deux Méthodes ne se écrasent pas en silence", () => {
    expect(qualifyMachineSchema.safeParse({ ...BASE, expected_updated_at: undefined }).success).toBe(false)
    expect(qualifyMachineSchema.safeParse({ ...BASE, expected_updated_at: "" }).success).toBe(false)
  })

  it("normalise le code de famille et refuse un code fantaisiste", () => {
    const parsed = qualifyMachineSchema.safeParse({ ...BASE, machine_family_code: " ttrad " })
    expect(parsed.success && parsed.data.machine_family_code).toBe("TTRAD")
    expect(qualifyMachineSchema.safeParse({ ...BASE, machine_family_code: "F raisage" }).success).toBe(false)
  })

  it("refuse une date de validité hors format AAAA-MM-JJ", () => {
    expect(qualifyMachineSchema.safeParse({ ...BASE, valid_from: "2026-01-01" }).success).toBe(true)
    expect(qualifyMachineSchema.safeParse({ ...BASE, valid_from: "01/01/2026" }).success).toBe(false)
  })

  it("refuse un identifiant de machine qui n'est pas un UUID", () => {
    expect(machineIdParamSchema.safeParse({ machineId: MACHINE_ID }).success).toBe(true)
    expect(machineIdParamSchema.safeParse({ machineId: "MCH-000193" }).success).toBe(false)
  })
})

describe("Qualification machine — parcours de lecture", () => {
  it("le filtre « à qualifier » est explicite et vaut false par défaut", () => {
    const parsed = listMachinesQualificationQuerySchema.safeParse({})
    expect(parsed.success && parsed.data.only_unqualified).toBe(false)
    expect(parsed.success && parsed.data.include_archived).toBe(false)

    const filtered = listMachinesQualificationQuerySchema.safeParse({ only_unqualified: "true" })
    expect(filtered.success && filtered.data.only_unqualified).toBe(true)
  })

  it("l'aperçu d'impact accepte une famille candidate, ou aucune", () => {
    expect(previewMachineQualificationQuerySchema.safeParse({}).success).toBe(true)
    const parsed = previewMachineQualificationQuerySchema.safeParse({ machine_family_code: "t" })
    expect(parsed.success && parsed.data.machine_family_code).toBe("T")
  })
})

describe("Qualification machine — droits", () => {
  it("lire le parc suffit en lecture de référentiel ; le qualifier exige l'écriture", () => {
    // Un opérateur atelier consulte le parc mais ne le requalifie pas.
    expect(roleHasMethodesCapability("Atelier", "referentiel_read")).toBe(true)
    expect(roleHasMethodesCapability("Atelier", "referentiel_write")).toBe(false)

    // Les Méthodes et la Programmation qualifient.
    expect(roleHasMethodesCapability("Method", "referentiel_write")).toBe(true)
    expect(roleHasMethodesCapability("Responsable Programmation", "referentiel_write")).toBe(true)
  })

  it("qualifier ne donne aucun droit sur les taux horaires", () => {
    // Séparation voulue : les Méthodes classent le parc, la gestion fixe les prix.
    const methodes = methodesCapabilitiesFor("Method")
    expect(methodes.referentiel_write).toBe(true)
    expect(methodes.tarif_write).toBe(false)
  })

  it("un rôle inconnu ou vide ne qualifie rien", () => {
    expect(roleHasMethodesCapability(null, "referentiel_write")).toBe(false)
    expect(roleHasMethodesCapability("", "referentiel_write")).toBe(false)
    expect(roleHasMethodesCapability("Stagiaire", "referentiel_write")).toBe(false)
  })
})
