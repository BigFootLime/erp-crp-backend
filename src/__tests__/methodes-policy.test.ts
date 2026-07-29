import { describe, expect, it } from "vitest"

import { HttpError } from "../utils/httpError"
import {
  assertCostCenterSelectable,
  assertFamilySelectable,
  assertGammePublishable,
  assertMachineFamilyConsistent,
  assertMachineSelectable,
  assertPhaseAvailable,
  assertProgramNumberRequirement,
  assertRateSupersedes,
  buildOperationDesignation,
  collectPublicationBlockers,
  computeLabourCost,
  computeOperationTimes,
  freezeRate,
  hoursToMinutes,
  methodesCapabilitiesFor,
  minutesToHours,
  nextPhaseNumber,
  normalizeProgramNumber,
  pickApplicableRate,
  resolveOperationDesignation,
  roleHasMethodesCapability,
  suggestInsertPhase,
  type CostCenterRate,
  type CostCenterRef,
  type MachineFamilyRef,
  type MachineRef,
} from "../module/methodes/domain/methodes-policy"

const FAMILY_T: MachineFamilyRef = { code: "T", libelle: "Tournage CN", programme_requis: true, actif: true }
const FAMILY_F: MachineFamilyRef = { code: "F", libelle: "Fraisage CN", programme_requis: true, actif: true }
const FAMILY_TTRAD: MachineFamilyRef = {
  code: "TTRAD",
  libelle: "Tour conventionnel",
  programme_requis: false,
  actif: true,
}
const FAMILY_DECOUPE: MachineFamilyRef = { code: "DECOUPE", libelle: "Découpe", programme_requis: false, actif: true }

function expectHttpError(fn: () => unknown, code: string, status?: number): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).code).toBe(code)
    if (status !== undefined) expect((error as HttpError).status).toBe(status)
    return
  }
  throw new Error(`Aucune erreur levée, ${code} était attendu`)
}

/* -------------------------------------------------------------------------- */

describe("Méthodes — conversions de temps", () => {
  it("convertit les minutes saisies en heures décimales stockées", () => {
    expect(minutesToHours(60)).toBe(1)
    expect(minutesToHours(30)).toBe(0.5)
    expect(minutesToHours(90)).toBe(1.5)
    expect(minutesToHours(1)).toBeCloseTo(0.016667, 6)
    expect(minutesToHours(0)).toBe(0)
  })

  it("fait l'aller-retour minutes -> heures -> minutes sans dérive visible", () => {
    for (const minutes of [0, 0.1, 1, 7, 12.5, 45, 60, 137.25, 480]) {
      expect(hoursToMinutes(minutesToHours(minutes))).toBeCloseTo(minutes, 2)
    }
  })

  it("refuse une durée négative ou non numérique", () => {
    expectHttpError(() => minutesToHours(-1), "METHODES_NUMBER_NEGATIVE", 422)
    expectHttpError(() => minutesToHours(Number.NaN), "METHODES_NUMBER_INVALID", 422)
  })

  it("renvoie null pour une heure inconnue plutôt que 0", () => {
    expect(hoursToMinutes(null)).toBeNull()
    expect(hoursToMinutes(undefined)).toBeNull()
  })
})

