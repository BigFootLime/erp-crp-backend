import { describe, expect, it } from "vitest";

import { HttpError } from "../utils/httpError";
import {
  assertDerogationApprovalSeparation,
  assertDerogationTransition,
  assertManualVerdictOverride,
  assertNcClosureAllowed,
  assertNcTransition,
  assertOptimisticVersion,
  assertPlanContentMutable,
  assertPlanSelectableForExecution,
  assertPlanTransition,
  assertPreviewFresh,
  assertQualityCapability,
  assertReleaseSeparation,
  canonicalJson,
  decideQualityReceipt,
  dispositionImpactsStock,
  dispositionRequiresDerogation,
  executionStatusForVerdict,
  legacyResultToVerdict,
  normalizeQualityIdempotencyKey,
  QUALITY_CAPABILITIES,
  qualityRequestHash,
  qualitySha256,
  roleHasQualityCapability,
  verdictToLegacyResult,
  type QualityCapability,
  type QualityNcStatus,
  type QualityPlanStatus,
} from "../module/qualite/domain/quality-policy";
import {
  assertCharacteristicSpec,
  assertNoApplicabilityOverlap,
  assertSnapshotIntegrity,
  buildPlanSnapshot,
  characteristicsFromSnapshot,
  computeExecutionVerdict,
  evaluateSample,
  isLotLevelCharacteristic,
  planScopeSpecificity,
  requiredSampleCount,
  resolveCharacteristicBounds,
  selectApplicablePlan,
  TRIGGER_SEMANTICS,
  type PlanApplicabilityScope,
  type PlanCandidate,
  type QualityCharacteristicSpec,
  type QualitySampleValue,
} from "../module/qualite/domain/quality-plan";
import {
  assertQualityEligibility,
  assertQuantityLedger,
  assertSourceRef,
  derogationStatusAfterConsumption,
  EMPTY_LEDGER,
  evaluateDerogationUsage,
  evaluateInstrumentUsage,
  evaluateQualityEligibility,
  evaluateReleaseRequest,
  isInstrumentOverdue,
  releasableQty,
  remainingUndisposedQty,
  type DerogationState,
  type EligibilityTarget,
  type InstrumentState,
  type QuantityLedger,
} from "../module/qualite/domain/quality-release";

const NOW = new Date("2026-07-25T10:00:00.000Z");

function httpErrorOf(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected an HttpError to be thrown");
}

function characteristic(
  overrides: Partial<QualityCharacteristicSpec> = {}
): QualityCharacteristicSpec {
  return {
    key: "DIM-01",
    position: 1,
    label: "Diamètre extérieur",
    characteristic_type: "DIMENSIONAL",
    value_kind: "NUMERIC",
    unit: "mm",
    nominal: 20,
    tolerance_min: -0.05,
    tolerance_max: 0.05,
    precision: 3,
    expected_boolean: null,
    allowed_values: null,
    criticality: "MAJOR",
    mandatory: true,
    requires_instrument: true,
    instrument_category: "MICROMETRE",
    method: "Micromètre 0-25",
    acceptance_rule: "Dans la tolérance",
    sampling: { rule: "FIXED", value: 3, justification: null },
    trigger: "FINAL",
    ...overrides,
  };
}

function sample(overrides: Partial<QualitySampleValue> = {}): QualitySampleValue {
  return {
    characteristic_key: "DIM-01",
    sample_no: 1,
    value_numeric: 20,
    value_boolean: null,
    value_text: null,
    unit: "mm",
    evidence_count: 0,
    ...overrides,
  };
}

function ledger(overrides: Partial<QuantityLedger> = {}): QuantityLedger {
  return { ...EMPTY_LEDGER, population: 100, controlled: 100, conforming: 100, ...overrides };
}

function scope(overrides: Partial<PlanApplicabilityScope> = {}): PlanApplicabilityScope {
  return {
    article_id: null,
    piece_technique_id: null,
    piece_version_id: null,
    famille_id: null,
    operation_code: null,
    fournisseur_id: null,
    trigger: "FINAL",
    effective_from: null,
    effective_to: null,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    id: "plan-1",
    code: "PC-2026-0001",
    version: 1,
    status: "PUBLISHED",
    scope: scope({ piece_technique_id: "piece-1" }),
    ...overrides,
  };
}

function instrument(overrides: Partial<InstrumentState> = {}): InstrumentState {
  return {
    id: "instr-1",
    code: "MIC-001",
    designation: "Micromètre 0-25",
    statut: "ACTIF",
    criticite: "CRITIQUE",
    categorie: "MICROMETRE",
    next_due_date: "2026-12-31",
    deleted: false,
    ...overrides,
  };
}

