import { describe, expect, it } from "vitest"

import {
  addGammeOperationSchema,
  deleteGammeOperationSchema,
  operationTypeSchema,
  publishGammeSchema,
  updateGammeOperationSchema,
} from "../module/gammes/validators/gammes.validators"
import {
  addCostCenterRateSchema,
  createCostCenterSchema,
  createFamilySchema,
  listMachineOptionsQuerySchema,
} from "../module/methodes/validators/methodes.validators"
import { requiredRouteParam } from "../module/methodes/controllers/methodes.controller"
import { HttpError } from "../utils/httpError"

describe("Opération de gamme — contrat d'entrée", () => {
  it("accepte le type DECOUPE sans retirer les types existants", () => {
    expect(operationTypeSchema.options).toContain("DECOUPE")
    for (const type of ["TOURNAGE", "FRAISAGE", "SOUS_TRAITANCE", "CONTROLE", "AUTRE"]) {
      expect(operationTypeSchema.safeParse(type).success).toBe(true)
    }
  })

  it("rend la désignation optionnelle à la saisie", () => {
    const parsed = addGammeOperationSchema.safeParse({ body: { cf_id: "8f2f1c2e-5a1e-4a3b-9c1d-2f0e5b7a9c11" } })
    expect(parsed.success).toBe(true)
  })

  it("refuse un taux horaire saisi sur l'opération", () => {
    const parsed = addGammeOperationSchema.safeParse({ body: { designation: "Tournage", taux_horaire: 50 } })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("taux_horaire"))).toBe(true)
    }
  })

  it("refuse un temps total ou un coût main-d'œuvre imposé par le client", () => {
    expect(addGammeOperationSchema.safeParse({ body: { designation: "X", temps_total: 3 } }).success).toBe(false)
    expect(addGammeOperationSchema.safeParse({ body: { designation: "X", cout_mo: 12 } }).success).toBe(false)
    expect(addGammeOperationSchema.safeParse({ body: { designation: "X", temps_fabrication: 2 } }).success).toBe(false)
  })

  it("accepte la saisie en minutes comme le contrat historique en heures", () => {
    expect(
      addGammeOperationSchema.safeParse({
        body: { designation: "X", temps_preparation_minutes: 30, temps_unitaire_minutes: 2.5 },
      }).success
    ).toBe(true)
    expect(
      addGammeOperationSchema.safeParse({ body: { designation: "X", temps_preparation: 0.5, temps_cycle: 0.04 } }).success
    ).toBe(true)
  })

  it("normalise le code famille en majuscules", () => {
    const parsed = addGammeOperationSchema.safeParse({ body: { designation: "X", machine_family_code: "t" } })
    expect(parsed.success && parsed.data.body.machine_family_code).toBe("T")
  })

  it("refuse une phase à zéro ou non entière", () => {
    expect(addGammeOperationSchema.safeParse({ body: { designation: "X", numero_operation: 0 } }).success).toBe(false)
    expect(addGammeOperationSchema.safeParse({ body: { designation: "X", numero_operation: 12.5 } }).success).toBe(false)
    expect(addGammeOperationSchema.safeParse({ body: { designation: "X", numero_operation: 10 } }).success).toBe(true)
  })

  it("exige un verrou optimiste pour modifier, supprimer et publier", () => {
    expect(updateGammeOperationSchema.safeParse({ body: { designation: "X" } }).success).toBe(false)
    expect(
      updateGammeOperationSchema.safeParse({ body: { designation: "X", expected_updated_at: "2026-07-29T10:00:00Z" } })
        .success
    ).toBe(true)
    expect(deleteGammeOperationSchema.safeParse({ body: {} }).success).toBe(false)
    expect(publishGammeSchema.safeParse({ body: {} }).success).toBe(false)
  })
})

describe("Référentiels Méthodes — contrat d'entrée", () => {
  it("refuse les paramètres de route absents, multiples ou vides", () => {
    const req = (params: Record<string, string | string[] | undefined>) => ({ params }) as never

    expect(requiredRouteParam(req({ cfId: "  123  " }), "cfId")).toBe("  123  ")
    for (const params of [{}, { cfId: ["123", "456"] }, { cfId: "   " }]) {
      expect(() => requiredRouteParam(req(params), "cfId")).toThrow(HttpError)
      try {
        requiredRouteParam(req(params), "cfId")
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: "INVALID_ROUTE_PARAM" })
      }
    }
  })

  it("impose un code de famille en majuscules sans espace", () => {
    const ok = createFamilySchema.safeParse({ code: "rectif cn", libelle: "Rectification" })
    expect(ok.success).toBe(false)
    const parsed = createFamilySchema.safeParse({ code: "rectif_cn", libelle: "Rectification CN" })
    expect(parsed.success && parsed.data.code).toBe("RECTIF_CN")
    expect(parsed.success && parsed.data.programme_requis).toBe(false)
  })

  it("exige une provenance écrite pour tout taux horaire", () => {
    expect(addCostCenterRateSchema.safeParse({ taux_horaire: 50, date_effet: "2026-07-01" }).success).toBe(false)
    expect(
      addCostCenterRateSchema.safeParse({ taux_horaire: 50, date_effet: "2026-07-01", source: "Décision gestion 2026" })
        .success
    ).toBe(true)
    // Un taux à zéro ressemble à une donnée renseignée mais fausse la valorisation.
    expect(
      addCostCenterRateSchema.safeParse({ taux_horaire: 0, date_effet: "2026-07-01", source: "Poste non valorisé" })
        .success
    ).toBe(false)
  })

  it("refuse une date d'effet hors format ISO", () => {
    expect(
      addCostCenterRateSchema.safeParse({ taux_horaire: 50, date_effet: "01/07/2026", source: "Note" }).success
    ).toBe(false)
  })

  it("refuse une désignation automatique sans modèle", () => {
    expect(
      createCostCenterSchema.safeParse({ code: "CF-T01", designation: "Tournage CN", designation_auto: true }).success
    ).toBe(false)
    expect(
      createCostCenterSchema.safeParse({
        code: "CF-T01",
        designation: "Tournage CN",
        designation_auto: true,
        designation_modele: "{cf_designation}",
      }).success
    ).toBe(true)
  })

  it("renvoie les machines non sélectionnables par défaut, pour pouvoir les expliquer", () => {
    const parsed = listMachineOptionsQuerySchema.safeParse({})
    expect(parsed.success && parsed.data.include_unselectable).toBe(true)
    const filtered = listMachineOptionsQuerySchema.safeParse({ include_unselectable: "false" })
    expect(filtered.success && filtered.data.include_unselectable).toBe(false)
  })
})