describe("Méthodes — formules de temps", () => {
  it("temps_fabrication = temps_unitaire × quantité × coefficient", () => {
    const result = computeOperationTimes({
      temps_preparation: minutesToHours(30),
      temps_unitaire: minutesToHours(2),
      quantite_base: 10,
      coefficient: 1,
    })
    expect(hoursToMinutes(result.temps_fabrication)).toBeCloseTo(20, 2)
    expect(hoursToMinutes(result.temps_final)).toBeCloseTo(50, 2)
  })

  it("le coefficient ne s'applique QU'AU temps de fabrication (écart avec la formule historique)", () => {
    const input = {
      temps_preparation: 2,
      temps_unitaire: 0.1,
      quantite_base: 1,
      coefficient: 2,
    }
    const result = computeOperationTimes(input)
    // Formule cible : 2 + (0,1 × 1 × 2) = 2,2 h
    expect(result.temps_final).toBeCloseTo(2.2, 4)
    // Formule historique `(tp + tf×qte) × coef` aurait donné 4,2 h.
    expect((input.temps_preparation + input.temps_unitaire * input.quantite_base) * input.coefficient).toBeCloseTo(4.2, 4)
  })

  it("doubler la quantité de base double le temps de fabrication, pas la préparation", () => {
    const base = computeOperationTimes({
      temps_preparation: minutesToHours(45),
      temps_unitaire: minutesToHours(3),
      quantite_base: 10,
      coefficient: 1,
    })
    const doubled = computeOperationTimes({
      temps_preparation: minutesToHours(45),
      temps_unitaire: minutesToHours(3),
      quantite_base: 20,
      coefficient: 1,
    })
    expect(doubled.temps_fabrication).toBeCloseTo(base.temps_fabrication * 2, 4)
    expect(doubled.temps_final - base.temps_final).toBeCloseTo(base.temps_fabrication, 4)
  })

  it("un coût main-d'œuvre sans taux connu vaut null, jamais 0", () => {
    expect(computeLabourCost(2.5, null)).toBeNull()
    expect(computeLabourCost(2.1, 50)).toBe(105)
  })
})

describe("Méthodes — numérotation des phases", () => {
  it("produit 10, 20, 30… sur une gamme vierge puis remplie", () => {
    expect(nextPhaseNumber([])).toBe(10)
    expect(nextPhaseNumber([10])).toBe(20)
    expect(nextPhaseNumber([10, 20])).toBe(30)
  })

  it("repart de max(phase) + 10 même quand l'ordre de saisie est désordonné", () => {
    expect(nextPhaseNumber([30, 10, 20])).toBe(40)
    expect(nextPhaseNumber([10, null, 55, undefined])).toBe(65)
  })

  it("propose un entier libre pour une insertion, sans renuméroter l'existant", () => {
    expect(suggestInsertPhase(10, 20)).toBe(15)
    expect(suggestInsertPhase(null, 20)).toBe(10)
    expect(suggestInsertPhase(30, null)).toBe(40)
    expect(suggestInsertPhase(null, null)).toBe(10)
  })

  it("renvoie null quand aucun entier libre n'existe : la renumérotation reste explicite", () => {
    expect(suggestInsertPhase(10, 11)).toBeNull()
    expect(suggestInsertPhase(10, 10)).toBeNull()
  })

  it("refuse une phase déjà utilisée", () => {
    expectHttpError(() => assertPhaseAvailable([10, 20], 20), "PHASE_ALREADY_USED", 409)
    expect(() => assertPhaseAvailable([10, 20], 30)).not.toThrow()
    // Modification d'une opération qui garde sa propre phase.
    expect(() => assertPhaseAvailable([10, 20], 20, 20)).not.toThrow()
  })

  it("refuse une phase non entière ou hors bornes", () => {
    expectHttpError(() => assertPhaseAvailable([], 0), "PHASE_INVALID", 422)
    expectHttpError(() => assertPhaseAvailable([], 12.5), "PHASE_INVALID", 422)
  })
})

describe("Méthodes — numéro de programme", () => {
  it("normalise la saisie et traite le vide comme absent", () => {
    expect(normalizeProgramNumber("  o1234 ")).toBe("O1234")
    expect(normalizeProgramNumber("")).toBeNull()
    expect(normalizeProgramNumber("   ")).toBeNull()
    expect(normalizeProgramNumber(null)).toBeNull()
  })

  it("est obligatoire pour T et F", () => {
    expectHttpError(
      () => assertProgramNumberRequirement({ family: FAMILY_T, numero_programme: null }),
      "PROGRAM_NUMBER_REQUIRED",
      422
    )
    expectHttpError(
      () => assertProgramNumberRequirement({ family: FAMILY_F, numero_programme: null }),
      "PROGRAM_NUMBER_REQUIRED",
      422
    )
    expect(() => assertProgramNumberRequirement({ family: FAMILY_T, numero_programme: "O1234" })).not.toThrow()
  })

  it("reste facultatif pour TTRAD, FTRAD et Découpe", () => {
    expect(() => assertProgramNumberRequirement({ family: FAMILY_TTRAD, numero_programme: null })).not.toThrow()
    expect(() => assertProgramNumberRequirement({ family: FAMILY_DECOUPE, numero_programme: null })).not.toThrow()
    expect(() => assertProgramNumberRequirement({ family: null, numero_programme: null })).not.toThrow()
  })

  it("l'exigence vient du référentiel : une famille CN ajoutée plus tard l'hérite", () => {
    const nouvelleFamilleCn: MachineFamilyRef = {
      code: "RECTIF_CN",
      libelle: "Rectification CN",
      programme_requis: true,
      actif: true,
    }
    expectHttpError(
      () => assertProgramNumberRequirement({ family: nouvelleFamilleCn, numero_programme: null }),
      "PROGRAM_NUMBER_REQUIRED"
    )
  })
})