function derogation(overrides: Partial<DerogationState> = {}): DerogationState {
  return {
    id: "der-1",
    code: "DER-2026-0001",
    status: "APPROVED",
    article_id: null,
    piece_technique_id: null,
    piece_version_id: null,
    lot_id: "lot-1",
    of_id: null,
    commande_id: null,
    bon_livraison_id: null,
    max_qty: 50,
    unit: "pce",
    consumed_qty: 0,
    valid_from: "2026-07-01T00:00:00.000Z",
    valid_to: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function target(overrides: Partial<EligibilityTarget> = {}): EligibilityTarget {
  return {
    object_type: "LOT",
    object_id: "lot-1",
    label: "LOT-2026-0001",
    qty_requested: 10,
    lot_status: "LIBERE",
    qty_released: 100,
    qty_held: 0,
    qty_consumed: 0,
    open_nc_without_disposition: 0,
    pending_mandatory_controls: 0,
    derogation: null,
    ...overrides,
  };
}

/* ========================================================================== */
/* RBAC                                                                       */
/* ========================================================================== */

describe("#228 RBAC qualité — refus par défaut", () => {
  it.each(QUALITY_CAPABILITIES)("refuse un rôle vide pour '%s'", (capability) => {
    expect(roleHasQualityCapability(null, capability)).toBe(false);
    expect(roleHasQualityCapability(undefined, capability)).toBe(false);
    expect(roleHasQualityCapability("", capability)).toBe(false);
    expect(roleHasQualityCapability("   ", capability)).toBe(false);
  });

  it.each(QUALITY_CAPABILITIES)("refuse un rôle inconnu pour '%s'", (capability) => {
    expect(roleHasQualityCapability("Stagiaire", capability)).toBe(false);
    expect(roleHasQualityCapability("Client externe", capability)).toBe(false);
  });

  it("autorise le responsable qualité sur les décisions", () => {
    for (const capability of [
      "read",
      "plan_publish",
      "execution_run",
      "release_decide",
      "disposition_stock",
      "nc_manage",
      "capa_manage",
      "derogation_approve",
      "closure_verify",
    ] as QualityCapability[]) {
      expect(roleHasQualityCapability("Responsable Qualite", capability)).toBe(true);
    }
  });

  it("laisse l'atelier saisir sans lui donner la décision", () => {
    expect(roleHasQualityCapability("Chef d'atelier", "measurement_write")).toBe(true);
    expect(roleHasQualityCapability("Chef d'atelier", "execution_run")).toBe(true);
    expect(roleHasQualityCapability("Chef d'atelier", "release_decide")).toBe(false);
    expect(roleHasQualityCapability("Chef d'atelier", "disposition_stock")).toBe(false);
    expect(roleHasQualityCapability("Chef d'atelier", "derogation_approve")).toBe(false);
    expect(roleHasQualityCapability("Chef d'atelier", "plan_publish")).toBe(false);
  });

  it("réserve la gestion des réglages à l'administration et à la direction", () => {
    expect(roleHasQualityCapability("Administrateur Systeme et Reseau", "settings_manage")).toBe(true);
    expect(roleHasQualityCapability("Directeur industriel", "settings_manage")).toBe(true);
    expect(roleHasQualityCapability("Responsable Qualite", "settings_manage")).toBe(false);
  });

  it("lève un 403 explicite quand la capacité manque", () => {
    const err = httpErrorOf(() => assertQualityCapability("Secretaire", "release_decide"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("QUALITY_CAPABILITY_REQUIRED");
  });

  it("n'autorise pas une capacité inventée", () => {
    expect(roleHasQualityCapability("Responsable Qualite", "hack" as QualityCapability)).toBe(false);
  });
});

/* ========================================================================== */
/* Cycles de vie                                                              */
/* ========================================================================== */

describe("#228 cycle de vie des plans de contrôle", () => {
  const legal: Array<[QualityPlanStatus, QualityPlanStatus]> = [
    ["DRAFT", "IN_REVIEW"],
    ["DRAFT", "PUBLISHED"],
    ["DRAFT", "ARCHIVED"],
    ["IN_REVIEW", "DRAFT"],
    ["IN_REVIEW", "PUBLISHED"],
    ["IN_REVIEW", "ARCHIVED"],
    ["PUBLISHED", "ARCHIVED"],
  ];
  const illegal: Array<[QualityPlanStatus, QualityPlanStatus]> = [
    ["PUBLISHED", "DRAFT"],
    ["PUBLISHED", "IN_REVIEW"],
    ["PUBLISHED", "PUBLISHED"],
    ["ARCHIVED", "DRAFT"],
    ["ARCHIVED", "IN_REVIEW"],
    ["ARCHIVED", "PUBLISHED"],
    ["ARCHIVED", "ARCHIVED"],
    ["DRAFT", "DRAFT"],
  ];

  it.each(legal)("autorise %s → %s", (from, to) => {
    expect(() => assertPlanTransition(from, to)).not.toThrow();
  });

  it.each(illegal)("refuse %s → %s", (from, to) => {
    const err = httpErrorOf(() => assertPlanTransition(from, to));
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_PLAN_TRANSITION_FORBIDDEN");
  });

  it("interdit de modifier le contenu d'un plan publié ou archivé", () => {
    expect(() => assertPlanContentMutable("DRAFT")).not.toThrow();
    expect(() => assertPlanContentMutable("IN_REVIEW")).not.toThrow();
    expect(httpErrorOf(() => assertPlanContentMutable("PUBLISHED")).code).toBe("QUALITY_PLAN_IMMUTABLE");
    expect(httpErrorOf(() => assertPlanContentMutable("ARCHIVED")).code).toBe("QUALITY_PLAN_IMMUTABLE");
  });

  it("n'accepte qu'un plan publié pour une exécution", () => {
    expect(() => assertPlanSelectableForExecution("PUBLISHED")).not.toThrow();
    for (const status of ["DRAFT", "IN_REVIEW", "ARCHIVED"] as QualityPlanStatus[]) {
      expect(httpErrorOf(() => assertPlanSelectableForExecution(status)).code).toBe(
        "QUALITY_PLAN_NOT_PUBLISHED"
      );
    }
  });
});

describe("#228 cycle de vie des non-conformités", () => {
  const legal: Array<[QualityNcStatus, QualityNcStatus]> = [
    ["DRAFT", "OPEN"],
    ["DRAFT", "CANCELLED"],
    ["OPEN", "ANALYSIS"],
    ["OPEN", "DISPOSITION"],
    ["ANALYSIS", "DISPOSITION"],
    ["ANALYSIS", "ACTION_PLAN"],
    ["DISPOSITION", "ACTION_PLAN"],
    ["DISPOSITION", "VERIFICATION"],
    ["ACTION_PLAN", "VERIFICATION"],
    ["VERIFICATION", "CLOSED"],
    ["VERIFICATION", "ACTION_PLAN"],
    ["CLOSED", "OPEN"],
  ];
  const illegal: Array<[QualityNcStatus, QualityNcStatus]> = [
    ["DRAFT", "CLOSED"],
    ["OPEN", "CLOSED"],
    ["OPEN", "VERIFICATION"],
    ["ANALYSIS", "CLOSED"],
    ["ACTION_PLAN", "CLOSED"],
    ["CLOSED", "CLOSED"],
    ["CLOSED", "CANCELLED"],
    ["CANCELLED", "OPEN"],
    ["CANCELLED", "CLOSED"],
    ["DISPOSITION", "CLOSED"],
  ];

  it.each(legal)("autorise %s → %s", (from, to) => {
    expect(() => assertNcTransition(from, to)).not.toThrow();
  });

  it.each(illegal)("refuse %s → %s", (from, to) => {
    const err = httpErrorOf(() => assertNcTransition(from, to));
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_NC_TRANSITION_FORBIDDEN");
  });

  it("exige disposition, cause, CAPA vérifiées et preuve pour clôturer", () => {
    const complete = {
      hasDisposition: true,
      mandatoryCapaCount: 2,
      verifiedCapaCount: 2,
      hasRootCause: true,
      hasEffectivenessEvidence: true,
    };
    expect(() => assertNcClosureAllowed(complete)).not.toThrow();

    const cases: Array<[Partial<typeof complete>, string]> = [
      [{ hasDisposition: false }, "disposition"],
      [{ hasRootCause: false }, "root_cause"],
      [{ verifiedCapaCount: 1 }, "capa_verification"],
      [{ verifiedCapaCount: 0 }, "capa_verification"],
      [{ hasEffectivenessEvidence: false }, "effectiveness_evidence"],
    ];
    for (const [override, expectedMissing] of cases) {
      const err = httpErrorOf(() => assertNcClosureAllowed({ ...complete, ...override }));
      expect(err.status).toBe(422);
      expect(err.code).toBe("QUALITY_NC_CLOSURE_INCOMPLETE");
      expect(err.details.missing).toContain(expectedMissing);
    }
  });

  it("n'exige pas de CAPA vérifiée quand aucune CAPA n'est obligatoire", () => {
    expect(() =>
      assertNcClosureAllowed({
        hasDisposition: true,
        mandatoryCapaCount: 0,
        verifiedCapaCount: 0,
        hasRootCause: true,
        hasEffectivenessEvidence: true,
      })
    ).not.toThrow();
  });
});

describe("#228 cycle de vie des dérogations", () => {
  it.each([
    ["DRAFT", "SUBMITTED"],
    ["SUBMITTED", "APPROVED"],
    ["SUBMITTED", "REJECTED"],
    ["SUBMITTED", "DRAFT"],
    ["APPROVED", "CONSUMED"],
    ["APPROVED", "EXPIRED"],
    ["APPROVED", "REVOKED"],
    ["CONSUMED", "REVOKED"],
  ] as const)("autorise %s → %s", (from, to) => {
    expect(() => assertDerogationTransition(from, to)).not.toThrow();
  });

  it.each([
    ["DRAFT", "APPROVED"],
    ["DRAFT", "CONSUMED"],
    ["SUBMITTED", "CONSUMED"],
    ["REJECTED", "APPROVED"],
    ["REJECTED", "SUBMITTED"],
    ["EXPIRED", "APPROVED"],
    ["REVOKED", "APPROVED"],
    ["CONSUMED", "APPROVED"],
    ["APPROVED", "SUBMITTED"],
    ["APPROVED", "APPROVED"],
  ] as const)("refuse %s → %s", (from, to) => {
    const err = httpErrorOf(() => assertDerogationTransition(from, to));
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_DEROGATION_TRANSITION_FORBIDDEN");
  });
});

describe("#228 séparation des tâches", () => {
  it("interdit l'auto-libération et l'auto-approbation", () => {
    expect(httpErrorOf(() => assertReleaseSeparation({ executorUserId: 7, deciderUserId: 7 })).code).toBe(
      "QUALITY_SEPARATION_OF_DUTIES"
    );
    expect(
      httpErrorOf(() => assertDerogationApprovalSeparation({ requesterUserId: 7, approverUserId: 7 })).code
    ).toBe("QUALITY_SEPARATION_OF_DUTIES");
  });

  it("autorise deux acteurs distincts", () => {
    expect(() => assertReleaseSeparation({ executorUserId: 7, deciderUserId: 8 })).not.toThrow();
    expect(() =>
      assertDerogationApprovalSeparation({ requesterUserId: 7, approverUserId: 8 })
    ).not.toThrow();
  });

  it("n'assouplit la règle que par exception explicitement configurée", () => {
    expect(() =>
      assertReleaseSeparation({
        executorUserId: 7,
        deciderUserId: 7,
        policy: { allowSelfRelease: true, allowSelfDerogationApproval: false },
      })
    ).not.toThrow();
    expect(
      httpErrorOf(() =>
        assertDerogationApprovalSeparation({
          requesterUserId: 7,
          approverUserId: 7,
          policy: { allowSelfRelease: true, allowSelfDerogationApproval: false },
        })
      ).code
    ).toBe("QUALITY_SEPARATION_OF_DUTIES");
  });

  it("ne bloque pas quand l'exécutant est inconnu", () => {
    expect(() => assertReleaseSeparation({ executorUserId: null, deciderUserId: 7 })).not.toThrow();
  });
});

/* ========================================================================== */
/* Verdicts et compatibilité                                                  */
/* ========================================================================== */

describe("#228 mapping verdict ↔ enum historique", () => {
  it("conserve la compatibilité OK/NOK/PARTIAL", () => {
    expect(verdictToLegacyResult("CONFORME")).toBe("OK");
    expect(verdictToLegacyResult("NON_CONFORME")).toBe("NOK");
    expect(verdictToLegacyResult("PARTIEL")).toBe("PARTIAL");
    expect(verdictToLegacyResult("EN_ATTENTE")).toBeNull();
    expect(legacyResultToVerdict("OK")).toBe("CONFORME");
    expect(legacyResultToVerdict("NOK")).toBe("NON_CONFORME");
    expect(legacyResultToVerdict("PARTIAL")).toBe("PARTIEL");
    expect(legacyResultToVerdict(null)).toBe("EN_ATTENTE");
    expect(legacyResultToVerdict(undefined)).toBe("EN_ATTENTE");
  });

  it("dérive le statut d'exécution du verdict", () => {
    expect(executionStatusForVerdict("CONFORME")).toBe("VALIDATED");
    expect(executionStatusForVerdict("NON_CONFORME")).toBe("REJECTED");
    expect(executionStatusForVerdict("PARTIEL")).toBe("REJECTED");
    expect(executionStatusForVerdict("EN_ATTENTE")).toBe("IN_PROGRESS");
  });
});

describe("#228 verdict manuel contraire au calcul", () => {
  const base = {
    computed: "PARTIEL" as const,
    requested: "NON_CONFORME" as const,
    justification: "Écart confirmé sur les 3 pièces mesurées après recontrôle croisé.",
    evidenceCount: 1,
    requireEvidence: true,
  };

  it("accepte un verdict identique sans justification", () => {
    expect(() =>
      assertManualVerdictOverride({ ...base, requested: "PARTIEL", justification: null, evidenceCount: 0 })
    ).not.toThrow();
  });

  it("accepte un écart justifié et documenté", () => {
    expect(() => assertManualVerdictOverride(base)).not.toThrow();
  });

  it.each([
    [{ justification: null }, "QUALITY_VERDICT_OVERRIDE_JUSTIFICATION_REQUIRED"],
    [{ justification: "   " }, "QUALITY_VERDICT_OVERRIDE_JUSTIFICATION_REQUIRED"],
    [{ justification: "trop court" }, "QUALITY_VERDICT_OVERRIDE_JUSTIFICATION_REQUIRED"],
    [{ evidenceCount: 0 }, "QUALITY_VERDICT_OVERRIDE_EVIDENCE_REQUIRED"],
  ] as const)("refuse un écart incomplet (%o)", (override, code) => {
    const err = httpErrorOf(() => assertManualVerdictOverride({ ...base, ...override }));
    expect(err.status).toBe(422);
    expect(err.code).toBe(code);
  });

  it("interdit de transformer NON_CONFORME en CONFORME sans dérogation", () => {
    const err = httpErrorOf(() =>
      assertManualVerdictOverride({
        computed: "NON_CONFORME",
        requested: "CONFORME",
        justification: "Le client accepte la pièce malgré l'écart mesuré sur la cote 12H7.",
        evidenceCount: 2,
        requireEvidence: true,
      })
    );
    expect(err.code).toBe("QUALITY_VERDICT_OVERRIDE_FORBIDDEN");
  });
});

/* ========================================================================== */
/* Idempotence, empreintes et verrou optimiste                                */
/* ========================================================================== */

describe("#228 idempotence et empreintes", () => {
  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["short"],
    ["1234567"],
    ["x".repeat(201)],
  ])("refuse une Idempotency-Key invalide (%s)", (value) => {
    const err = httpErrorOf(() => normalizeQualityIdempotencyKey(value as string | null));
    expect(err.status).toBe(400);
    expect(err.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("accepte et normalise une clé valide", () => {
    expect(normalizeQualityIdempotencyKey("  release-2026-0001  ")).toBe("release-2026-0001");
    expect(normalizeQualityIdempotencyKey("x".repeat(200))).toHaveLength(200);
  });

  it("produit un JSON canonique indépendant de l'ordre des clés", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(qualitySha256({ b: 1, a: 2 })).toBe(qualitySha256({ a: 2, b: 1 }));
  });

  it("ignore les clés indéfinies mais distingue null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }));
  });

  it("normalise un timestamptz node-postgres avant et après persistance JSONB", () => {
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const materialized = { published_at: timestamp };
    const persisted = JSON.parse(JSON.stringify(materialized)) as { published_at: string };

    expect(canonicalJson(materialized)).toBe(canonicalJson(persisted));
    expect(qualitySha256(materialized)).toBe(qualitySha256(persisted));
  });

  it("préserve l'ordre des tableaux", () => {
    expect(qualitySha256([1, 2])).not.toBe(qualitySha256([2, 1]));
  });

  it("produit une empreinte SHA-256 hexadécimale de 64 caractères", () => {
    expect(qualityRequestHash("quality.release.confirm", { qty: 10 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distingue rejeu et conflit d'Idempotency-Key", () => {
    const hash = qualityRequestHash("quality.release.confirm", { qty: 10 });
    expect(decideQualityReceipt(null, hash)).toBe("NEW");
    expect(decideQualityReceipt(undefined, hash)).toBe("NEW");
    expect(decideQualityReceipt("", hash)).toBe("NEW");
    expect(decideQualityReceipt(hash, hash)).toBe("REPLAY");
    expect(decideQualityReceipt("f".repeat(64), hash)).toBe("CONFLICT");
  });

  it("exige un aperçu frais avant une décision", () => {
    const hash = qualitySha256({ qty: 10 });
    expect(() => assertPreviewFresh({ expectedHash: hash, currentHash: hash })).not.toThrow();
    expect(httpErrorOf(() => assertPreviewFresh({ expectedHash: null, currentHash: hash })).code).toBe(
      "QUALITY_PREVIEW_REQUIRED"
    );
    const stale = httpErrorOf(() =>
      assertPreviewFresh({ expectedHash: "a".repeat(64), currentHash: hash })
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("QUALITY_PREVIEW_STALE");
  });

  it("applique le verrou optimiste sur expected_updated_at", () => {
    const current = "2026-07-25T10:00:00.000Z";
    expect(() =>
      assertOptimisticVersion({ expectedUpdatedAt: current, currentUpdatedAt: current })
    ).not.toThrow();
    expect(() =>
      assertOptimisticVersion({ expectedUpdatedAt: current, currentUpdatedAt: new Date(current) })
    ).not.toThrow();
    expect(
      httpErrorOf(() => assertOptimisticVersion({ expectedUpdatedAt: null, currentUpdatedAt: current })).code
    ).toBe("QUALITY_EXPECTED_VERSION_REQUIRED");
    expect(
      httpErrorOf(() => assertOptimisticVersion({ expectedUpdatedAt: "nope", currentUpdatedAt: current }))
        .code
    ).toBe("QUALITY_EXPECTED_VERSION_INVALID");
    const conflict = httpErrorOf(() =>
      assertOptimisticVersion({
        expectedUpdatedAt: "2026-07-25T09:59:59.000Z",
        currentUpdatedAt: current,
      })
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("QUALITY_VERSION_CONFLICT");
  });
});

/* ========================================================================== */
/* Dispositions                                                               */
/* ========================================================================== */

describe("#228 dispositions qualité", () => {
  it("n'écrit un mouvement de stock que pour le rebut et le retour fournisseur", () => {
    expect(dispositionImpactsStock("SCRAP")).toBe(true);
    expect(dispositionImpactsStock("RETURN_SUPPLIER")).toBe(true);
    for (const type of ["HOLD", "RELEASE", "USE_AS_IS", "REWORK", "SORT", "RECHECK"] as const) {
      expect(dispositionImpactsStock(type)).toBe(false);
    }
  });

  it("exige une dérogation pour l'acceptation en l'état", () => {
    expect(dispositionRequiresDerogation("USE_AS_IS")).toBe(true);
    expect(dispositionRequiresDerogation("RELEASE")).toBe(false);
  });
});

/* ========================================================================== */
/* Caractéristiques, tolérances et échantillonnage                            */
/* ========================================================================== */

describe("#228 tolérances : sémantique historique préservée", () => {
  it("traite tolerance_min/max comme des écarts quand un nominal existe", () => {
    expect(resolveCharacteristicBounds({ nominal: 20, tolerance_min: -0.05, tolerance_max: 0.05 })).toEqual({
      min: 19.95,
      max: 20.05,
    });
  });

  it("traite tolerance_min/max comme des bornes absolues sans nominal", () => {
    expect(resolveCharacteristicBounds({ nominal: null, tolerance_min: 10, tolerance_max: 12 })).toEqual({
      min: 10,
      max: 12,
    });
  });

  it("supporte une borne unique", () => {
    expect(resolveCharacteristicBounds({ nominal: 20, tolerance_min: null, tolerance_max: 0.1 })).toEqual({
      min: null,
      max: 20.1,
    });
    expect(resolveCharacteristicBounds({ nominal: null, tolerance_min: 5, tolerance_max: null })).toEqual({
      min: 5,
      max: null,
    });
  });
});

describe("#228 validation d'une caractéristique de plan", () => {
  it("accepte une caractéristique numérique complète", () => {
    expect(() => assertCharacteristicSpec(characteristic())).not.toThrow();
  });

  const invalid: Array<[string, Partial<QualityCharacteristicSpec>, string]> = [
    ["clé vide", { key: "  " }, "QUALITY_CHARACTERISTIC_KEY_REQUIRED"],
    ["position 0", { position: 0 }, "QUALITY_CHARACTERISTIC_POSITION_INVALID"],
    ["position négative", { position: -3 }, "QUALITY_CHARACTERISTIC_POSITION_INVALID"],
    ["position décimale", { position: 1.5 }, "QUALITY_CHARACTERISTIC_POSITION_INVALID"],
    ["libellé vide", { label: "" }, "QUALITY_CHARACTERISTIC_LABEL_REQUIRED"],
    ["nominal NaN", { nominal: Number.NaN }, "QUALITY_CHARACTERISTIC_NUMBER_INVALID"],
    ["nominal Infinity", { nominal: Number.POSITIVE_INFINITY }, "QUALITY_CHARACTERISTIC_NUMBER_INVALID"],
    ["tolérance -Infinity", { tolerance_min: Number.NEGATIVE_INFINITY }, "QUALITY_CHARACTERISTIC_NUMBER_INVALID"],
    ["précision NaN", { precision: Number.NaN }, "QUALITY_CHARACTERISTIC_NUMBER_INVALID"],
    [
      "numérique sans tolérance",
      { tolerance_min: null, tolerance_max: null },
      "QUALITY_CHARACTERISTIC_TOLERANCE_REQUIRED",
    ],
    [
      "tolérance inversée",
      { nominal: null, tolerance_min: 12, tolerance_max: 10 },
      "QUALITY_CHARACTERISTIC_TOLERANCE_RANGE",
    ],
    ["numérique sans unité", { unit: null }, "QUALITY_CHARACTERISTIC_UNIT_REQUIRED"],
    ["numérique unité vide", { unit: "  " }, "QUALITY_CHARACTERISTIC_UNIT_REQUIRED"],
    [
      "booléen sans attendu",
      { value_kind: "BOOLEAN", expected_boolean: null, unit: null, tolerance_min: null, tolerance_max: null },
      "QUALITY_CHARACTERISTIC_EXPECTED_REQUIRED",
    ],
    [
      "liste sans valeurs",
      { value_kind: "ENUM", allowed_values: [], unit: null, tolerance_min: null, tolerance_max: null },
      "QUALITY_CHARACTERISTIC_ENUM_REQUIRED",
    ],
    [
      "liste avec doublons",
      {
        value_kind: "ENUM",
        allowed_values: ["OK", "OK"],
        unit: null,
        tolerance_min: null,
        tolerance_max: null,
      },
      "QUALITY_CHARACTERISTIC_ENUM_DUPLICATE",
    ],
    [
      "texte avec instrument",
      {
        value_kind: "TEXT",
        requires_instrument: true,
        unit: null,
        tolerance_min: null,
        tolerance_max: null,
      },
      "QUALITY_CHARACTERISTIC_INSTRUMENT_UNSUPPORTED",
    ],
    [
      "échantillonnage FIXED sans valeur",
      { sampling: { rule: "FIXED", value: null, justification: null } },
      "QUALITY_SAMPLING_FIXED_INVALID",
    ],
    [
      "échantillonnage FIXED à 0",
      { sampling: { rule: "FIXED", value: 0, justification: null } },
      "QUALITY_SAMPLING_FIXED_INVALID",
    ],
    [
      "échantillonnage FIXED décimal",
      { sampling: { rule: "FIXED", value: 2.5, justification: null } },
      "QUALITY_SAMPLING_FIXED_INVALID",
    ],
    [
      "échantillonnage PERCENT à 0",
      { sampling: { rule: "PERCENT", value: 0, justification: null } },
      "QUALITY_SAMPLING_PERCENT_INVALID",
    ],
    [
      "échantillonnage PERCENT > 100",
      { sampling: { rule: "PERCENT", value: 120, justification: null } },
      "QUALITY_SAMPLING_PERCENT_INVALID",
    ],
    [
      "échantillonnage PERCENT NaN",
      { sampling: { rule: "PERCENT", value: Number.NaN, justification: null } },
      "QUALITY_SAMPLING_PERCENT_INVALID",
    ],
    [
      "échantillonnage ALL avec valeur",
      { sampling: { rule: "ALL", value: 5, justification: null } },
      "QUALITY_SAMPLING_VALUE_UNEXPECTED",
    ],
    [
      "échantillonnage LOT avec valeur",
      { sampling: { rule: "LOT", value: 1, justification: null } },
      "QUALITY_SAMPLING_VALUE_UNEXPECTED",
    ],
  ];

  it.each(invalid)("refuse %s", (_label, override, code) => {
    const err = httpErrorOf(() => assertCharacteristicSpec(characteristic(override)));
    expect(err.status).toBe(422);
    expect(err.code).toBe(code);
  });
});

describe("#228 taille d'échantillon", () => {
  it.each([
    ["ALL", null, 100, 100],
    ["ALL", null, 1, 1],
    ["LOT", null, 100, 1],
    ["FIRST_ARTICLE", null, 100, 1],
    ["FIXED", 3, 100, 3],
    ["FIXED", 300, 100, 100],
    ["FIXED", 1, 1, 1],
    ["PERCENT", 10, 100, 10],
    ["PERCENT", 10, 95, 10],
    ["PERCENT", 1, 10, 1],
    ["PERCENT", 100, 7, 7],
    ["PERCENT", 33, 10, 4],
  ] as const)("calcule %s(%s) sur %d unités → %d", (rule, value, population, expected) => {
    const spec = characteristic({ sampling: { rule, value, justification: null } });
    expect(requiredSampleCount(spec, population)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "renvoie 0 pour une population invalide (%s)",
    (population) => {
      expect(requiredSampleCount(characteristic(), population)).toBe(0);
    }
  );

  it("identifie les caractéristiques de niveau lot", () => {
    expect(isLotLevelCharacteristic(characteristic({ sampling: { rule: "LOT", value: null, justification: null } }))).toBe(true);
    expect(
      isLotLevelCharacteristic(
        characteristic({
          characteristic_type: "DOCUMENTARY",
          value_kind: "TEXT",
          unit: null,
          requires_instrument: false,
        })
      )
    ).toBe(true);
    expect(isLotLevelCharacteristic(characteristic())).toBe(false);
  });

  it("documente la sémantique de chaque déclencheur", () => {
    expect(TRIGGER_SEMANTICS.RECEPTION).toBe("REQUIRES_EXECUTION");
    expect(TRIGGER_SEMANTICS.FINAL).toBe("REQUIRES_EXECUTION");
    expect(TRIGGER_SEMANTICS.LOT_RELEASE).toBe("REQUIRES_EXECUTION");
    expect(TRIGGER_SEMANTICS.IN_PROCESS).toBe("CREATES_REQUIREMENT");
    expect(TRIGGER_SEMANTICS.PERIODIC).toBe("CREATES_REQUIREMENT");
  });
});

/* ========================================================================== */
/* Évaluation des mesures                                                     */
/* ========================================================================== */

describe("#228 évaluation d'un échantillon", () => {
  it.each([
    [20, "OK", "OK"],
    [19.95, "OK", "OK"],
    [20.05, "OK", "OK"],
    [19.949, "NOK", "OUT_OF_TOLERANCE"],
    [20.051, "NOK", "OUT_OF_TOLERANCE"],
    [-5, "NOK", "OUT_OF_TOLERANCE"],
    [0, "NOK", "OUT_OF_TOLERANCE"],
  ] as const)("évalue une mesure numérique %s → %s", (value, result, code) => {
    const evaluation = evaluateSample(characteristic(), sample({ value_numeric: value }));
    expect(evaluation.result).toBe(result);
    expect(evaluation.code).toBe(code);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuse une valeur non finie (%s)",
    (value) => {
      const evaluation = evaluateSample(characteristic(), sample({ value_numeric: value }));
      expect(evaluation.result).toBe("NOK");
      expect(evaluation.code).toBe("VALUE_NOT_FINITE");
    }
  );

  it("met en attente une mesure absente", () => {
    expect(evaluateSample(characteristic(), sample({ value_numeric: null })).code).toBe("PENDING_VALUE");
  });

  it("refuse une unité incohérente", () => {
    const evaluation = evaluateSample(characteristic(), sample({ unit: "cm" }));
    expect(evaluation.result).toBe("NOK");
    expect(evaluation.code).toBe("UNIT_MISMATCH");
  });

  it("tolère une unité non renseignée côté saisie", () => {
    expect(evaluateSample(characteristic(), sample({ unit: null })).result).toBe("OK");
  });

  it("évalue un booléen", () => {
    const spec = characteristic({
      value_kind: "BOOLEAN",
      expected_boolean: true,
      unit: null,
      tolerance_min: null,
      tolerance_max: null,
      requires_instrument: false,
    });
    expect(evaluateSample(spec, sample({ value_boolean: true, value_numeric: null })).result).toBe("OK");
    const nok = evaluateSample(spec, sample({ value_boolean: false, value_numeric: null }));
    expect(nok.result).toBe("NOK");
    expect(nok.code).toBe("BOOLEAN_MISMATCH");
    expect(evaluateSample(spec, sample({ value_boolean: null, value_numeric: null })).code).toBe(
      "PENDING_VALUE"
    );
  });

  it("évalue une liste contrôlée", () => {
    const spec = characteristic({
      value_kind: "ENUM",
      allowed_values: ["CONFORME", "RAYURE", "BAVURE"],
      unit: null,
      tolerance_min: null,
      tolerance_max: null,
      requires_instrument: false,
    });
    expect(evaluateSample(spec, sample({ value_text: "CONFORME", value_numeric: null })).result).toBe("OK");
    expect(evaluateSample(spec, sample({ value_text: " RAYURE ", value_numeric: null })).result).toBe("OK");
    const nok = evaluateSample(spec, sample({ value_text: "AUTRE", value_numeric: null }));
    expect(nok.result).toBe("NOK");
    expect(nok.code).toBe("ENUM_NOT_ALLOWED");
    expect(evaluateSample(spec, sample({ value_text: "  ", value_numeric: null })).code).toBe(
      "PENDING_VALUE"
    );
  });

  it("exige une preuve sur une caractéristique textuelle critique", () => {
    const spec = characteristic({
      value_kind: "TEXT",
      criticality: "CRITICAL",
      unit: null,
      tolerance_min: null,
      tolerance_max: null,
      requires_instrument: false,
    });
    const nok = evaluateSample(spec, sample({ value_text: "Certificat 3.1 reçu", value_numeric: null }));
    expect(nok.result).toBe("NOK");
    expect(nok.code).toBe("EVIDENCE_REQUIRED");
    expect(
      evaluateSample(spec, sample({ value_text: "Certificat 3.1 reçu", value_numeric: null, evidence_count: 1 }))
        .result
    ).toBe("OK");
  });
});

describe("#228 calcul du verdict d'exécution", () => {
  const spec = characteristic({ sampling: { rule: "FIXED", value: 2, justification: null } });

  it("reste EN_ATTENTE tant que les échantillons obligatoires manquent", () => {
    const out = computeExecutionVerdict({
      characteristics: [spec],
      samples: [sample({ sample_no: 1 })],
      population: 10,
    });
    expect(out.verdict).toBe("EN_ATTENTE");
    expect(out.missing[0]).toMatchObject({ characteristic_key: "DIM-01", expected_samples: 2, recorded_samples: 1 });
  });

  it("est CONFORME quand tous les échantillons sont bons", () => {
    const out = computeExecutionVerdict({
      characteristics: [spec],
      samples: [sample({ sample_no: 1 }), sample({ sample_no: 2 })],
      population: 10,
    });
    expect(out.verdict).toBe("CONFORME");
    expect(out.ok_count).toBe(2);
    expect(out.nok_count).toBe(0);
  });

  it("est NON_CONFORME quand tous les échantillons sont mauvais", () => {
    const out = computeExecutionVerdict({
      characteristics: [spec],
      samples: [
        sample({ sample_no: 1, value_numeric: 25 }),
        sample({ sample_no: 2, value_numeric: 26 }),
      ],
      population: 10,
    });
    expect(out.verdict).toBe("NON_CONFORME");
  });

  it("est PARTIEL quand le résultat est mixte", () => {
    const out = computeExecutionVerdict({
      characteristics: [spec],
      samples: [sample({ sample_no: 1 }), sample({ sample_no: 2, value_numeric: 25 })],
      population: 10,
    });
    expect(out.verdict).toBe("PARTIEL");
    expect(out.blocking).toHaveLength(1);
  });

  it("disqualifie l'ensemble sur un échec documentaire de niveau lot", () => {
    const documentary = characteristic({
      key: "DOC-01",
      position: 2,
      characteristic_type: "DOCUMENTARY",
      value_kind: "ENUM",
      allowed_values: ["RECU"],
      unit: null,
      tolerance_min: null,
      tolerance_max: null,
      requires_instrument: false,
      sampling: { rule: "LOT", value: null, justification: null },
    });
    const out = computeExecutionVerdict({
      characteristics: [spec, documentary],
      samples: [
        sample({ sample_no: 1 }),
        sample({ sample_no: 2 }),
        sample({ characteristic_key: "DOC-01", sample_no: 1, value_numeric: null, value_text: "ABSENT" }),
      ],
      population: 10,
    });
    expect(out.verdict).toBe("NON_CONFORME");
  });

  it("ignore l'incomplétude d'une caractéristique non obligatoire", () => {
    const optional = characteristic({ key: "OPT-01", position: 2, mandatory: false });
    const out = computeExecutionVerdict({
      characteristics: [spec, optional],
      samples: [sample({ sample_no: 1 }), sample({ sample_no: 2 })],
      population: 10,
    });
    expect(out.verdict).toBe("CONFORME");
    expect(out.missing.some((m) => m.characteristic_key === "OPT-01")).toBe(true);
  });

  it("refuse un échantillon dupliqué", () => {
    const err = httpErrorOf(() =>
      computeExecutionVerdict({
        characteristics: [spec],
        samples: [sample({ sample_no: 1 }), sample({ sample_no: 1, value_numeric: 25 })],
        population: 10,
      })
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe("QUALITY_SAMPLE_DUPLICATE");
  });

  it("reste EN_ATTENTE sans aucune caractéristique évaluée", () => {
    expect(
      computeExecutionVerdict({ characteristics: [], samples: [], population: 10 }).verdict
    ).toBe("EN_ATTENTE");
  });
});

/* ========================================================================== */
/* Applicabilité des plans                                                    */
/* ========================================================================== */

describe("#228 sélection du plan applicable", () => {
  const context = {
    article_id: "art-1",
    piece_technique_id: "piece-1",
    piece_version_id: "ver-1",
    famille_id: "fam-1",
    operation_code: "10",
    fournisseur_id: null,
    trigger: "FINAL" as const,
  };

  it("classe la spécificité du plus général au plus précis", () => {
    expect(planScopeSpecificity(scope({ famille_id: "fam-1" }))).toBeLessThan(
      planScopeSpecificity(scope({ article_id: "art-1" }))
    );
    expect(planScopeSpecificity(scope({ article_id: "art-1" }))).toBeLessThan(
      planScopeSpecificity(scope({ piece_technique_id: "piece-1" }))
    );
    expect(planScopeSpecificity(scope({ piece_technique_id: "piece-1" }))).toBeLessThan(
      planScopeSpecificity(scope({ piece_version_id: "ver-1" }))
    );
  });

  it("retient le plan le plus spécifique", () => {
    const selection = selectApplicablePlan(
      [
        plan({ id: "general", scope: scope({ famille_id: "fam-1" }) }),
        plan({ id: "precis", scope: scope({ piece_version_id: "ver-1" }) }),
      ],
      context,
      NOW
    );
    expect(selection.plan.id).toBe("precis");
    expect(selection.discarded).toEqual(
      expect.arrayContaining([{ id: "general", reason: "LESS_SPECIFIC" }])
    );
  });

  it("refuse deux plans publiés de même spécificité", () => {
    const err = httpErrorOf(() =>
      selectApplicablePlan(
        [
          plan({ id: "a", code: "PC-A", scope: scope({ piece_technique_id: "piece-1" }) }),
          plan({ id: "b", code: "PC-B", scope: scope({ piece_technique_id: "piece-1" }) }),
        ],
        context,
        NOW
      )
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_PLAN_AMBIGUOUS");
    expect(err.details.candidates).toHaveLength(2);
  });

  it("écarte les brouillons et les archives", () => {
    const err = httpErrorOf(() =>
      selectApplicablePlan(
        [
          plan({ id: "draft", status: "DRAFT" }),
          plan({ id: "archived", status: "ARCHIVED" }),
          plan({ id: "review", status: "IN_REVIEW" }),
        ],
        context,
        NOW
      )
    );
    expect(err.code).toBe("QUALITY_PLAN_NOT_APPLICABLE");
    expect(err.details.discarded).toEqual(
      expect.arrayContaining([
        { id: "draft", reason: "STATUS" },
        { id: "archived", reason: "STATUS" },
        { id: "review", reason: "STATUS" },
      ])
    );
  });

  it("écarte un plan hors période d'effet", () => {
    const err = httpErrorOf(() =>
      selectApplicablePlan(
        [
          plan({
            id: "expired",
            scope: scope({ piece_technique_id: "piece-1", effective_to: "2026-01-01T00:00:00.000Z" }),
          }),
          plan({
            id: "future",
            scope: scope({ piece_technique_id: "piece-1", effective_from: "2027-01-01T00:00:00.000Z" }),
          }),
        ],
        context,
        NOW
      )
    );
    expect(err.details.discarded).toEqual(
      expect.arrayContaining([
        { id: "expired", reason: "PERIOD" },
        { id: "future", reason: "PERIOD" },
      ])
    );
  });

  it("écarte un plan d'un autre déclencheur ou d'un autre périmètre", () => {
    const err = httpErrorOf(() =>
      selectApplicablePlan(
        [
          plan({ id: "other-trigger", scope: scope({ piece_technique_id: "piece-1", trigger: "RECEPTION" }) }),
          plan({ id: "other-piece", scope: scope({ piece_technique_id: "piece-2" }) }),
          plan({ id: "other-supplier", scope: scope({ piece_technique_id: "piece-1", fournisseur_id: "f-9" }) }),
        ],
        context,
        NOW
      )
    );
    expect(err.details.discarded).toEqual(
      expect.arrayContaining([
        { id: "other-trigger", reason: "SCOPE" },
        { id: "other-piece", reason: "SCOPE" },
        { id: "other-supplier", reason: "SCOPE" },
      ])
    );
  });

  it("n'applique jamais un plan sans axe produit", () => {
    const err = httpErrorOf(() =>
      selectApplicablePlan([plan({ id: "wildcard", scope: scope({ operation_code: "10" }) })], context, NOW)
    );
    expect(err.code).toBe("QUALITY_PLAN_NOT_APPLICABLE");
  });

  it("refuse une publication qui recouvre un plan publié identique", () => {
    const candidate = plan({ id: "new", code: "PC-NEW", version: 2 });
    const err = httpErrorOf(() =>
      assertNoApplicabilityOverlap({ candidate, published: [plan({ id: "old", code: "PC-OLD" })] })
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_PLAN_APPLICABILITY_OVERLAP");
  });

  it("autorise une publication dont la période ne recouvre pas l'existant", () => {
    const candidate = plan({
      id: "new",
      scope: scope({ piece_technique_id: "piece-1", effective_from: "2027-01-01T00:00:00.000Z" }),
    });
    expect(() =>
      assertNoApplicabilityOverlap({
        candidate,
        published: [
          plan({
            id: "old",
            scope: scope({ piece_technique_id: "piece-1", effective_to: "2026-12-31T00:00:00.000Z" }),
          }),
        ],
      })
    ).not.toThrow();
  });

  it("autorise une publication sur un périmètre différent", () => {
    expect(() =>
      assertNoApplicabilityOverlap({
        candidate: plan({ id: "new", scope: scope({ piece_technique_id: "piece-9" }) }),
        published: [plan({ id: "old", scope: scope({ piece_technique_id: "piece-1" }) })],
      })
    ).not.toThrow();
  });
});

/* ========================================================================== */
/* Snapshot                                                                   */
/* ========================================================================== */

describe("#228 snapshot canonique du plan", () => {
  const sources = {
    plan: {
      id: "plan-1",
      code: "PC-2026-0001",
      version: 3,
      label: "Contrôle final bride",
      trigger: "FINAL" as const,
      scope: scope({ piece_version_id: "ver-1" }),
      published_at: "2026-07-01T08:00:00.000Z",
    },
    characteristics: [
      characteristic({ key: "DIM-02", position: 2 }),
      characteristic({ key: "DIM-01", position: 1 }),
    ],
    article: { id: "art-1", code: "ART-001", designation: "Bride" },
    piece: { id: "piece-1", code: "PT-001", designation: "Bride usinée", version: "C" },
    population: 10,
    sampling_algorithm: "cerp.sampling.v1",
    required_documents: [{ id: "doc-1", label: "Plan de définition", revision: "C" }],
  };

  it("fige un contenu ordonné et une empreinte de 64 hexadécimaux", () => {
    const snapshot = buildPlanSnapshot(sources);
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    const keys = characteristicsFromSnapshot(snapshot.payload).map((c) => c.key);
    expect(keys).toEqual(["DIM-01", "DIM-02"]);
  });

  it("mémorise le nombre d'échantillons exigé au moment du figeage", () => {
    const snapshot = buildPlanSnapshot(sources);
    const first = characteristicsFromSnapshot(snapshot.payload)[0] as unknown as {
      required_samples: number;
    };
    expect(first.required_samples).toBe(3);
  });

  it("produit la même empreinte quel que soit l'ordre d'entrée", () => {
    const reversed = { ...sources, characteristics: [...sources.characteristics].reverse() };
    expect(buildPlanSnapshot(sources).sha256).toBe(buildPlanSnapshot(reversed).sha256);
  });

  it("change d'empreinte dès qu'une tolérance change", () => {
    const modified = {
      ...sources,
      characteristics: [characteristic({ key: "DIM-01", position: 1, tolerance_max: 0.2 })],
    };
    expect(buildPlanSnapshot(modified).sha256).not.toBe(buildPlanSnapshot(sources).sha256);
  });

  it("détecte une altération du snapshot", () => {
    const snapshot = buildPlanSnapshot(sources);
    expect(() => assertSnapshotIntegrity(snapshot.payload, snapshot.sha256)).not.toThrow();

    const tampered = JSON.parse(JSON.stringify(snapshot.payload)) as Record<string, unknown>;
    (tampered.characteristics as Array<{ tolerance_max: number }>)[0].tolerance_max = 9;
    const err = httpErrorOf(() => assertSnapshotIntegrity(tampered, snapshot.sha256));
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_SNAPSHOT_TAMPERED");
    expect(err.details.expected_sha256).toBe(snapshot.sha256);
  });

  it("renvoie une liste vide pour un snapshot malformé", () => {
    expect(characteristicsFromSnapshot(null)).toEqual([]);
    expect(characteristicsFromSnapshot("nope")).toEqual([]);
    expect(characteristicsFromSnapshot({})).toEqual([]);
    expect(characteristicsFromSnapshot({ characteristics: "nope" })).toEqual([]);
  });
});

/* ========================================================================== */
/* Source typée et registre de quantités                                      */
/* ========================================================================== */

describe("#228 source typée obligatoire", () => {
  it("accepte une source valide", () => {
    expect(assertSourceRef({ source_type: "LOT", source_id: " lot-1 " })).toEqual({
      source_type: "LOT",
      source_id: "lot-1",
    });
  });

  it.each([
    [null, "QUALITY_SOURCE_TYPE_REQUIRED"],
    [undefined, "QUALITY_SOURCE_TYPE_REQUIRED"],
    [{}, "QUALITY_SOURCE_TYPE_REQUIRED"],
    [{ source_id: "lot-1" }, "QUALITY_SOURCE_TYPE_REQUIRED"],
    [{ source_type: "INVENTED", source_id: "x" }, "QUALITY_SOURCE_TYPE_REQUIRED"],
    [{ source_type: "LOT" }, "QUALITY_SOURCE_ID_REQUIRED"],
    [{ source_type: "LOT", source_id: "   " }, "QUALITY_SOURCE_ID_REQUIRED"],
  ] as const)("refuse une source invalide (%o)", (input, code) => {
    const err = httpErrorOf(() => assertSourceRef(input as never));
    expect(err.status).toBe(422);
    expect(err.code).toBe(code);
  });
});

describe("#228 registre de quantités", () => {
  it("accepte un registre cohérent", () => {
    expect(() => assertQuantityLedger(ledger({ released: 40, held: 60 }))).not.toThrow();
  });

  const invalid: Array<[string, Partial<QuantityLedger>, string]> = [
    ["population nulle", { population: 0 }, "QUALITY_POPULATION_REQUIRED"],
    ["population négative", { population: -10 }, "QUALITY_QUANTITY_INVALID"],
    ["population NaN", { population: Number.NaN }, "QUALITY_QUANTITY_INVALID"],
    ["contrôlé négatif", { controlled: -1 }, "QUALITY_QUANTITY_INVALID"],
    ["libéré Infinity", { released: Number.POSITIVE_INFINITY }, "QUALITY_QUANTITY_INVALID"],
    ["contrôlé > population", { controlled: 120 }, "QUALITY_CONTROLLED_EXCEEDS_POPULATION"],
    ["conforme > contrôlé", { controlled: 50, conforming: 60 }, "QUALITY_CONFORMING_EXCEEDS_CONTROLLED"],
    ["libéré > conforme", { conforming: 10, released: 20 }, "QUALITY_RELEASED_EXCEEDS_CONFORMING"],
    [
      "cumul dispositions > population",
      { released: 60, held: 30, scrapped: 30 },
      "QUALITY_DISPOSITIONS_EXCEED_POPULATION",
    ],
    ["consommé > libéré", { released: 10, consumed: 20 }, "QUALITY_CONSUMED_EXCEEDS_RELEASED"],
  ];

  it.each(invalid)("refuse %s", (_label, override, code) => {
    const err = httpErrorOf(() => assertQuantityLedger(ledger(override)));
    expect(err.status).toBe(422);
    expect(err.code).toBe(code);
  });

  it("calcule le reste non disposé et la quantité libérable", () => {
    const current = ledger({ released: 30, held: 20, scrapped: 10 });
    expect(remainingUndisposedQty(current)).toBe(40);
    expect(releasableQty(current)).toBe(40);
    expect(releasableQty(ledger({ conforming: 35, released: 30 }))).toBe(5);
    expect(releasableQty(ledger({ conforming: 30, released: 30 }))).toBe(0);
  });
});

/* ========================================================================== */
/* Libération                                                                 */
/* ========================================================================== */

describe("#228 décision de libération", () => {
  const base = {
    decision: "PARTIAL" as const,
    qty: 40,
    unit: "pce",
    ledger: ledger({ conforming: 60 }),
    verdict: "PARTIEL" as const,
    hasDerogation: false,
    evidenceCount: 1,
  };

  it("libère partiellement et laisse le reste bloqué", () => {
    const out = evaluateReleaseRequest(base);
    expect(out.qty_released).toBe(40);
    expect(out.ledger.released).toBe(40);
    expect(out.qty_held).toBe(60);
  });

  it("libère la totalité quand le verdict est conforme", () => {
    const out = evaluateReleaseRequest({
      ...base,
      decision: "FULL",
      qty: 100,
      verdict: "CONFORME",
      ledger: ledger(),
    });
    expect(out.qty_released).toBe(100);
  });

  it("met en quarantaine le solde restant", () => {
    const out = evaluateReleaseRequest({ ...base, decision: "HOLD", qty: 25, verdict: "PARTIEL" });
    expect(out.qty_held).toBe(25);
    expect(out.ledger.held).toBe(25);
    expect(out.qty_released).toBe(0);
  });

  it("refuse toute décision sur un verdict incomplet", () => {
    const err = httpErrorOf(() => evaluateReleaseRequest({ ...base, verdict: "EN_ATTENTE" }));
    expect(err.code).toBe("QUALITY_VERDICT_INCOMPLETE");
  });

  it("refuse la libération d'un non conforme sans dérogation", () => {
    const err = httpErrorOf(() =>
      evaluateReleaseRequest({ ...base, verdict: "NON_CONFORME", hasDerogation: false })
    );
    expect(err.code).toBe("QUALITY_RELEASE_REQUIRES_DEROGATION");
  });

  it("autorise la libération d'un non conforme couvert par une dérogation", () => {
    const out = evaluateReleaseRequest({
      ...base,
      verdict: "NON_CONFORME",
      hasDerogation: true,
      decision: "PARTIAL",
      qty: 10,
    });
    expect(out.qty_released).toBe(10);
  });

  it("interdit une libération totale sur verdict partiel", () => {
    const err = httpErrorOf(() =>
      evaluateReleaseRequest({ ...base, decision: "FULL", qty: 60, verdict: "PARTIEL" })
    );
    expect(err.code).toBe("QUALITY_RELEASE_PARTIAL_ONLY");
  });

  it.each([
    [{ qty: 0 }, "QUALITY_RELEASE_QTY_REQUIRED"],
    [{ qty: -5 }, "QUALITY_RELEASE_QTY_REQUIRED"],
    [{ qty: Number.NaN }, "QUALITY_RELEASE_QTY_INVALID"],
    [{ qty: Number.POSITIVE_INFINITY }, "QUALITY_RELEASE_QTY_INVALID"],
    [{ unit: null }, "QUALITY_RELEASE_UNIT_REQUIRED"],
    [{ unit: "  " }, "QUALITY_RELEASE_UNIT_REQUIRED"],
    [{ qty: 500 }, "QUALITY_RELEASE_QTY_EXCEEDS_ALLOWED"],
  ] as const)("refuse une demande malformée (%o)", (override, code) => {
    const err = httpErrorOf(() => evaluateReleaseRequest({ ...base, ...override }));
    expect(err.status).toBe(422);
    expect(err.code).toBe(code);
  });

  it("refuse une libération totale partielle en quantité", () => {
    const err = httpErrorOf(() =>
      evaluateReleaseRequest({ ...base, decision: "FULL", qty: 10, verdict: "CONFORME", ledger: ledger() })
    );
    expect(err.code).toBe("QUALITY_RELEASE_FULL_MISMATCH");
  });

  it("refuse une mise en quarantaine sans solde disponible", () => {
    const err = httpErrorOf(() =>
      evaluateReleaseRequest({
        ...base,
        decision: "HOLD",
        qty: 5,
        ledger: ledger({ released: 100 }),
      })
    );
    expect(err.code).toBe("QUALITY_NOTHING_TO_HOLD");
  });

  it("laisse le registre inchangé sur un refus", () => {
    const out = evaluateReleaseRequest({ ...base, decision: "REJECT", qty: 10 });
    expect(out.ledger).toEqual(base.ledger);
    expect(out.qty_released).toBe(0);
  });

  it("propage l'invalidité du registre", () => {
    const err = httpErrorOf(() =>
      evaluateReleaseRequest({ ...base, ledger: ledger({ conforming: 10, released: 20 }) })
    );
    expect(err.code).toBe("QUALITY_RELEASED_EXCEEDS_CONFORMING");
  });
});

/* ========================================================================== */
/* Instruments                                                                */
/* ========================================================================== */

describe("#228 instrument réellement utilisé", () => {
  const policy = { block_on_overdue_critical: true };

  it("n'exige rien quand la caractéristique ne demande pas d'instrument", () => {
    const out = evaluateInstrumentUsage({
      characteristic: { key: "VIS-01", requires_instrument: false, instrument_category: null },
      instrument: null,
      at: NOW,
      policy,
    });
    expect(out.allowed).toBe(true);
    expect(out.code).toBe("OK");
  });

  it("exige l'instrument quand la caractéristique le demande", () => {
    const out = evaluateInstrumentUsage({
      characteristic: characteristic(),
      instrument: null,
      at: NOW,
      policy,
    });
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("INSTRUMENT_REQUIRED");
  });

  it("accepte un instrument valide", () => {
    const out = evaluateInstrumentUsage({
      characteristic: characteristic(),
      instrument: instrument(),
      at: NOW,
      policy,
    });
    expect(out.allowed).toBe(true);
    expect(out.severity).toBe("OK");
  });

  it.each([
    [{ deleted: true }, "INSTRUMENT_DELETED"],
    [{ statut: "HORS_SERVICE" }, "INSTRUMENT_INACTIVE"],
    [{ statut: null }, "INSTRUMENT_INACTIVE"],
    [{ categorie: "PIED_A_COULISSE" }, "INSTRUMENT_OUT_OF_SCOPE"],
    [{ categorie: null }, "INSTRUMENT_OUT_OF_SCOPE"],
  ] as const)("bloque un instrument inutilisable (%o)", (override, code) => {
    const out = evaluateInstrumentUsage({
      characteristic: characteristic(),
      instrument: instrument(override),
      at: NOW,
      policy,
    });
    expect(out.allowed).toBe(false);
    expect(out.severity).toBe("BLOCKING");
    expect(out.code).toBe(code);
  });

  it("bloque un instrument critique en retard quand le réglage est actif", () => {
    const out = evaluateInstrumentUsage({
      characteristic: characteristic(),
      instrument: instrument({ next_due_date: "2026-01-01" }),
      at: NOW,
      policy,
    });
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("INSTRUMENT_OVERDUE_CRITICAL");
  });

  it("n'applique le blocage qu'à l'instrument concerné quand le réglage est inactif", () => {
    const out = evaluateInstrumentUsage({
      characteristic: characteristic(),
      instrument: instrument({ next_due_date: "2026-01-01" }),
      at: NOW,
      policy: { block_on_overdue_critical: false },
    });
    expect(out.allowed).toBe(true);
    expect(out.severity).toBe("WARNING");
  });

  it("avertit sans bloquer pour un instrument non critique en retard", () => {
    const out = evaluateInstrumentUsage({
      characteristic: characteristic(),
      instrument: instrument({ criticite: "NORMAL", next_due_date: "2026-01-01" }),
      at: NOW,
      policy,
    });
    expect(out.allowed).toBe(true);
    expect(out.code).toBe("INSTRUMENT_OVERDUE");
  });

  it.each([
    [null, false],
    ["", false],
    ["not-a-date", false],
    ["2026-12-31", false],
    ["2026-01-01", true],
  ] as const)("évalue l'échéance %s → en retard=%s", (dueDate, expected) => {
    expect(isInstrumentOverdue(instrument({ next_due_date: dueDate }), NOW)).toBe(expected);
  });
});

/* ========================================================================== */
/* Dérogations : usage                                                        */
/* ========================================================================== */

describe("#228 usage d'une concession", () => {
  const context = {
    article_id: null,
    piece_technique_id: null,
    piece_version_id: null,
    lot_id: "lot-1",
    of_id: null,
    commande_id: null,
    bon_livraison_id: null,
    unit: "pce",
  };

  it("autorise une concession approuvée dans son périmètre", () => {
    const out = evaluateDerogationUsage({ derogation: derogation(), context, qty: 10, at: NOW });
    expect(out.allowed).toBe(true);
    expect(out.remaining_qty).toBe(50);
  });

  it.each([
    [{ status: "DRAFT" }, "DEROGATION_NOT_APPROVED"],
    [{ status: "SUBMITTED" }, "DEROGATION_NOT_APPROVED"],
    [{ status: "REJECTED" }, "DEROGATION_NOT_APPROVED"],
    [{ status: "" }, "DEROGATION_NOT_APPROVED"],
    [{ status: "REVOKED" }, "DEROGATION_REVOKED"],
    [{ status: "EXPIRED" }, "DEROGATION_EXPIRED"],
    [{ valid_to: "2026-07-01T00:00:00.000Z" }, "DEROGATION_EXPIRED"],
    [{ valid_from: "2026-08-01T00:00:00.000Z" }, "DEROGATION_NOT_YET_VALID"],
    [{ lot_id: "lot-9" }, "DEROGATION_OUT_OF_SCOPE"],
    [{ lot_id: null }, "DEROGATION_OUT_OF_SCOPE"],
    [{ piece_version_id: "ver-9" }, "DEROGATION_OUT_OF_SCOPE"],
    [{ unit: "kg" }, "DEROGATION_UNIT_MISMATCH"],
    [{ max_qty: 50, consumed_qty: 45 }, "DEROGATION_QTY_EXCEEDED"],
    [{ max_qty: 50, consumed_qty: 50 }, "DEROGATION_QTY_EXCEEDED"],
  ] as const)("refuse un usage invalide (%o)", (override, code) => {
    const out = evaluateDerogationUsage({
      derogation: derogation(override),
      context,
      qty: 10,
      at: NOW,
    });
    expect(out.allowed).toBe(false);
    expect(out.code).toBe(code);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuse une quantité invalide (%s)", (qty) => {
    const out = evaluateDerogationUsage({ derogation: derogation(), context, qty, at: NOW });
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("DEROGATION_QTY_EXCEEDED");
  });

  it("accepte une concession sans plafond", () => {
    const out = evaluateDerogationUsage({
      derogation: derogation({ max_qty: null, unit: null }),
      context,
      qty: 999,
      at: NOW,
    });
    expect(out.allowed).toBe(true);
    expect(out.remaining_qty).toBeNull();
  });

  it("bascule en CONSUMED quand le plafond est atteint", () => {
    expect(derogationStatusAfterConsumption({ max_qty: 50, consumed_qty: 50 })).toBe("CONSUMED");
    expect(derogationStatusAfterConsumption({ max_qty: 50, consumed_qty: 49 })).toBe("APPROVED");
    expect(derogationStatusAfterConsumption({ max_qty: null, consumed_qty: 999 })).toBe("APPROVED");
  });

  it("réévalue le périmètre à chaque usage, y compris après consommation partielle", () => {
    const partiallyConsumed = derogation({ status: "APPROVED", consumed_qty: 45 });
    expect(evaluateDerogationUsage({ derogation: partiallyConsumed, context, qty: 5, at: NOW }).allowed).toBe(
      true
    );
    expect(evaluateDerogationUsage({ derogation: partiallyConsumed, context, qty: 6, at: NOW }).code).toBe(
      "DEROGATION_QTY_EXCEEDED"
    );
  });
});

/* ========================================================================== */
/* Moteur d'éligibilité                                                       */
/* ========================================================================== */

describe("#228 éligibilité ciblée réservation / expédition / facturation", () => {
  it.each(["RESERVE", "SHIP", "INVOICE"] as const)("autorise un lot libéré pour %s", (purpose) => {
    const verdict = evaluateQualityEligibility(target(), purpose, NOW);
    expect(verdict.allowed).toBe(true);
    expect(verdict.qty_allowed).toBe(10);
    expect(verdict.blocks).toEqual([]);
  });

  it.each([
    [{ lot_status: "BLOQUE" as const }, "LOT_NOT_RELEASED"],
    [{ lot_status: "QUARANTAINE" as const }, "LOT_QUARANTINE"],
    [{ lot_status: "EN_ATTENTE" as const }, "LOT_QUARANTINE"],
    [{ pending_mandatory_controls: 2 }, "MANDATORY_CONTROL_PENDING"],
    [{ open_nc_without_disposition: 1 }, "OPEN_NON_CONFORMITY"],
    [{ qty_requested: 200 }, "QTY_NOT_RELEASED"],
    [{ qty_released: 0 }, "QTY_NOT_RELEASED"],
    [{ qty_released: 10, qty_consumed: 10 }, "QTY_NOT_RELEASED"],
    [
      { derogation: { status: "EXPIRED", valid_to: null } },
      "DEROGATION_EXPIRED",
    ],
    [
      { derogation: { status: "APPROVED", valid_to: "2026-07-01T00:00:00.000Z" } },
      "DEROGATION_EXPIRED",
    ],
    [{ derogation: { status: "REVOKED", valid_to: null } }, "DEROGATION_EXPIRED"],
  ] as const)("bloque avec le code attendu (%o)", (override, code) => {
    const verdict = evaluateQualityEligibility(target(override), "SHIP", NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.map((b) => b.code)).toContain(code);
  });

  it("n'invente pas de blocage sur un objet voisin", () => {
    const blocked = evaluateQualityEligibility(
      target({ object_id: "lot-1", lot_status: "QUARANTAINE" }),
      "SHIP",
      NOW
    );
    const neighbour = evaluateQualityEligibility(target({ object_id: "lot-2" }), "SHIP", NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocks.every((b) => b.object_id === "lot-1")).toBe(true);
    expect(neighbour.allowed).toBe(true);
  });

  it("explique la cause et l'action attendue", () => {
    const verdict = evaluateQualityEligibility(target({ lot_status: "QUARANTAINE" }), "SHIP", NOW);
    expect(verdict.blocks[0]?.message).toContain("quarantaine");
    expect(verdict.blocks[0]?.expected_action).toBeTruthy();
    expect(verdict.blocks[0]?.object_type).toBe("LOT");
  });

  it("adapte le message de quantité au but poursuivi", () => {
    const invoice = evaluateQualityEligibility(target({ qty_requested: 200 }), "INVOICE", NOW);
    expect(invoice.blocks[0]?.expected_action).toContain("Facturer uniquement");
    const ship = evaluateQualityEligibility(target({ qty_requested: 200 }), "SHIP", NOW);
    expect(ship.blocks[0]?.expected_action).toContain("Libérer");
  });

  it("plafonne la quantité autorisée à la quantité libérée disponible", () => {
    const verdict = evaluateQualityEligibility(
      target({ qty_requested: 200, qty_released: 80, qty_consumed: 30 }),
      "SHIP",
      NOW
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.qty_allowed).toBe(50);
  });

  it("neutralise une quantité demandée non finie", () => {
    const verdict = evaluateQualityEligibility(
      target({ qty_requested: Number.NaN }),
      "RESERVE",
      NOW
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.qty_allowed).toBe(0);
  });

  it("cumule plusieurs causes de blocage", () => {
    const verdict = evaluateQualityEligibility(
      target({
        lot_status: "BLOQUE",
        open_nc_without_disposition: 2,
        pending_mandatory_controls: 1,
        qty_requested: 999,
      }),
      "SHIP",
      NOW
    );
    expect(verdict.blocks.map((b) => b.code).sort()).toEqual([
      "LOT_NOT_RELEASED",
      "MANDATORY_CONTROL_PENDING",
      "OPEN_NON_CONFORMITY",
      "QTY_NOT_RELEASED",
    ]);
    expect(verdict.qty_allowed).toBe(0);
  });

  it("lève un 409 métier détaillé via assertQualityEligibility", () => {
    expect(() => assertQualityEligibility(target(), "SHIP", NOW)).not.toThrow();
    const err = httpErrorOf(() =>
      assertQualityEligibility(target({ lot_status: "BLOQUE" }), "SHIP", NOW)
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("QUALITY_NOT_ELIGIBLE");
    expect(err.details.purpose).toBe("SHIP");
    expect(err.details.blocks).toHaveLength(1);
  });

  it("traite un lot sans statut qualité comme libéré (compatibilité stock)", () => {
    expect(evaluateQualityEligibility(target({ lot_status: null }), "RESERVE", NOW).allowed).toBe(true);
  });
});
