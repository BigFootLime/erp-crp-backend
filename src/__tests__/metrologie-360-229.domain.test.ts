// Tests du domaine Métrologie 360 (#229).
//
// Le domaine est pur : ces tests n'ouvrent aucune connexion, ne montent aucun
// serveur et couvrent la matrice réelle (catégories, états, échéances, unités,
// plages, criticités, droits, verdicts, fenêtres d'impact).

import { describe, it, expect } from "vitest";

import {
  assertEquipmentReleaseAllowed,
  assertEquipmentTransition,
  assertImpactClosureAllowed,
  assertImpactDecision,
  assertImpactTransition,
  assertManualVerdictOverride,
  assertOptimisticVersion,
  assertPlanContentMutable,
  assertPlanSelectableForExecution,
  assertPlanTransition,
  assertReleaseSeparation,
  assertVerdictSeparation,
  decideMetrologyReceipt,
  equipmentStateBlocksUsage,
  metrologyRequestHash,
  metrologySha256,
  normalizeMetrologyIdempotencyKey,
  roleHasMetrologyCapability,
  transitionRequiresRelease,
  verdictIsAdmissibleProof,
  verdictToLegacyCertificatResult,
  verdictTriggersQuarantine,
  METROLOGY_CAPABILITIES,
  type MetrologyEquipmentState,
} from "../module/metrologie/domain/metrology-policy";
import {
  addPeriod,
  assertScheduleOverrideAllowed,
  computeNextDueDate,
  deriveEffectiveState,
  evaluateDue,
  parseIsoDate,
  toIsoDate,
} from "../module/metrologie/domain/metrology-schedule";
import {
  convertValue,
  isKnownUnit,
  listSupportedUnits,
  resolveUnit,
  sameDimension,
  toBaseValue,
} from "../module/metrologie/domain/metrology-units";
import {
  buildInstrumentSnapshot,
  evaluateInstrumentEligibility,
  type MetrologyInstrumentState,
  type MetrologyUsageRequirement,
} from "../module/metrologie/domain/metrology-eligibility";
import {
  computeExecutionVerdict,
  evaluateMeasurement,
} from "../module/metrologie/domain/metrology-verdict";
import {
  computeImpactWindow,
  describeTruncation,
  IMPACT_ITEM_HARD_LIMIT,
  suggestImpactPriority,
} from "../module/metrologie/domain/metrology-impact";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const AT = new Date("2026-07-26T09:00:00.000Z");