describe("Méthodes — machines et familles", () => {
  const machineActive: MachineRef = {
    id: "m1",
    code: "MCH-000199",
    name: "Hurco TMX8i 01",
    status: "ACTIVE",
    archived_at: null,
    valid_from: null,
    valid_to: null,
    machine_family_code: "T",
  }

  it("accepte une machine active", () => {
    expect(() => assertMachineSelectable(machineActive, "m1", "2026-07-29")).not.toThrow()
  })

  it("refuse une machine inactive, archivée ou hors validité", () => {
    expectHttpError(
      () => assertMachineSelectable({ ...machineActive, status: "OUT_OF_SERVICE" }, "m1", "2026-07-29"),
      "MACHINE_NOT_ACTIVE",
      422
    )
    expectHttpError(
      () => assertMachineSelectable({ ...machineActive, status: "IN_MAINTENANCE" }, "m1", "2026-07-29"),
      "MACHINE_NOT_ACTIVE"
    )
    expectHttpError(
      () => assertMachineSelectable({ ...machineActive, archived_at: "2026-01-01" }, "m1", "2026-07-29"),
      "MACHINE_ARCHIVED"
    )
    expectHttpError(
      () => assertMachineSelectable({ ...machineActive, valid_from: "2026-08-01" }, "m1", "2026-07-29"),
      "MACHINE_NOT_YET_VALID"
    )
    expectHttpError(
      () => assertMachineSelectable({ ...machineActive, valid_to: "2026-06-30" }, "m1", "2026-07-29"),
      "MACHINE_NO_LONGER_VALID"
    )
  })

  it("dit qu'une famille manque au lieu de la deviner", () => {
    expectHttpError(
      () => assertMachineFamilyConsistent({ ...machineActive, machine_family_code: null }, "T"),
      "MACHINE_FAMILY_MISSING",
      422
    )
    expectHttpError(() => assertMachineFamilyConsistent(machineActive, "F"), "MACHINE_FAMILY_MISMATCH")
    expect(() => assertMachineFamilyConsistent(machineActive, "T")).not.toThrow()
  })

  it("refuse une famille inconnue ou désactivée", () => {
    expectHttpError(() => assertFamilySelectable(null, "INCONNU"), "MACHINE_FAMILY_UNKNOWN")
    expectHttpError(() => assertFamilySelectable({ ...FAMILY_T, actif: false }, "T"), "MACHINE_FAMILY_INACTIVE")
    expect(() => assertFamilySelectable(null, null)).not.toThrow()
  })
})

describe("Méthodes — centres de frais et tarifs", () => {
  const cf: CostCenterRef = {
    id: "cf1",
    code: "CF-T01",
    designation: "Tournage CN",
    statut: "ACTIF",
    devise: "EUR",
    machine_family_code: "T",
    designation_auto: false,
    designation_modele: null,
  }

  const rates: CostCenterRate[] = [
    { id: "r1", taux_horaire: 45, devise: "EUR", date_effet: "2026-01-01", date_fin: "2026-06-30" },
    { id: "r2", taux_horaire: 50, devise: "EUR", date_effet: "2026-07-01", date_fin: null },
  ]

  it("refuse un centre de frais suspendu ou archivé", () => {
    expectHttpError(() => assertCostCenterSelectable({ ...cf, statut: "SUSPENDU" }, "cf1"), "COST_CENTER_NOT_ACTIVE")
    expectHttpError(() => assertCostCenterSelectable(null, "cf1"), "COST_CENTER_UNKNOWN")
    expect(() => assertCostCenterSelectable(cf, "cf1")).not.toThrow()
  })

  it("sélectionne le tarif applicable à une date, historique compris", () => {
    expect(pickApplicableRate(rates, "2026-03-15")?.taux_horaire).toBe(45)
    expect(pickApplicableRate(rates, "2026-07-29")?.taux_horaire).toBe(50)
    expect(pickApplicableRate(rates, "2025-12-31")).toBeNull()
  })

  it("un centre sans tarif ne fabrique pas un taux de 0 €/h", () => {
    const frozen = freezeRate(null)
    expect(frozen.taux_horaire_connu).toBeNull()
    expect(frozen.taux_horaire_source).toBe("ABSENT")
    expect(frozen.cf_rate_id).toBeNull()
    expect(computeLabourCost(3, frozen.taux_horaire_connu)).toBeNull()
  })

  it("gèle le tarif retenu sur l'opération", () => {
    const frozen = freezeRate(rates[1])
    expect(frozen.taux_horaire).toBe(50)
    expect(frozen.cf_rate_id).toBe("r2")
    expect(frozen.taux_horaire_source).toBe("CENTRE_FRAIS")
    expect(frozen.taux_horaire_effective_at).toBe("2026-07-01")
  })

  it("un nouveau tarif ne réécrit pas l'historique : sa date d'effet doit être postérieure", () => {
    expectHttpError(() => assertRateSupersedes(rates[1], "2026-07-01"), "RATE_DATE_NOT_AFTER_CURRENT", 409)
    expectHttpError(() => assertRateSupersedes(rates[1], "2026-06-01"), "RATE_DATE_NOT_AFTER_CURRENT")
    expectHttpError(() => assertRateSupersedes(null, "01/08/2026"), "RATE_DATE_INVALID")
    expect(() => assertRateSupersedes(rates[1], "2026-09-01")).not.toThrow()
    expect(() => assertRateSupersedes(null, "2026-09-01")).not.toThrow()
  })
})

describe("Méthodes — désignation d'opération", () => {
  const cfAuto: CostCenterRef = {
    id: "cf1",
    code: "CF-F01",
    designation: "Fraisage CN 3 axes",
    statut: "ACTIF",
    devise: "EUR",
    machine_family_code: "F",
    designation_auto: true,
    designation_modele: "{cf_designation} — {machine_code}",
  }

  it("génère depuis la règle du centre de frais quand la saisie est vide", () => {
    const resolved = resolveOperationDesignation({
      saisie: "",
      costCenter: cfAuto,
      values: { machine_code: "MCH-000193" },
    })
    expect(resolved.designation).toBe("Fraisage CN 3 axes — MCH-000193")
    expect(resolved.designation_auto).toBe(true)
  })

  it("la saisie manuelle gagne toujours sur la règle", () => {
    const resolved = resolveOperationDesignation({
      saisie: "Ébauche 3 axes",
      costCenter: cfAuto,
      values: { machine_code: "MCH-000193" },
    })
    expect(resolved.designation).toBe("Ébauche 3 axes")
    expect(resolved.designation_auto).toBe(false)
  })

  it("reste vide quand aucune règle n'existe : la publication tranchera", () => {
    const resolved = resolveOperationDesignation({
      saisie: null,
      costCenter: { ...cfAuto, designation_auto: false },
      values: {},
    })
    expect(resolved.designation).toBeNull()
  })

  it("ne laisse jamais un séparateur orphelin quand une variable est absente", () => {
    expect(buildOperationDesignation("{cf_designation} — {machine_code}", { cf_designation: "Découpe" })).toBe("Découpe")
    expect(buildOperationDesignation("{machine_code}", {})).toBeNull()
  })

  it("refuse une variable hors liste blanche", () => {
    expectHttpError(
      () => buildOperationDesignation("{taux_horaire}", {}),
      "DESIGNATION_TEMPLATE_VARIABLE_FORBIDDEN"
    )
  })

  it("neutralise les accolades et balises venues d'une valeur métier", () => {
    expect(buildOperationDesignation("{cf_designation}", { cf_designation: "<b>{injection}</b>" })).toBe("b injection /b")
  })
})