function instrument(overrides: Partial<MetrologyInstrumentState> = {}): MetrologyInstrumentState {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    code: "MET-000001",
    designation: "Pied à coulisse 150",
    categorie_code: "PIED_A_COULISSE",
    sous_categorie_code: null,
    categorie_legacy: null,
    etat: "QUALIFIED",
    criticite: "NORMAL",
    deleted: false,
    unite: "mm",
    plage_min: 0,
    plage_max: 150,
    resolution: 0.01,
    mpe: 0.03,
    incertitude: 0.02,
    methodes: [],
    restrictions: null,
    exige_certificat: false,
    plan_version_id: "22222222-2222-4222-8222-222222222222",
    plan_version: 1,
    plan_blocking_strategy: "BLOCK",
    plan_alert_window_days: 30,
    next_due_date: "2026-12-31",
    last_proof_execution_id: "33333333-3333-4333-8333-333333333333",
    last_proof_date: "2025-12-31",
    last_proof_verdict: "CONFORME",
    has_valid_certificate: true,
    certificate_id: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

function requirement(
  overrides: Partial<MetrologyUsageRequirement> = {}
): MetrologyUsageRequirement {
  return {
    characteristic_key: "COTE_A",
    requires_instrument: true,
    instrument_category: null,
    method: null,
    unit: "mm",
    nominal: 20,
    tolerance_min: 19.9,
    tolerance_max: 20.1,
    requires_certificate: false,
    ...overrides,
  };
}

function evaluate(
  inst: MetrologyInstrumentState | null,
  req: Partial<MetrologyUsageRequirement> = {},
  policy = { block_on_overdue_critical: false }
) {
  return evaluateInstrumentEligibility({
    requirement: requirement(req),
    instrument: inst,
    at: AT,
    policy,
  });
}

/* -------------------------------------------------------------------------- */
/* 1) RBAC — refus par défaut                                                 */
/* -------------------------------------------------------------------------- */

describe("#229 RBAC métrologie", () => {
  it("refuse toute capacité à un rôle vide ou inconnu", () => {
    for (const capability of METROLOGY_CAPABILITIES) {
      expect(roleHasMetrologyCapability(null, capability)).toBe(false);
      expect(roleHasMetrologyCapability("", capability)).toBe(false);
      expect(roleHasMetrologyCapability("stagiaire-accueil", capability)).toBe(false);
      expect(roleHasMetrologyCapability("commercial", capability)).toBe(false);
    }
  });

  it("accorde toutes les capacités à l'administrateur", () => {
    for (const capability of METROLOGY_CAPABILITIES) {
      expect(roleHasMetrologyCapability("administrateur", capability)).toBe(true);
    }
  });

  it("donne à l'atelier la saisie mais jamais la validation ni la libération", () => {
    expect(roleHasMetrologyCapability("operateur atelier", "execution_record")).toBe(true);
    expect(roleHasMetrologyCapability("operateur atelier", "quarantine_set")).toBe(true);
    expect(roleHasMetrologyCapability("operateur atelier", "verdict_validate")).toBe(false);
    expect(roleHasMetrologyCapability("operateur atelier", "equipment_release")).toBe(false);
    expect(roleHasMetrologyCapability("operateur atelier", "impact_decide")).toBe(false);
    expect(roleHasMetrologyCapability("operateur atelier", "settings_manage")).toBe(false);
  });

  it("n'accorde aucun droit implicite au magasin, à l'ADV ni à la finance", () => {
    for (const role of ["magasinier", "adv", "assistante adv", "comptable", "finance"]) {
      for (const capability of METROLOGY_CAPABILITIES) {
        expect(roleHasMetrologyCapability(role, capability)).toBe(false);
      }
    }
  });

  it("réserve la décision d'impact à la qualité et à la direction", () => {
    expect(roleHasMetrologyCapability("responsable qualite", "impact_decide")).toBe(true);
    expect(roleHasMetrologyCapability("directeur", "impact_decide")).toBe(true);
    expect(roleHasMetrologyCapability("metrologue", "impact_decide")).toBe(false);
    expect(roleHasMetrologyCapability("methodes", "impact_decide")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2) Machine à états équipement                                              */
/* -------------------------------------------------------------------------- */

describe("#229 états d'équipement", () => {
  const usable: MetrologyEquipmentState[] = ["ACTIVE", "QUALIFIED"];
  const blocked: MetrologyEquipmentState[] = [
    "DRAFT",
    "SUSPENDED",
    "QUARANTINE",
    "OUT_OF_TOLERANCE",
    "UNDER_REPAIR",
    "RETIRED",
  ];

  it("classe correctement les états utilisables et bloquants", () => {
    for (const state of usable) expect(equipmentStateBlocksUsage(state)).toBe(false);
    for (const state of blocked) expect(equipmentStateBlocksUsage(state)).toBe(true);
  });

  it("refuse une transition vers le même état", () => {
    expect(() => assertEquipmentTransition("ACTIVE", "ACTIVE")).toThrowError(
      /déjà dans l'état ACTIVE/
    );
  });

  it("interdit toute sortie d'un équipement retiré", () => {
    for (const target of [...usable, ...blocked]) {
      if (target === "RETIRED") continue;
      expect(() => assertEquipmentTransition("RETIRED", target)).toThrowError(/interdite/);
    }
  });

  it("interdit le passage direct de quarantaine à ACTIVE", () => {
    expect(() => assertEquipmentTransition("QUARANTINE", "ACTIVE")).toThrowError(/interdite/);
    expect(() => assertEquipmentTransition("OUT_OF_TOLERANCE", "ACTIVE")).toThrowError(/interdite/);
  });

  it("autorise quarantaine → réparation → qualifié", () => {
    expect(() => assertEquipmentTransition("QUARANTINE", "UNDER_REPAIR")).not.toThrow();
    expect(() => assertEquipmentTransition("UNDER_REPAIR", "QUALIFIED")).not.toThrow();
  });

  it("exige une libération pour tout retour en service", () => {
    expect(transitionRequiresRelease("QUARANTINE", "QUALIFIED")).toBe(true);
    expect(transitionRequiresRelease("OUT_OF_TOLERANCE", "QUALIFIED")).toBe(true);
    expect(transitionRequiresRelease("UNDER_REPAIR", "QUALIFIED")).toBe(true);
    expect(transitionRequiresRelease("ACTIVE", "QUALIFIED")).toBe(false);
    expect(transitionRequiresRelease("QUARANTINE", "RETIRED")).toBe(false);
  });

  it("refuse une remise en service sans preuve conforme, sans réparation ou sans motif", () => {
    expect(() =>
      assertEquipmentReleaseAllowed({
        hasValidConformeProof: false,
        proofExecutionId: null,
        repairRequired: false,
        repairDone: false,
        reason: "Instrument revenu du fournisseur.",
      })
    ).toThrowError(/éléments obligatoires manquants/);

    expect(() =>
      assertEquipmentReleaseAllowed({
        hasValidConformeProof: true,
        proofExecutionId: "exec",
        repairRequired: true,
        repairDone: false,
        reason: "Instrument revenu du fournisseur.",
      })
    ).toThrowError(/éléments obligatoires manquants/);

    expect(() =>
      assertEquipmentReleaseAllowed({
        hasValidConformeProof: true,
        proofExecutionId: "exec",
        repairRequired: false,
        repairDone: false,
        reason: "court",
      })
    ).toThrowError(/éléments obligatoires manquants/);

    expect(() =>
      assertEquipmentReleaseAllowed({
        hasValidConformeProof: true,
        proofExecutionId: "exec",
        repairRequired: true,
        repairDone: true,
        reason: "Réparé chez le fabricant puis réétalonné conforme.",
      })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 3) Plans versionnés                                                        */
/* -------------------------------------------------------------------------- */

describe("#229 plans versionnés", () => {
  it("fige une version active ou archivée", () => {
    expect(() => assertPlanContentMutable("DRAFT")).not.toThrow();
    expect(() => assertPlanContentMutable("ACTIVE")).toThrowError(/nouvelle version/);
    expect(() => assertPlanContentMutable("ARCHIVED")).toThrowError(/nouvelle version/);
  });

  it("n'autorise que DRAFT→ACTIVE, DRAFT→ARCHIVED et ACTIVE→ARCHIVED", () => {
    expect(() => assertPlanTransition("DRAFT", "ACTIVE")).not.toThrow();
    expect(() => assertPlanTransition("DRAFT", "ARCHIVED")).not.toThrow();
    expect(() => assertPlanTransition("ACTIVE", "ARCHIVED")).not.toThrow();
    expect(() => assertPlanTransition("ACTIVE", "DRAFT")).toThrowError(/interdite/);
    expect(() => assertPlanTransition("ARCHIVED", "ACTIVE")).toThrowError(/interdite/);
  });

  it("n'exécute que sur une version active", () => {
    expect(() => assertPlanSelectableForExecution("ACTIVE")).not.toThrow();
    expect(() => assertPlanSelectableForExecution("DRAFT")).toThrowError(/active/);
    expect(() => assertPlanSelectableForExecution("ARCHIVED")).toThrowError(/active/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4) Échéances                                                               */
/* -------------------------------------------------------------------------- */

describe("#229 calcul d'échéance", () => {
  const plan = {
    periodicite_valeur: 12,
    periodicite_unite: "MONTH" as const,
    base_calcul: "LAST_PROOF" as const,
    alert_window_days: 30,
    effective_from: null,
  };

  it("borne le quantième lors d'un ajout de mois", () => {
    expect(toIsoDate(addPeriod(parseIsoDate("2026-01-31") as Date, 1, "MONTH"))).toBe("2026-02-28");
    expect(toIsoDate(addPeriod(parseIsoDate("2024-01-31") as Date, 1, "MONTH"))).toBe("2024-02-29");
    expect(toIsoDate(addPeriod(parseIsoDate("2026-03-31") as Date, 1, "MONTH"))).toBe("2026-04-30");
  });

  it("gère jours, semaines, mois et années", () => {
    const base = parseIsoDate("2026-07-26") as Date;
    expect(toIsoDate(addPeriod(base, 10, "DAY"))).toBe("2026-08-05");
    expect(toIsoDate(addPeriod(base, 2, "WEEK"))).toBe("2026-08-09");
    expect(toIsoDate(addPeriod(base, 6, "MONTH"))).toBe("2027-01-26");
    expect(toIsoDate(addPeriod(base, 2, "YEAR"))).toBe("2028-07-26");
  });

  it("dérive l'échéance de la dernière preuve", () => {
    const result = computeNextDueDate({
      plan,
      lastProofDate: "2026-01-15",
      fallbackDate: "2020-01-01",
    });
    expect(result).toMatchObject({ next_due_date: "2027-01-15", source: "LAST_PROOF" });
  });

  it("laisse le certificat externe primer sur le calcul interne", () => {
    const result = computeNextDueDate({
      plan,
      lastProofDate: "2026-01-15",
      certificateDueDate: "2026-09-30",
      fallbackDate: "2020-01-01",
    });
    expect(result).toMatchObject({ next_due_date: "2026-09-30", source: "CERTIFICATE" });
  });

  it("retombe sur la mise en service quand aucune preuve n'existe", () => {
    const result = computeNextDueDate({ plan, lastProofDate: null, fallbackDate: "2026-02-01" });
    expect(result).toMatchObject({ next_due_date: "2027-02-01", source: "FALLBACK" });
  });

  it("exige une date d'effet pour une échéance à date fixe", () => {
    const fixed = { ...plan, base_calcul: "FIXED_DATE" as const };
    expect(computeNextDueDate({ plan: fixed, lastProofDate: null, fallbackDate: null })).toMatchObject({
      next_due_date: null,
      source: "NONE",
    });
    expect(
      computeNextDueDate({
        plan: { ...fixed, effective_from: "2026-03-01" },
        lastProofDate: "2026-01-01",
        fallbackDate: null,
      })
    ).toMatchObject({ next_due_date: "2027-03-01", source: "EFFECTIVE_FROM" });
  });

  it("classe OK / DUE_SOON / OVERDUE / UNKNOWN", () => {
    expect(evaluateDue({ nextDueDate: null, alertWindowDays: 30, at: AT }).status).toBe("UNKNOWN");
    expect(evaluateDue({ nextDueDate: "2026-12-31", alertWindowDays: 30, at: AT }).status).toBe("OK");
    expect(evaluateDue({ nextDueDate: "2026-08-10", alertWindowDays: 30, at: AT }).status).toBe(
      "DUE_SOON"
    );
    const overdue = evaluateDue({ nextDueDate: "2026-07-01", alertWindowDays: 30, at: AT });
    expect(overdue.status).toBe("OVERDUE");
    expect(overdue.days_overdue).toBe(25);
  });

  it("laisse l'état de gouvernance primer sur le dérivé d'échéance", () => {
    const overdue = evaluateDue({ nextDueDate: "2026-01-01", alertWindowDays: 30, at: AT });
    expect(deriveEffectiveState({ storedState: "ACTIVE", due: overdue })).toBe("OVERDUE");
    expect(deriveEffectiveState({ storedState: "QUARANTINE", due: overdue })).toBe("QUARANTINE");
    expect(deriveEffectiveState({ storedState: "RETIRED", due: overdue })).toBe("RETIRED");
    expect(deriveEffectiveState({ storedState: "UNDER_REPAIR", due: overdue })).toBe("UNDER_REPAIR");
  });

  it("encadre strictement une échéance dérogatoire", () => {
    const base = {
      requestedDueDate: "2027-06-01",
      computedDueDate: "2027-01-15",
      requestedByUserId: 7,
    };
    expect(() =>
      assertScheduleOverrideAllowed({ ...base, reason: "trop court", approvedByUserId: 9 })
    ).toThrowError(/20 caractères/);
    expect(() =>
      assertScheduleOverrideAllowed({
        ...base,
        reason: "Report validé par la direction qualité après analyse de risque.",
        approvedByUserId: null,
      })
    ).toThrowError(/approbation/);
    expect(() =>
      assertScheduleOverrideAllowed({
        ...base,
        reason: "Report validé par la direction qualité après analyse de risque.",
        approvedByUserId: 7,
      })
    ).toThrowError(/propre dérogation/);
    expect(() =>
      assertScheduleOverrideAllowed({
        ...base,
        requestedDueDate: "2029-01-01",
        reason: "Report validé par la direction qualité après analyse de risque.",
        approvedByUserId: 9,
      })
    ).toThrowError(/dépasser d'un an/);
    expect(() =>
      assertScheduleOverrideAllowed({
        ...base,
        reason: "Report validé par la direction qualité après analyse de risque.",
        approvedByUserId: 9,
      })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 5) Unités                                                                  */
/* -------------------------------------------------------------------------- */

describe("#229 unités", () => {
  it("reconnaît les unités usuelles et refuse les inconnues", () => {
    for (const unit of ["mm", "cm", "m", "µm", "um", "in", "g", "kg", "°C", "K", "bar", "MPa", "N", "°"]) {
      expect(isKnownUnit(unit)).toBe(true);
    }
    for (const unit of ["banane", "", "mmm", "quintal"]) {
      expect(isKnownUnit(unit)).toBe(false);
    }
  });

  it("convertit dans la même dimension", () => {
    expect(convertValue(1, "m", "mm")).toEqual({ ok: true, value: 1000 });
    expect(convertValue(1000, "µm", "mm")).toEqual({ ok: true, value: 1 });
    expect(convertValue(1, "in", "mm")).toEqual({ ok: true, value: 25.4 });
    expect(convertValue(1, "kg", "g")).toEqual({ ok: true, value: 1000 });
    const kelvin = convertValue(273.15, "K", "°C");
    expect(kelvin.ok && Math.abs(kelvin.value - 0) < 1e-9).toBe(true);
  });

  it("refuse de comparer deux dimensions différentes", () => {
    expect(convertValue(1, "mm", "g")).toEqual({ ok: false, reason: "DIMENSION_MISMATCH" });
    expect(convertValue(1, "bar", "°C")).toEqual({ ok: false, reason: "DIMENSION_MISMATCH" });
    expect(sameDimension("mm", "in")).toBe(true);
    expect(sameDimension("mm", "kg")).toBe(false);
    expect(sameDimension("mm", null)).toBe(false);
  });

  it("signale une unité source ou cible inconnue", () => {
    expect(convertValue(1, "banane", "mm")).toEqual({ ok: false, reason: "UNKNOWN_SOURCE" });
    expect(convertValue(1, "mm", "banane")).toEqual({ ok: false, reason: "UNKNOWN_TARGET" });
  });

  it("normalise vers l'unité de base et expose le référentiel", () => {
    expect(toBaseValue(1, "m")).toBe(1000);
    expect(resolveUnit("UM")?.canonical).toBe("µm");
    expect(listSupportedUnits().length).toBeGreaterThan(10);
    expect(listSupportedUnits().some((u) => u.canonical === "mm" && u.dimension === "LENGTH")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 6) Éligibilité — la matrice                                                */
/* -------------------------------------------------------------------------- */

describe("#229 éligibilité d'un instrument", () => {
  it("n'exige rien quand la caractéristique n'exige pas d'instrument", () => {
    const result = evaluate(null, { requires_instrument: false });
    expect(result).toMatchObject({ eligible: true, code: "OK" });
  });

  it("bloque quand l'instrument est exigé mais absent", () => {
    expect(evaluate(null)).toMatchObject({ eligible: false, code: "INSTRUMENT_REQUIRED" });
  });

  it("bloque un instrument supprimé", () => {
    expect(evaluate(instrument({ deleted: true }))).toMatchObject({
      eligible: false,
      code: "INSTRUMENT_DELETED",
    });
  });

  it.each([
    ["QUARANTINE", "INSTRUMENT_QUARANTINE"],
    ["OUT_OF_TOLERANCE", "INSTRUMENT_OUT_OF_TOLERANCE"],
    ["UNDER_REPAIR", "INSTRUMENT_UNDER_REPAIR"],
    ["RETIRED", "INSTRUMENT_RETIRED"],
    ["DRAFT", "INSTRUMENT_NOT_QUALIFIED"],
    ["SUSPENDED", "INSTRUMENT_NOT_QUALIFIED"],
  ] as Array<[MetrologyEquipmentState, string]>)("bloque l'état %s", (etat, code) => {
    const result = evaluate(instrument({ etat }));
    expect(result.eligible).toBe(false);
    expect(result.code).toBe(code);
  });

  it.each(["ACTIVE", "QUALIFIED"] as MetrologyEquipmentState[])(
    "accepte l'état %s",
    (etat) => {
      expect(evaluate(instrument({ etat })).eligible).toBe(true);
    }
  );

  it("bloque un instrument hors catégorie attendue", () => {
    const result = evaluate(instrument(), { instrument_category: "MICROMETRE" });
    expect(result).toMatchObject({ eligible: false, code: "INSTRUMENT_OUT_OF_SCOPE" });
  });

  it("accepte la catégorie par code, sous-catégorie ou libellé historique", () => {
    expect(evaluate(instrument(), { instrument_category: "pied_a_coulisse" }).eligible).toBe(true);
    expect(
      evaluate(instrument({ sous_categorie_code: "MICROMETRE" }), {
        instrument_category: "MICROMETRE",
      }).eligible
    ).toBe(true);
    expect(
      evaluate(instrument({ categorie_code: null, categorie_legacy: "Micromètre" }), {
        instrument_category: "Micromètre",
      }).eligible
    ).toBe(true);
  });

  it("bloque une méthode non déclarée mais reste muet si l'instrument n'en déclare aucune", () => {
    expect(
      evaluate(instrument({ methodes: ["ISO-1", "ISO-2"] }), { method: "ISO-9" })
    ).toMatchObject({ eligible: false, code: "INSTRUMENT_METHOD_MISMATCH" });
    expect(evaluate(instrument({ methodes: ["ISO-1"] }), { method: "iso-1" }).eligible).toBe(true);
    expect(evaluate(instrument({ methodes: [] }), { method: "ISO-9" }).eligible).toBe(true);
  });

  it("bloque une incompatibilité d'unité et signale une unité inconnue", () => {
    expect(evaluate(instrument({ unite: "kg" }), { unit: "mm" })).toMatchObject({
      eligible: false,
      code: "INSTRUMENT_UNIT_MISMATCH",
    });
    const unknown = evaluate(instrument({ unite: "banane" }), { unit: "mm" });
    expect(unknown.eligible).toBe(true);
    expect(unknown.reasons.some((r) => r.code === "INSTRUMENT_UNIT_UNKNOWN")).toBe(true);
  });

  it("bloque une cote hors plage, y compris après conversion d'unité", () => {
    expect(
      evaluate(instrument(), { nominal: 400, tolerance_min: 399, tolerance_max: 401 })
    ).toMatchObject({ eligible: false, code: "INSTRUMENT_RANGE_MISMATCH" });

    // 300 mm exprimés en cm : 30 cm → hors plage 0–150 mm.
    expect(
      evaluate(instrument(), {
        unit: "cm",
        nominal: 30,
        tolerance_min: 29.9,
        tolerance_max: 30.1,
      })
    ).toMatchObject({ eligible: false, code: "INSTRUMENT_RANGE_MISMATCH" });

    // 100 mm exprimés en cm : 10 cm → dans la plage.
    expect(
      evaluate(instrument(), { unit: "cm", nominal: 10, tolerance_min: 9.9, tolerance_max: 10.1 })
        .eligible
    ).toBe(true);
  });

  it("avertit sur une aptitude dégradée sans jamais bloquer", () => {
    // IT = 0,02 mm ⇒ résolution max 0,002 mm, incertitude max ~0,0067 mm.
    const result = evaluate(instrument({ resolution: 0.01, incertitude: 0.02 }), {
      tolerance_min: 19.99,
      tolerance_max: 20.01,
    });
    expect(result.eligible).toBe(true);
    expect(result.severity).toBe("WARNING");
    expect(result.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining([
        "INSTRUMENT_RESOLUTION_INSUFFICIENT",
        "INSTRUMENT_UNCERTAINTY_EXCESSIVE",
      ])
    );
  });

  it("bloque quand une preuve documentaire exigée manque", () => {
    expect(
      evaluate(instrument({ has_valid_certificate: false }), { requires_certificate: true })
    ).toMatchObject({ eligible: false, code: "INSTRUMENT_CERTIFICATE_MISSING" });
    expect(
      evaluate(instrument({ has_valid_certificate: false, exige_certificat: true }))
    ).toMatchObject({ eligible: false, code: "INSTRUMENT_CERTIFICATE_MISSING" });
    expect(
      evaluate(instrument({ has_valid_certificate: true }), { requires_certificate: true }).eligible
    ).toBe(true);
  });

  it("avertit d'une échéance proche", () => {
    const result = evaluate(instrument({ next_due_date: "2026-08-10" }));
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.code === "INSTRUMENT_DUE_SOON")).toBe(true);
  });

  it("bloque un retard selon la stratégie du plan applicable", () => {
    const overdue = { next_due_date: "2026-01-01" };
    expect(
      evaluate(instrument({ ...overdue, plan_blocking_strategy: "BLOCK" }))
    ).toMatchObject({ eligible: false });
    const warn = evaluate(instrument({ ...overdue, plan_blocking_strategy: "WARN" }));
    expect(warn.eligible).toBe(true);
    expect(warn.severity).toBe("WARNING");
    const none = evaluate(instrument({ ...overdue, plan_blocking_strategy: "NONE" }));
    expect(none.eligible).toBe(true);
  });

  it("applique le réglage historique UNIQUEMENT aux instruments critiques échus", () => {
    const policy = { block_on_overdue_critical: true };
    // Critique + échu + stratégie NONE : le réglage reprend la main.
    expect(
      evaluate(
        instrument({
          next_due_date: "2026-01-01",
          criticite: "CRITIQUE",
          plan_blocking_strategy: "NONE",
        }),
        {},
        policy
      )
    ).toMatchObject({ eligible: false, code: "INSTRUMENT_OVERDUE_CRITICAL" });

    // Non critique + échu + stratégie NONE : le réglage NE bloque pas l'usine.
    expect(
      evaluate(
        instrument({
          next_due_date: "2026-01-01",
          criticite: "NORMAL",
          plan_blocking_strategy: "NONE",
        }),
        {},
        policy
      ).eligible
    ).toBe(true);

    // Critique mais À JOUR : le réglage ne bloque rien.
    expect(
      evaluate(instrument({ criticite: "CRITIQUE", next_due_date: "2026-12-31" }), {}, policy)
        .eligible
    ).toBe(true);
  });

  it("bloque un opérateur sans droit de saisie", () => {
    const result = evaluateInstrumentEligibility({
      requirement: requirement(),
      instrument: instrument(),
      at: AT,
      policy: { block_on_overdue_critical: false },
      rights: { canRecordMeasurement: false },
    });
    expect(result).toMatchObject({ eligible: false, code: "OPERATOR_NOT_ALLOWED" });
  });

  it("expose la restriction documentée sans bloquer", () => {
    const result = evaluate(instrument({ restrictions: "Ne pas utiliser au-delà de 100 mm." }));
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.code === "INSTRUMENT_RESTRICTED")).toBe(true);
  });

  it("cumule plusieurs raisons et retourne la première bloquante", () => {
    const result = evaluate(
      instrument({ etat: "QUARANTINE", next_due_date: "2026-01-01", restrictions: "Usage limité." })
    );
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("INSTRUMENT_QUARANTINE");
    expect(result.reasons.length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 7) Snapshot immuable                                                       */
/* -------------------------------------------------------------------------- */

describe("#229 snapshot instrument", () => {
  it("fige l'état, l'éligibilité, le plan et la preuve, sans donnée sensible", () => {
    const inst = instrument();
    const eligibility = evaluate(inst);
    const snapshot = buildInstrumentSnapshot({ instrument: inst, eligibility, at: AT });

    expect(snapshot).toMatchObject({
      snapshot_version: 2,
      instrument_id: inst.id,
      code: "MET-000001",
      etat: "QUALIFIED",
      eligible: true,
      plan_version: 1,
      next_due_date: "2026-12-31",
      last_proof_verdict: "CONFORME",
      used_at: AT.toISOString(),
    });

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["storage_path", "bucket", "token", "signature", "/srv/", "C:\\"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("conserve la raison de refus quand l'instrument était inéligible", () => {
    const inst = instrument({ etat: "OUT_OF_TOLERANCE" });
    const eligibility = evaluate(inst);
    const snapshot = buildInstrumentSnapshot({ instrument: inst, eligibility, at: AT });
    expect(snapshot.eligible).toBe(false);
    expect(snapshot.eligibility_code).toBe("INSTRUMENT_OUT_OF_TOLERANCE");
    expect(snapshot.reasons.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 8) Verdicts                                                                */
/* -------------------------------------------------------------------------- */

describe("#229 verdict d'exécution", () => {
  const criteria = { tolerance_min: 19.9, tolerance_max: 20.1, unite: "mm", min_points: null };

  function point(overrides: Record<string, unknown> = {}) {
    return {
      point_key: "P1",
      sample_no: 1,
      nominal: 20,
      tolerance_min: null,
      tolerance_max: null,
      measured: 20,
      unite: "mm",
      incertitude: null,
      ...overrides,
    };
  }

  it("juge un point dans, sous et au-dessus de la tolérance", () => {
    expect(evaluateMeasurement(point({ measured: 20 }), criteria).verdict).toBe("CONFORME");
    expect(evaluateMeasurement(point({ measured: 19.5 }), criteria).verdict).toBe("NON_CONFORME");
    expect(evaluateMeasurement(point({ measured: 20.5 }), criteria).verdict).toBe("NON_CONFORME");
  });

  it("rend inconclusif un point sans valeur ou sans critère", () => {
    expect(evaluateMeasurement(point({ measured: null }), criteria).verdict).toBe("INCONCLU");
    expect(
      evaluateMeasurement(point(), { tolerance_min: null, tolerance_max: null, unite: null, min_points: null })
        .verdict
    ).toBe("INCONCLU");
  });

  it("fait primer les bornes du point sur celles du plan", () => {
    const result = evaluateMeasurement(
      point({ measured: 25, tolerance_min: 24, tolerance_max: 26 }),
      criteria
    );
    expect(result.verdict).toBe("CONFORME");
  });

  it("convertit le critère du plan dans l'unité du relevé", () => {
    const inCm = evaluateMeasurement(point({ measured: 2, unite: "cm" }), criteria);
    expect(inCm.verdict).toBe("CONFORME");
    const outOfRange = evaluateMeasurement(point({ measured: 2.5, unite: "cm" }), criteria);
    expect(outOfRange.verdict).toBe("NON_CONFORME");
  });

  it("rend inconclusif un relevé dont l'unité n'est pas comparable au critère", () => {
    const result = evaluateMeasurement(point({ measured: 20, unite: "kg" }), criteria);
    expect(result.verdict).toBe("INCONCLU");
    expect(result.reason).toMatch(/Unités incompatibles/);
  });

  it("suffit d'un point hors tolérance pour rendre l'exécution non conforme", () => {
    const result = computeExecutionVerdict({
      operationType: "ETALONNAGE",
      measurements: [point(), point({ point_key: "P2", measured: 25 }), point({ point_key: "P3" })],
      criteria,
    });
    expect(result.verdict).toBe("NON_CONFORME");
    expect(result.counts).toMatchObject({ total: 3, conforme: 2, non_conforme: 1 });
  });

  it("est inconclusif sans relevé, et le dit différemment pour un ajustage", () => {
    expect(
      computeExecutionVerdict({ operationType: "ETALONNAGE", measurements: [], criteria }).explanation
    ).toMatch(/Aucun relevé/);
    expect(
      computeExecutionVerdict({ operationType: "AJUSTAGE", measurements: [], criteria }).explanation
    ).toMatch(/requalification/);
  });

  it("est inconclusif si la procédure exige plus de points", () => {
    const result = computeExecutionVerdict({
      operationType: "ETALONNAGE",
      measurements: [point()],
      criteria: { ...criteria, min_points: 3 },
    });
    expect(result.verdict).toBe("INCONCLU");
    expect(result.explanation).toMatch(/1 point\(s\) relevé\(s\) pour 3/);
  });

  it("mappe les verdicts vers l'enum historique des certificats", () => {
    expect(verdictToLegacyCertificatResult("CONFORME", "ETALONNAGE")).toBe("CONFORME");
    expect(verdictToLegacyCertificatResult("CONFORME_AVEC_RESTRICTION", "ETALONNAGE")).toBe("CONFORME");
    expect(verdictToLegacyCertificatResult("NON_CONFORME", "ETALONNAGE")).toBe("NON_CONFORME");
    expect(verdictToLegacyCertificatResult("INCONCLU", "ETALONNAGE")).toBe("NON_CONFORME");
    expect(verdictToLegacyCertificatResult("CONFORME", "AJUSTAGE")).toBe("AJUSTAGE");
    expect(verdictToLegacyCertificatResult("CONFORME", "REPARATION")).toBe("AJUSTAGE");
  });

  it("distingue preuve admissible et déclencheur de quarantaine", () => {
    expect(verdictIsAdmissibleProof("CONFORME")).toBe(true);
    expect(verdictIsAdmissibleProof("CONFORME_AVEC_RESTRICTION")).toBe(true);
    expect(verdictIsAdmissibleProof("INCONCLU")).toBe(false);
    expect(verdictIsAdmissibleProof("NON_CONFORME")).toBe(false);
    expect(verdictTriggersQuarantine("NON_CONFORME")).toBe(true);
    expect(verdictTriggersQuarantine("INCONCLU")).toBe(false);
  });

  it("interdit de transformer un hors tolérance en conformité par décision manuelle", () => {
    expect(() =>
      assertManualVerdictOverride({
        computed: "NON_CONFORME",
        requested: "CONFORME",
        justification: "Le relevé était faussé par la température ambiante mesurée.",
        evidenceCount: 1,
        requireEvidence: true,
      })
    ).toThrowError(/utilisez « conforme avec restriction »/);
  });

  it("exige justification et preuve pour tout verdict contraire au calcul", () => {
    expect(() =>
      assertManualVerdictOverride({
        computed: "CONFORME",
        requested: "CONFORME_AVEC_RESTRICTION",
        justification: "trop court",
        evidenceCount: 1,
        requireEvidence: true,
      })
    ).toThrowError(/20 caractères/);

    expect(() =>
      assertManualVerdictOverride({
        computed: "CONFORME",
        requested: "CONFORME_AVEC_RESTRICTION",
        justification: "Dérive constatée en haut de plage, emploi restreint à 0-100 mm.",
        evidenceCount: 0,
        requireEvidence: true,
      })
    ).toThrowError(/pièce jointe/);

    expect(() =>
      assertManualVerdictOverride({
        computed: "CONFORME",
        requested: "CONFORME",
        justification: null,
        evidenceCount: 0,
        requireEvidence: true,
      })
    ).not.toThrow();
  });

  it("interdit l'auto-validation, sauf étalonnage externe sans opérateur interne", () => {
    expect(() =>
      assertVerdictSeparation({ operatorUserId: 5, validatorUserId: 5, operationType: "VERIFICATION" })
    ).toThrowError(/ne peut pas valider lui-même/);
    expect(() =>
      assertVerdictSeparation({ operatorUserId: 5, validatorUserId: 9, operationType: "VERIFICATION" })
    ).not.toThrow();
    expect(() =>
      assertVerdictSeparation({ operatorUserId: null, validatorUserId: 5, operationType: "ETALONNAGE" })
    ).not.toThrow();
  });

  it("interdit l'auto-libération après intervention", () => {
    expect(() => assertReleaseSeparation({ operatorUserId: 4, releaserUserId: 4 })).toThrowError(
      /pas prononcer lui-même/
    );
    expect(() => assertReleaseSeparation({ operatorUserId: 4, releaserUserId: 8 })).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 9) Analyse d'impact                                                        */
/* -------------------------------------------------------------------------- */

describe("#229 analyse d'impact", () => {
  const eventAt = new Date("2026-07-26T10:00:00.000Z");
  const created = new Date("2024-01-01T00:00:00.000Z");

  it("borne la fenêtre à la dernière preuve conforme", () => {
    const window = computeImpactWindow({
      trigger: "VERDICT_NON_CONFORME",
      eventAt,
      lastConformeProofAt: new Date("2026-01-15T00:00:00.000Z"),
      equipmentCreatedAt: created,
    });
    expect(window.source).toBe("LAST_CONFORME_PROOF");
    expect(window.from.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(window.to).toBe(eventAt);
    expect(window.span_days).toBe(193);
  });

  it("remonte à l'entrée au registre quand aucune preuve conforme n'existe", () => {
    const window = computeImpactWindow({
      trigger: "VERDICT_NON_CONFORME",
      eventAt,
      lastConformeProofAt: null,
      equipmentCreatedAt: new Date("2025-09-01T00:00:00.000Z"),
    });
    expect(window.source).toBe("EQUIPMENT_CREATION");
    expect(window.method).toMatch(/Aucune preuve conforme/);
  });

  it("refuse une fenêtre non bornée", () => {
    expect(() =>
      computeImpactWindow({
        trigger: "MANUEL",
        eventAt,
        lastConformeProofAt: null,
        equipmentCreatedAt: new Date("2000-01-01T00:00:00.000Z"),
      })
    ).toThrowError(/dépasse 1826 jours/);
  });

  it("accepte une fenêtre approuvée justifiée et refuse les incohérentes", () => {
    expect(() =>
      computeImpactWindow({
        trigger: "MANUEL",
        eventAt,
        lastConformeProofAt: null,
        equipmentCreatedAt: created,
        approvedFrom: new Date("2026-06-01T00:00:00.000Z"),
        approvedTo: new Date("2026-05-01T00:00:00.000Z"),
        approvedReason: "Analyse restreinte au mois de juin après revue documentaire.",
      })
    ).toThrowError(/se termine avant/);

    expect(() =>
      computeImpactWindow({
        trigger: "MANUEL",
        eventAt,
        lastConformeProofAt: null,
        equipmentCreatedAt: created,
        approvedFrom: new Date("2026-06-01T00:00:00.000Z"),
        approvedTo: new Date("2026-07-01T00:00:00.000Z"),
        approvedReason: "court",
      })
    ).toThrowError(/20 caractères/);

    const window = computeImpactWindow({
      trigger: "MANUEL",
      eventAt,
      lastConformeProofAt: null,
      equipmentCreatedAt: created,
      approvedFrom: new Date("2026-06-01T00:00:00.000Z"),
      approvedTo: new Date("2026-07-01T00:00:00.000Z"),
      approvedReason: "Analyse restreinte au mois de juin après revue documentaire complète.",
    });
    expect(window.source).toBe("APPROVED_WINDOW");
  });

  it("propose une priorité guidée par l'exposition client", () => {
    const base = { controls: 5, work_orders: 2, lots: 1, deliveries: 0, truncated: false };
    expect(suggestImpactPriority({ volumes: base, criticite: "NORMAL" })).toBe("NORMAL");
    expect(suggestImpactPriority({ volumes: base, criticite: "CRITIQUE" })).toBe("HIGH");
    expect(
      suggestImpactPriority({ volumes: { ...base, deliveries: 3 }, criticite: "NORMAL" })
    ).toBe("HIGH");
    expect(
      suggestImpactPriority({ volumes: { ...base, deliveries: 3 }, criticite: "CRITIQUE" })
    ).toBe("CRITICAL");
    expect(
      suggestImpactPriority({ volumes: { ...base, controls: 0 }, criticite: "NORMAL" })
    ).toBe("LOW");
    expect(
      suggestImpactPriority({ volumes: { ...base, controls: 80 }, criticite: "NORMAL" })
    ).toBe("HIGH");
  });

  it("annonce explicitement une troncature au lieu de la taire", () => {
    expect(describeTruncation(2000, 2000)).toBeNull();
    expect(describeTruncation(2000, 5000)).toMatch(/2000 usages matérialisés sur 5000/);
    expect(IMPACT_ITEM_HARD_LIMIT).toBe(2000);
  });

  it("exige une décision motivée, jamais « à traiter »", () => {
    expect(() => assertImpactDecision({ decision: "PENDING", reason: "peu importe" })).toThrowError(
      /n'est pas une décision/
    );
    expect(() => assertImpactDecision({ decision: "HOLD_LOT", reason: "abc" })).toThrowError(
      /motif écrit/
    );
    expect(() =>
      assertImpactDecision({ decision: "HOLD_LOT", reason: "Lot mis en attente qualité." })
    ).not.toThrow();
  });

  it("ne clôt un dossier qu'avec zéro usage en attente et une conclusion écrite", () => {
    expect(() =>
      assertImpactClosureAllowed({ pendingItems: 3, conclusion: "Conclusion suffisamment longue." })
    ).toThrowError(/éléments obligatoires|décidé/);
    expect(() => assertImpactClosureAllowed({ pendingItems: 0, conclusion: "trop court" })).toThrowError(
      /décidé|obligatoires/
    );
    expect(() =>
      assertImpactClosureAllowed({
        pendingItems: 0,
        conclusion: "Aucun impact produit avéré après recontrôle de la totalité des lots.",
      })
    ).not.toThrow();
  });

  it("interdit la réouverture d'un dossier clos", () => {
    expect(() => assertImpactTransition("OPEN", "IN_REVIEW")).not.toThrow();
    expect(() => assertImpactTransition("IN_REVIEW", "CLOSED")).not.toThrow();
    expect(() => assertImpactTransition("CLOSED", "OPEN")).toThrowError(/interdite/);
    expect(() => assertImpactTransition("CANCELLED", "OPEN")).toThrowError(/interdite/);
  });
});

/* -------------------------------------------------------------------------- */
/* 10) Idempotence et concurrence                                             */
/* -------------------------------------------------------------------------- */

describe("#229 idempotence et verrou optimiste", () => {
  it("borne la clé d'idempotence", () => {
    expect(() => normalizeMetrologyIdempotencyKey(null)).toThrowError(/8 et 200/);
    expect(() => normalizeMetrologyIdempotencyKey("court")).toThrowError(/8 et 200/);
    expect(() => normalizeMetrologyIdempotencyKey("x".repeat(201))).toThrowError(/8 et 200/);
    expect(normalizeMetrologyIdempotencyKey("  clef-valide-1234  ")).toBe("clef-valide-1234");
  });

  it("produit une empreinte canonique indépendante de l'ordre des clés", () => {
    expect(metrologySha256({ a: 1, b: 2 })).toBe(metrologySha256({ b: 2, a: 1 }));
    expect(metrologySha256({ a: 1, b: undefined })).toBe(metrologySha256({ a: 1 }));
    expect(metrologyRequestHash("cmd", { a: 1 })).not.toBe(metrologyRequestHash("cmd2", { a: 1 }));
    expect(metrologyRequestHash("cmd", { a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distingue nouvelle commande, rejeu et conflit", () => {
    const hash = metrologyRequestHash("cmd", { a: 1 });
    expect(decideMetrologyReceipt(null, hash)).toBe("NEW");
    expect(decideMetrologyReceipt(hash, hash)).toBe("REPLAY");
    expect(decideMetrologyReceipt("autre", hash)).toBe("CONFLICT");
  });

  it("exige et vérifie expected_updated_at", () => {
    const current = "2026-07-26T09:00:00.000Z";
    expect(() =>
      assertOptimisticVersion({ expectedUpdatedAt: null, currentUpdatedAt: current })
    ).toThrowError(/obligatoire/);
    expect(() =>
      assertOptimisticVersion({ expectedUpdatedAt: "pas-une-date", currentUpdatedAt: current })
    ).toThrowError(/invalide/);
    expect(() =>
      assertOptimisticVersion({
        expectedUpdatedAt: "2026-07-26T08:00:00.000Z",
        currentUpdatedAt: current,
      })
    ).toThrowError(/modifié entre-temps/);
    expect(() =>
      assertOptimisticVersion({ expectedUpdatedAt: current, currentUpdatedAt: current })
    ).not.toThrow();
    expect(() =>
      assertOptimisticVersion({ expectedUpdatedAt: current, currentUpdatedAt: new Date(current) })
    ).not.toThrow();
  });
});