describe("Méthodes — publication d'une gamme", () => {
  const families = new Map<string, MachineFamilyRef>([
    ["T", FAMILY_T],
    ["DECOUPE", FAMILY_DECOUPE],
  ])

  it("refuse une opération sans désignation figée", () => {
    const blockers = collectPublicationBlockers(
      [{ id: "op1", phase: 10, designation: "", machine_family_code: "DECOUPE", numero_programme: null }],
      families
    )
    expect(blockers.map((blocker) => blocker.code)).toContain("OPERATION_DESIGNATION_REQUIRED")
  })

  it("refuse une opération T ou F sans numéro de programme", () => {
    const blockers = collectPublicationBlockers(
      [{ id: "op1", phase: 10, designation: "Tournage", machine_family_code: "T", numero_programme: null }],
      families
    )
    expect(blockers.map((blocker) => blocker.code)).toContain("PROGRAM_NUMBER_REQUIRED")
  })

  it("refuse une gamme vide", () => {
    expect(collectPublicationBlockers([], families).map((blocker) => blocker.code)).toEqual(["GAMME_EMPTY"])
  })

  it("remonte TOUS les blocages d'un coup", () => {
    const blockers = collectPublicationBlockers(
      [
        { id: "op1", phase: 10, designation: "", machine_family_code: "T", numero_programme: null },
        { id: "op2", phase: 20, designation: "Découpe barre", machine_family_code: "DECOUPE", numero_programme: null },
      ],
      families
    )
    expect(blockers).toHaveLength(2)
    expect(blockers.every((blocker) => blocker.operation_id === "op1")).toBe(true)
  })

  it("accepte une gamme complète", () => {
    expect(() =>
      assertGammePublishable(
        [
          { id: "op1", phase: 10, designation: "Tournage ébauche", machine_family_code: "T", numero_programme: "O1234" },
          { id: "op2", phase: 20, designation: "Découpe barre", machine_family_code: "DECOUPE", numero_programme: null },
        ],
        families
      )
    ).not.toThrow()
  })
})

describe("Méthodes — capacités RBAC", () => {
  it("refuse par défaut", () => {
    expect(roleHasMethodesCapability(null, "referentiel_read")).toBe(false)
    expect(roleHasMethodesCapability("", "gamme_operation_write")).toBe(false)
    expect(roleHasMethodesCapability("Employee", "gamme_operation_write")).toBe(false)
  })

  it("reconnaît le rôle effectif multi-rôles construit à la connexion", () => {
    // « Études-Méthodes » -> alias « Method | Responsable Programmation ».
    const methodes = "Method | Responsable Programmation"
    expect(roleHasMethodesCapability(methodes, "gamme_operation_write")).toBe(true)
    expect(roleHasMethodesCapability(methodes, "referentiel_write")).toBe(true)
    // Les Méthodes consomment le tarif, elles ne le fixent pas.
    expect(roleHasMethodesCapability(methodes, "tarif_write")).toBe(false)
    expect(roleHasMethodesCapability(methodes, "tarif_read")).toBe(true)
  })

  it("un opérateur atelier lit la gamme mais ne l'écrit pas", () => {
    const operateur = "Opérateur atelier"
    expect(roleHasMethodesCapability(operateur, "gamme_operation_read")).toBe(true)
    expect(roleHasMethodesCapability(operateur, "gamme_operation_write")).toBe(false)
    expect(roleHasMethodesCapability(operateur, "tarif_read")).toBe(false)
  })

  it("la gestion pose les taux, sans écrire les gammes", () => {
    const gestion = "Responsable RH | Comptabilite"
    expect(roleHasMethodesCapability(gestion, "tarif_write")).toBe(true)
    expect(roleHasMethodesCapability(gestion, "gamme_operation_write")).toBe(false)
  })

  it("expose la matrice complète pour l'interface", () => {
    const capabilities = methodesCapabilitiesFor("Directeur")
    expect(capabilities.gamme_publish).toBe(true)
    expect(Object.values(methodesCapabilitiesFor(null)).every((value) => value === false)).toBe(true)
  })
})
