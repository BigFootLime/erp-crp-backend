// #210 — Politiques pures de la bibliothèque de finitions.
//
// Ce fichier est la garantie que l'anti-doublon, la génération de texte et le
// cycle de vie ne dépendent d'aucune base : ils sont testés seuls, y compris
// par propriétés et par matrice de spécifications.

import { describe, expect, it } from "vitest";

import { HttpError } from "../utils/httpError";
import {
  ARTICLE_DECISIONS,
  assertArticleDecisionConsistent,
  assertGammeEditable,
  assertGeneratedTextOverrideAllowed,
  assertNoIdempotencyConflict,
  assertOperationBelongsToGamme,
  assertOperationIsSubcontracting,
  assertOptimisticVersion,
  assertPreviewFresh,
  assertRevisionContentMutable,
  assertRevisionSelectable,
  assertSurfaceFinishCapability,
  assertSurfaceFinishTransition,
  assertTemplateVariablesAllowed,
  assertThicknessCoherent,
  buildCanonicalFinishSpec,
  buildGeneratedDesignation,
  canonicalRal,
  canonicalText,
  canonicalToken,
  canonicalTokenList,
  computePreviewHash,
  computeSpecFingerprint,
  decideReceipt,
  DEFAULT_COMMENT_TEMPLATE,
  DESIGNATION_MAX_LENGTH,
  diffCanonicalSpecs,
  GENERATED_ARTICLE_TAXONOMY,
  normalizeIdempotencyKey,
  normalizeThicknessUnit,
  PURCHASE_LINE_TYPE,
  renderGeneratedComment,
  requestHash,
  roleHasSurfaceFinishCapability,
  sanitizeTemplateValue,
  SUPPLIER_CATALOGUE_CATEGORY,
  SURFACE_FINISH_STATUSES,
  surfaceFinishCapabilitiesFor,
  thicknessToMicrometers,
  truncateReadable,
  type SurfaceFinishSpecInput,
  type SurfaceFinishStatus,
} from "../module/surface-finish/domain/surface-finish-policy";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";

function baseSpecInput(overrides: Partial<SurfaceFinishSpecInput> = {}): SurfaceFinishSpecInput {
  return {
    piece_technique_version_id: VERSION_ID,
    finish_revision_id: REVISION_ID,
    norme: "ISO 7599",
    classe: "AA20",
    perimetre: "PIECE_ENTIERE",
    zones: [],
    masquages: [],
    epaisseur_min: 15,
    epaisseur_nominale: 20,
    epaisseur_max: 25,
    epaisseur_unite: "um",
    couleur: "Noir",
    teinte_ral: "RAL 9005",
    aspect: "Mat",
    rugosite: "Ra 1,6",
    durete: "HV 400",
    exigence_corrosion: "BS 240 h",
    pretraitement: "Dégraissage alcalin",
    posttraitement: "Colmatage",
    controles: ["EPAISSEUR", "ASPECT"],
    certificat_requis: true,
    certificat_type: "3.1",
    conditionnement: "Bac plastique cloisonné",
    unite_achat: "PCE",
    specification_client: null,
    specification_client_version: null,
    instructions: null,
    ...overrides,
  };
}

function fingerprintOf(overrides: Partial<SurfaceFinishSpecInput> = {}): string {
  return computeSpecFingerprint(buildCanonicalFinishSpec(baseSpecInput(overrides)));
}

function expectHttpError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    expect((err as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HttpError ${status} ${code} but nothing was thrown`);
}

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

describe("#210 capacités", () => {
  it("refuse tout à un rôle vide ou inconnu", () => {
    for (const role of [null, undefined, "", "   ", "stagiaire", "visiteur"]) {
      const caps = surfaceFinishCapabilitiesFor(role);
      expect(Object.values(caps).every((value) => value === false)).toBe(true);
    }
  });

  it("laisse lire les Achats mais ne leur laisse pas approuver une révision", () => {
    expect(roleHasSurfaceFinishCapability("Responsable Achats", "library_read")).toBe(true);
    expect(roleHasSurfaceFinishCapability("Responsable Achats", "library_approve")).toBe(false);
    expect(roleHasSurfaceFinishCapability("Responsable Achats", "operation_configure")).toBe(false);
  });

  it("réserve force-create et override de texte généré à une habilitation dédiée", () => {
    expect(roleHasSurfaceFinishCapability("Technicien Méthodes", "article_resolve")).toBe(true);
    expect(roleHasSurfaceFinishCapability("Technicien Méthodes", "article_force_create")).toBe(false);
    expect(roleHasSurfaceFinishCapability("Responsable Méthodes", "article_force_create")).toBe(true);
    expect(roleHasSurfaceFinishCapability("Technicien Méthodes", "generated_text_override")).toBe(false);
  });

  it("lève un 403 explicite quand la capacité manque", () => {
    expectHttpError(
      () => assertSurfaceFinishCapability("Secretaire", "library_draft_create"),
      403,
      "SURFACE_FINISH_CAPABILITY_REQUIRED"
    );
  });

  it("masque les coûts aux rôles qui n'ont pas à les voir", () => {
    expect(roleHasSurfaceFinishCapability("Technicien Méthodes", "costs_read")).toBe(false);
    expect(roleHasSurfaceFinishCapability("Responsable Achats", "costs_read")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2) Cycle de vie                                                            */
/* -------------------------------------------------------------------------- */

describe("#210 cycle de vie des révisions", () => {
  const allowed: Array<[SurfaceFinishStatus, SurfaceFinishStatus]> = [
    ["BROUILLON", "EN_VALIDATION"],
    ["BROUILLON", "ARCHIVEE"],
    ["EN_VALIDATION", "ACTIVE"],
    ["EN_VALIDATION", "BROUILLON"],
    ["ACTIVE", "SUSPENDUE"],
    ["ACTIVE", "OBSOLETE"],
    ["SUSPENDUE", "ACTIVE"],
    ["SUSPENDUE", "OBSOLETE"],
    ["OBSOLETE", "ARCHIVEE"],
  ];

  it.each(allowed)("autorise %s -> %s", (from, to) => {
    expect(() => assertSurfaceFinishTransition(from, to)).not.toThrow();
  });

  const forbidden: Array<[SurfaceFinishStatus, SurfaceFinishStatus]> = [
    ["ACTIVE", "BROUILLON"],
    ["ACTIVE", "EN_VALIDATION"],
    ["ARCHIVEE", "ACTIVE"],
    ["OBSOLETE", "ACTIVE"],
    ["BROUILLON", "ACTIVE"],
    ["SUSPENDUE", "BROUILLON"],
  ];

  it.each(forbidden)("interdit %s -> %s", (from, to) => {
    expectHttpError(() => assertSurfaceFinishTransition(from, to), 409, "SURFACE_FINISH_TRANSITION_FORBIDDEN");
  });

  it("refuse une transition vers le même statut", () => {
    expectHttpError(() => assertSurfaceFinishTransition("ACTIVE", "ACTIVE"), 409, "SURFACE_FINISH_TRANSITION_NOOP");
  });

  it("n'autorise que la révision ACTIVE sur une gamme", () => {
    expect(() => assertRevisionSelectable("ACTIVE")).not.toThrow();
    for (const status of SURFACE_FINISH_STATUSES.filter((value) => value !== "ACTIVE")) {
      expectHttpError(() => assertRevisionSelectable(status), 409, "FINISH_REVISION_INACTIVE");
    }
  });

  it("fige le contenu d'une révision publiée", () => {
    expect(() => assertRevisionContentMutable("BROUILLON")).not.toThrow();
    expect(() => assertRevisionContentMutable("EN_VALIDATION")).not.toThrow();
    for (const status of ["ACTIVE", "SUSPENDUE", "OBSOLETE", "ARCHIVEE"] as SurfaceFinishStatus[]) {
      expectHttpError(() => assertRevisionContentMutable(status), 409, "SURFACE_FINISH_REVISION_IMMUTABLE");
    }
  });
});

describe("#210 gardes de gamme et d'opération", () => {
  it("n'accepte de modifier qu'une gamme brouillon ou en validation", () => {
    expect(() => assertGammeEditable("BROUILLON")).not.toThrow();
    expect(() => assertGammeEditable("EN_VALIDATION")).not.toThrow();
    for (const statut of ["APPLICABLE", "OBSOLETE", "", null, undefined, "brouillon-ish"]) {
      expectHttpError(() => assertGammeEditable(statut), 409, "GAMME_NOT_EDITABLE");
    }
  });

  it("refuse une opération qui n'est pas de la sous-traitance", () => {
    expect(() => assertOperationIsSubcontracting("SOUS_TRAITANCE")).not.toThrow();
    expect(() => assertOperationIsSubcontracting("sous_traitance")).not.toThrow();
    for (const type of ["TOURNAGE", "CONTROLE", "EMBALLAGE", null, ""]) {
      expectHttpError(() => assertOperationIsSubcontracting(type), 422, "OPERATION_NOT_SUBCONTRACTING");
    }
  });

  it("refuse une opération appartenant à une autre gamme", () => {
    expect(() => assertOperationBelongsToGamme("g1", "g1")).not.toThrow();
    expectHttpError(() => assertOperationBelongsToGamme("g2", "g1"), 409, "OPERATION_GAMME_MISMATCH");
    expectHttpError(() => assertOperationBelongsToGamme(null, "g1"), 409, "OPERATION_GAMME_MISMATCH");
  });
});

/* -------------------------------------------------------------------------- */
/* 3) Unités et normalisation                                                 */
/* -------------------------------------------------------------------------- */

describe("#210 unités d'épaisseur", () => {
  it.each([
    ["um", "um"],
    ["µm", "um"],
    ["μm", "um"],
    ["microns", "um"],
    ["MM", "mm"],
    ["Millimètres", "mm"],
    ["cm", "cm"],
    ["inch", "in"],
    ["Pouce", "in"],
    ["thou", "mil"],
  ])("normalise %s en %s", (raw, expected) => {
    expect(normalizeThicknessUnit(raw)).toBe(expected);
  });

  it("refuse une unité inconnue plutôt que de deviner", () => {
    for (const unit of ["kg", "µ", "metre", "??"]) {
      expectHttpError(() => normalizeThicknessUnit(unit), 422, "SURFACE_FINISH_THICKNESS_UNIT_INVALID");
    }
  });

  it.each([
    [20, "um", 20],
    [0.02, "mm", 20],
    [0.002, "cm", 20],
    [1, "mil", 25.4],
    [1, "in", 25400],
  ])("convertit %s %s en %s µm", (value, unit, expected) => {
    expect(thicknessToMicrometers(value, unit)).toBeCloseTo(expected, 4);
  });

  it("refuse une épaisseur négative ou non numérique", () => {
    expectHttpError(() => thicknessToMicrometers(-1, "um"), 422, "SURFACE_FINISH_THICKNESS_INVALID");
    expectHttpError(() => thicknessToMicrometers(Number.NaN, "um"), 422, "SURFACE_FINISH_THICKNESS_INVALID");
  });

  it("refuse un intervalle d'épaisseur incohérent", () => {
    expectHttpError(
      () => assertThicknessCoherent({ min_um: 30, nominal_um: null, max_um: 10 }),
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID"
    );
    expectHttpError(
      () => assertThicknessCoherent({ min_um: 10, nominal_um: 5, max_um: 30 }),
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID"
    );
    expectHttpError(
      () => assertThicknessCoherent({ min_um: 10, nominal_um: 40, max_um: 30 }),
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID"
    );
    expect(() => assertThicknessCoherent({ min_um: null, nominal_um: null, max_um: null })).not.toThrow();
  });
});

describe("#210 normalisation textuelle", () => {
  it("traite chaîne vide et absence de valeur de façon identique", () => {
    expect(canonicalText("")).toBeNull();
    expect(canonicalText("   ")).toBeNull();
    expect(canonicalText(null)).toBeNull();
    expect(canonicalText(undefined)).toBeNull();
  });

  it("réduit les espaces sans perdre les accents lisibles", () => {
    expect(canonicalText("  Anodisation   dure  ")).toBe("Anodisation dure");
  });

  it("neutralise casse et accents sur les identifiants fonctionnels", () => {
    expect(canonicalToken("iso 7599")).toBe("ISO 7599");
    expect(canonicalToken("Épaisseur")).toBe("EPAISSEUR");
  });

  it.each([
    ["ral 9005", "RAL 9005"],
    ["RAL9005", "RAL 9005"],
    ["Ral-9005", "RAL 9005"],
    ["  raL   9005 ", "RAL 9005"],
  ])("canonise la teinte %s en %s", (raw, expected) => {
    expect(canonicalRal(raw)).toBe(expected);
  });

  it("trie et dédoublonne les listes : l'ordre de saisie ne compte pas", () => {
    expect(canonicalTokenList(["Filetage", "alésage", "Filetage", "", null])).toEqual(["ALESAGE", "FILETAGE"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 4) Empreinte — propriétés                                                  */
/* -------------------------------------------------------------------------- */

describe("#210 empreinte anti-doublon", () => {
  it("produit un SHA-256 hexadécimal stable", () => {
    const first = fingerprintOf();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf()).toBe(first);
  });

  it("ignore l'ordre des clés de l'objet d'entrée", () => {
    const reordered: SurfaceFinishSpecInput = {
      instructions: null,
      unite_achat: "PCE",
      certificat_type: "3.1",
      certificat_requis: true,
      controles: ["EPAISSEUR", "ASPECT"],
      posttraitement: "Colmatage",
      pretraitement: "Dégraissage alcalin",
      exigence_corrosion: "BS 240 h",
      durete: "HV 400",
      rugosite: "Ra 1,6",
      aspect: "Mat",
      teinte_ral: "RAL 9005",
      couleur: "Noir",
      epaisseur_unite: "um",
      epaisseur_max: 25,
      epaisseur_nominale: 20,
      epaisseur_min: 15,
      masquages: [],
      zones: [],
      perimetre: "PIECE_ENTIERE",
      classe: "AA20",
      norme: "ISO 7599",
      finish_revision_id: REVISION_ID,
      piece_technique_version_id: VERSION_ID,
      conditionnement: "Bac plastique cloisonné",
      specification_client: null,
      specification_client_version: null,
    };
    expect(computeSpecFingerprint(buildCanonicalFinishSpec(reordered))).toBe(fingerprintOf());
  });

  it("ignore l'ordre des zones et des contrôles", () => {
    const a = fingerprintOf({ perimetre: "ZONES", zones: ["Alésage", "Filetage"], controles: ["ASPECT", "EPAISSEUR"] });
    const b = fingerprintOf({ perimetre: "ZONES", zones: ["Filetage", "Alésage"], controles: ["EPAISSEUR", "ASPECT"] });
    expect(a).toBe(b);
  });

  it("rend équivalentes deux unités qui décrivent la même épaisseur", () => {
    const micrometres = fingerprintOf({
      epaisseur_min: 15,
      epaisseur_nominale: 20,
      epaisseur_max: 25,
      epaisseur_unite: "um",
    });
    const millimetres = fingerprintOf({
      epaisseur_min: 0.015,
      epaisseur_nominale: 0.02,
      epaisseur_max: 0.025,
      epaisseur_unite: "mm",
    });
    expect(millimetres).toBe(micrometres);
  });

  it("rend équivalentes casse, accents et espaces d'un identifiant fonctionnel", () => {
    expect(fingerprintOf({ norme: "  iso   7599 " })).toBe(fingerprintOf({ norme: "ISO 7599" }));
    expect(fingerprintOf({ teinte_ral: "ral9005" })).toBe(fingerprintOf({ teinte_ral: "RAL 9005" }));
  });

  it("traite « champ absent » et « champ vide » comme la même chose", () => {
    expect(fingerprintOf({ aspect: "" })).toBe(fingerprintOf({ aspect: null }));
  });

  it("ignore les zones quand le périmètre est la pièce entière", () => {
    expect(fingerprintOf({ perimetre: "PIECE_ENTIERE", zones: ["Alésage"] })).toBe(
      fingerprintOf({ perimetre: "PIECE_ENTIERE", zones: [] })
    );
  });

  it("oublie le type de certificat quand aucun certificat n'est exigé", () => {
    expect(fingerprintOf({ certificat_requis: false, certificat_type: "3.1" })).toBe(
      fingerprintOf({ certificat_requis: false, certificat_type: null })
    );
  });

  // Chaque champ d'identité DOIT changer l'empreinte : c'est la propriété qui
  // empêche de fusionner deux prestations différentes.
  const discriminating: Array<[string, Partial<SurfaceFinishSpecInput>]> = [
    ["norme", { norme: "ISO 10074" }],
    ["classe", { classe: "AA25" }],
    ["périmètre", { perimetre: "ZONES", zones: ["Alésage"] }],
    ["zones", { perimetre: "ZONES", zones: ["Filetage"] }],
    ["masquages", { masquages: ["Taraudage M6"] }],
    ["épaisseur min", { epaisseur_min: 10 }],
    ["épaisseur nominale", { epaisseur_nominale: 22 }],
    ["épaisseur max", { epaisseur_max: 30 }],
    ["couleur", { couleur: "Gris" }],
    ["teinte RAL", { teinte_ral: "RAL 7016" }],
    ["aspect", { aspect: "Brillant" }],
    ["rugosité", { rugosite: "Ra 0,8" }],
    ["dureté", { durete: "HV 500" }],
    ["corrosion", { exigence_corrosion: "BS 480 h" }],
    ["prétraitement", { pretraitement: "Décapage acide" }],
    ["post-traitement", { posttraitement: "Sans colmatage" }],
    ["contrôles", { controles: ["EPAISSEUR"] }],
    ["certificat requis", { certificat_requis: false }],
    ["type de certificat", { certificat_type: "3.2" }],
    ["conditionnement", { conditionnement: "Carton individuel" }],
    ["unité d'achat", { unite_achat: "LOT" }],
    ["spécification client", { specification_client: "SPEC-CLIENT-42" }],
    ["version de spécification client", { specification_client_version: "B" }],
    ["instructions", { instructions: "Protéger les portées de roulement." }],
    ["révision de finition", { finish_revision_id: "33333333-3333-4333-8333-333333333333" }],
    ["indice de pièce", { piece_technique_version_id: "44444444-4444-4444-8444-444444444444" }],
  ];

  it.each(discriminating)("distingue une différence de %s", (_label, patch) => {
    expect(fingerprintOf(patch)).not.toBe(fingerprintOf());
  });

  it("matrice : 100+ spécifications valides produisent des empreintes toutes distinctes", () => {
    const normes = ["ISO 7599", "ISO 10074", "ISO 4042", "ASTM B633", "NF A 91-450"];
    const epaisseurs = [5, 12, 20, 25, 40];
    const teintes = ["RAL 9005", "RAL 7016", "RAL 5010", null];
    const perimetres = ["PIECE_ENTIERE", "ZONES"] as const;
    const certificats: Array<[boolean, string | null]> = [
      [true, "3.1"],
      [false, null],
    ];

    const seen = new Map<string, string>();
    let count = 0;
    for (const norme of normes) {
      for (const epaisseur of epaisseurs) {
        for (const teinte of teintes) {
          for (const perimetre of perimetres) {
            for (const [requis, type] of certificats) {
              const label = `${norme}|${epaisseur}|${teinte}|${perimetre}|${requis}`;
              const fp = fingerprintOf({
                norme,
                epaisseur_min: epaisseur,
                epaisseur_nominale: epaisseur,
                epaisseur_max: epaisseur,
                teinte_ral: teinte,
                perimetre,
                zones: perimetre === "ZONES" ? ["Alésage"] : [],
                certificat_requis: requis,
                certificat_type: type,
              });
              expect(fp).toMatch(/^[0-9a-f]{64}$/);
              if (seen.has(fp)) {
                throw new Error(`Collision d'empreinte entre « ${seen.get(fp)} » et « ${label} »`);
              }
              seen.set(fp, label);
              count += 1;
            }
          }
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(100);
    expect(seen.size).toBe(count);
  });

  it("matrice : chaque spécification est stable au ré-encodage (unité et ordre)", () => {
    const cases = [
      { epaisseur_unite: "mm", factor: 1 / 1000 },
      { epaisseur_unite: "cm", factor: 1 / 10000 },
      { epaisseur_unite: "mil", factor: 1 / 25.4 },
    ];
    for (const base of [8, 15, 20, 25, 30, 50, 80]) {
      const reference = fingerprintOf({
        epaisseur_min: base,
        epaisseur_nominale: base,
        epaisseur_max: base,
        epaisseur_unite: "um",
      });
      for (const { epaisseur_unite, factor } of cases) {
        const converted = fingerprintOf({
          epaisseur_min: base * factor,
          epaisseur_nominale: base * factor,
          epaisseur_max: base * factor,
          epaisseur_unite,
        });
        expect(converted).toBe(reference);
      }
    }
  });

  it("rejette une spécification invalide plutôt que de produire une empreinte", () => {
    expectHttpError(
      () => buildCanonicalFinishSpec(baseSpecInput({ epaisseur_min: 40, epaisseur_max: 10 })),
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID"
    );
    expectHttpError(
      () => buildCanonicalFinishSpec(baseSpecInput({ perimetre: "ZONES", zones: [] })),
      422,
      "SURFACE_FINISH_ZONES_REQUIRED"
    );
    expectHttpError(
      () => buildCanonicalFinishSpec(baseSpecInput({ epaisseur_unite: "furlong" })),
      422,
      "SURFACE_FINISH_THICKNESS_UNIT_INVALID"
    );
  });

  it("explique une différence champ par champ", () => {
    const left = buildCanonicalFinishSpec(baseSpecInput());
    const right = buildCanonicalFinishSpec(baseSpecInput({ teinte_ral: "RAL 7016", epaisseur_nominale: 22 }));
    const diff = diffCanonicalSpecs(left, right);
    const fields = diff.map((entry) => entry.field);
    expect(fields).toContain("teinte_ral");
    expect(fields).toContain("epaisseur_nominale_um");
    expect(fields).not.toContain("schema_version");
  });

  it("n'accepte aucun champ commercial dans la spécification canonique", () => {
    const spec = buildCanonicalFinishSpec(baseSpecInput());
    const keys = Object.keys(spec);
    for (const forbidden of ["fournisseur", "fournisseur_id", "prix", "devise", "moq", "delai", "quantite", "tarif"]) {
      expect(keys.some((key) => key.includes(forbidden))).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5) Désignation générée                                                     */
/* -------------------------------------------------------------------------- */

describe("#210 désignation générée", () => {
  const ctx = {
    code_piece: "CAP-100",
    indice: "C",
    finition_courte: "Anodisation noire",
    teinte_ral: "RAL 9005",
    couleur: "Noir",
    epaisseur_nominale_um: 20,
    epaisseur_min_um: 15,
    classe: null,
    perimetre: "PIECE_ENTIERE" as const,
    zones: [] as string[],
  };

  it("respecte le modèle ST — {pièce} ind. {indice} — {finition}", () => {
    expect(buildGeneratedDesignation({ ...ctx, teinte_ral: null, couleur: null, epaisseur_nominale_um: null, epaisseur_min_um: null }))
      .toBe("ST — CAP-100 ind. C — Anodisation noire");
  });

  it("ajoute les qualificatifs discriminants disponibles", () => {
    expect(buildGeneratedDesignation(ctx)).toBe("ST — CAP-100 ind. C — Anodisation noire RAL 9005 20 µm");
  });

  it("retombe sur l'épaisseur minimale quand la nominale manque", () => {
    expect(buildGeneratedDesignation({ ...ctx, epaisseur_nominale_um: null })).toContain("15 µm");
  });

  it("mentionne la classe et les zones quand elles discriminent", () => {
    const value = buildGeneratedDesignation({
      ...ctx,
      classe: "AA25",
      perimetre: "ZONES",
      zones: ["ALESAGE"],
    });
    expect(value).toContain("cl. AA25");
    expect(value).toContain("zone ALESAGE");
  });

  it("ne contient jamais null, undefined, NaN ou un UUID", () => {
    const variants = [
      ctx,
      { ...ctx, teinte_ral: null },
      { ...ctx, couleur: null, teinte_ral: null },
      { ...ctx, epaisseur_nominale_um: null, epaisseur_min_um: null },
      { ...ctx, classe: "AA25", perimetre: "ZONES" as const, zones: ["A", "B"] },
    ];
    for (const variant of variants) {
      const value = buildGeneratedDesignation(variant);
      expect(value).not.toMatch(/null|undefined|NaN/i);
      expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      expect(value.trim()).toBe(value);
      expect(value).not.toMatch(/—\s*$/);
    }
  });

  it("reste sous la limite du schéma Article", () => {
    const value = buildGeneratedDesignation({
      ...ctx,
      finition_courte: "Anodisation dure décorative avec colmatage à chaud et contrôle renforcé ".repeat(4),
    });
    expect(value.length).toBeLessThanOrEqual(DESIGNATION_MAX_LENGTH);
    expect(value.endsWith("…")).toBe(true);
  });

  it("refuse de générer sans contexte plutôt que d'écrire un trou", () => {
    expectHttpError(
      () => buildGeneratedDesignation({ ...ctx, code_piece: "" }),
      422,
      "SURFACE_FINISH_DESIGNATION_CONTEXT_INCOMPLETE"
    );
    expectHttpError(
      () => buildGeneratedDesignation({ ...ctx, indice: "   " }),
      422,
      "SURFACE_FINISH_DESIGNATION_CONTEXT_INCOMPLETE"
    );
  });

  it("tronque sans couper au milieu d'un mot quand c'est possible", () => {
    expect(truncateReadable("Anodisation dure décorative", 20)).toBe("Anodisation dure…");
  });
});

/* -------------------------------------------------------------------------- */
/* 6) Commentaire généré                                                      */
/* -------------------------------------------------------------------------- */

describe("#210 commentaire généré", () => {
  const values = {
    gamme_code: "GAMME-SERIE",
    code_piece: "CAP-100",
    designation_piece: "Capot moteur",
    indice: "C",
    plan_reference: "PL-4521",
    numero_operation: 40,
    designation_operation: "Traitement de surface",
    code_finition: "FIN-000012",
    designation_finition: "Anodisation noire",
    revision_finition: 2,
    norme: "ISO 7599",
    epaisseur: "20 µm (15 à 25 µm)",
    teinte_aspect: "RAL 9005 / Mat",
    perimetre: "Pièce entière",
    zones_masquages: null,
    certificat: "3.1",
    controles: "EPAISSEUR, ASPECT",
    conditionnement: "Bac plastique cloisonné",
    instructions: null,
  };

  it("supprime proprement les lignes sans valeur", () => {
    const rendered = renderGeneratedComment(DEFAULT_COMMENT_TEMPLATE, values);
    expect(rendered.text).not.toMatch(/null|undefined/i);
    expect(rendered.text).not.toMatch(/:\s*$/m);
    expect(rendered.omitted_lines).toContain("Zones et masquages : {zones_masquages}");
    expect(rendered.omitted_lines).toContain("Instructions complémentaires : {instructions}");
    expect(rendered.text).toContain("Norme / spécification : ISO 7599");
  });

  it("ne laisse jamais une ligne réduite à son libellé", () => {
    const rendered = renderGeneratedComment(DEFAULT_COMMENT_TEMPLATE, { code_piece: "CAP-100" });
    for (const line of rendered.text.split("\n")) {
      expect(line).not.toMatch(/^[^:]*:\s*$/);
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it("refuse une variable hors liste blanche", () => {
    expectHttpError(
      () => assertTemplateVariablesAllowed("Fournisseur : {fournisseur} — prix {prix}"),
      422,
      "SURFACE_FINISH_TEMPLATE_VARIABLE_FORBIDDEN"
    );
    expectHttpError(
      () => renderGeneratedComment("Secret : {process_env}", values),
      422,
      "SURFACE_FINISH_TEMPLATE_VARIABLE_FORBIDDEN"
    );
  });

  it("neutralise balises, accolades et injections de modèle dans les valeurs", () => {
    const rendered = renderGeneratedComment("Pièce : {code_piece}", {
      code_piece: "<script>alert(1)</script>{instructions}",
    });
    expect(rendered.text).not.toContain("<");
    expect(rendered.text).not.toContain(">");
    expect(rendered.text).not.toContain("{");
    expect(rendered.text).not.toContain("}");
  });

  it("aplatit les retours à la ligne et les caractères de contrôle d'une valeur", () => {
    expect(sanitizeTemplateValue("ligne1\nligne2")).toBe("ligne1 · ligne2");
    expect(sanitizeTemplateValue("a bc")).toBe("a b c");
    expect(sanitizeTemplateValue(null)).toBe("");
    expect(sanitizeTemplateValue(["a", "", "b"])).toBe("a, b");
  });

  it("plafonne la longueur d'une valeur interpolée", () => {
    const long = "x".repeat(2000);
    expect(sanitizeTemplateValue(long, 100).length).toBeLessThanOrEqual(100);
  });

  it("conserve la version du modèle utilisée", () => {
    const rendered = renderGeneratedComment(DEFAULT_COMMENT_TEMPLATE, values, 7);
    expect(rendered.template_version).toBe(7);
  });
});

describe("#210 override d'un texte généré", () => {
  it("exige la capacité dédiée", () => {
    expectHttpError(
      () => assertGeneratedTextOverrideAllowed({ role: "Technicien Méthodes", reason: "Demande client formalisée" }),
      403,
      "SURFACE_FINISH_OVERRIDE_FORBIDDEN"
    );
  });

  it("exige un motif écrit", () => {
    expectHttpError(
      () => assertGeneratedTextOverrideAllowed({ role: "Responsable Méthodes", reason: "court" }),
      422,
      "SURFACE_FINISH_OVERRIDE_REASON_REQUIRED"
    );
    expect(() =>
      assertGeneratedTextOverrideAllowed({ role: "Responsable Méthodes", reason: "Exigence contractuelle client Airbus" })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 7) Décision de résolution                                                  */
/* -------------------------------------------------------------------------- */

describe("#210 arbitrage de la décision d'article", () => {
  const ARTICLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("liste bien les trois décisions possibles", () => {
    expect([...ARTICLE_DECISIONS]).toEqual(["REUSE", "CREATE", "FORCE_CREATE"]);
  });

  it("réutilise un article exact actif", () => {
    expect(() =>
      assertArticleDecisionConsistent({
        decision: "REUSE",
        state: { exactMatchArticleId: ARTICLE, exactMatchIsActive: true },
        requestedArticleId: ARTICLE,
        role: "Technicien Méthodes",
        justification: null,
      })
    ).not.toThrow();
  });

  it("refuse une réutilisation quand l'article exact a changé", () => {
    expectHttpError(
      () =>
        assertArticleDecisionConsistent({
          decision: "REUSE",
          state: { exactMatchArticleId: null, exactMatchIsActive: false },
          requestedArticleId: ARTICLE,
          role: "Technicien Méthodes",
          justification: null,
        }),
      409,
      "ARTICLE_EXACT_MATCH_CHANGED"
    );
    expectHttpError(
      () =>
        assertArticleDecisionConsistent({
          decision: "REUSE",
          state: { exactMatchArticleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", exactMatchIsActive: true },
          requestedArticleId: ARTICLE,
          role: "Technicien Méthodes",
          justification: null,
        }),
      409,
      "ARTICLE_EXACT_MATCH_CHANGED"
    );
  });

  it("refuse de réutiliser un article exact inactif", () => {
    expectHttpError(
      () =>
        assertArticleDecisionConsistent({
          decision: "REUSE",
          state: { exactMatchArticleId: ARTICLE, exactMatchIsActive: false },
          requestedArticleId: ARTICLE,
          role: "Technicien Méthodes",
          justification: null,
        }),
      422,
      "ARTICLE_SPEC_CONFLICT"
    );
  });

  it("refuse une création simple quand un article exact existe", () => {
    expectHttpError(
      () =>
        assertArticleDecisionConsistent({
          decision: "CREATE",
          state: { exactMatchArticleId: ARTICLE, exactMatchIsActive: true },
          requestedArticleId: null,
          role: "Technicien Méthodes",
          justification: null,
        }),
      409,
      "ARTICLE_SPEC_CONFLICT"
    );
  });

  it("autorise la création quand aucun article exact n'existe", () => {
    expect(() =>
      assertArticleDecisionConsistent({
        decision: "CREATE",
        state: { exactMatchArticleId: null, exactMatchIsActive: false },
        requestedArticleId: null,
        role: "Technicien Méthodes",
        justification: null,
      })
    ).not.toThrow();
  });

  it("exige habilitation ET justification pour un article distinct", () => {
    expectHttpError(
      () =>
        assertArticleDecisionConsistent({
          decision: "FORCE_CREATE",
          state: { exactMatchArticleId: ARTICLE, exactMatchIsActive: true },
          requestedArticleId: null,
          role: "Technicien Méthodes",
          justification: "Le client impose une référence dédiée pour cette affaire",
        }),
      403,
      "ARTICLE_FORCE_CREATE_FORBIDDEN"
    );
    expectHttpError(
      () =>
        assertArticleDecisionConsistent({
          decision: "FORCE_CREATE",
          state: { exactMatchArticleId: ARTICLE, exactMatchIsActive: true },
          requestedArticleId: null,
          role: "Responsable Méthodes",
          justification: "trop court",
        }),
      422,
      "ARTICLE_FORCE_CREATE_JUSTIFICATION_REQUIRED"
    );
    expect(() =>
      assertArticleDecisionConsistent({
        decision: "FORCE_CREATE",
        state: { exactMatchArticleId: ARTICLE, exactMatchIsActive: true },
        requestedArticleId: null,
        role: "Responsable Méthodes",
        justification: "Le client impose une référence dédiée pour cette affaire.",
      })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 8) Aperçu, idempotence, verrou optimiste                                   */
/* -------------------------------------------------------------------------- */

describe("#210 fraîcheur de l'aperçu", () => {
  const base = {
    gamme_id: "g",
    operation_id: "o",
    spec_fingerprint: "f",
    exact_match_article_id: null,
    designation: "ST — CAP-100 ind. C — Anodisation",
    comment: "commentaire",
    gamme_updated_at: "2026-07-28T08:00:00.000Z",
    operation_updated_at: "2026-07-28T08:00:00.000Z",
  };

  it("change si l'article exact apparaît", () => {
    const before = computePreviewHash(base);
    const after = computePreviewHash({ ...base, exact_match_article_id: "art" });
    expect(after).not.toBe(before);
  });

  it("change si la gamme ou l'opération bouge", () => {
    const before = computePreviewHash(base);
    expect(computePreviewHash({ ...base, gamme_updated_at: "2026-07-28T09:00:00.000Z" })).not.toBe(before);
    expect(computePreviewHash({ ...base, operation_updated_at: "2026-07-28T09:00:00.000Z" })).not.toBe(before);
  });

  it("exige un aperçu et refuse un aperçu périmé", () => {
    const current = computePreviewHash(base);
    expectHttpError(() => assertPreviewFresh(null, current), 422, "PREVIEW_REQUIRED");
    expectHttpError(() => assertPreviewFresh("   ", current), 422, "PREVIEW_REQUIRED");
    expectHttpError(() => assertPreviewFresh("autre", current), 409, "PREVIEW_STALE");
    expect(() => assertPreviewFresh(current, current)).not.toThrow();
  });
});

describe("#210 idempotence", () => {
  it("impose une clé de longueur raisonnable", () => {
    expectHttpError(() => normalizeIdempotencyKey("court"), 400, "IDEMPOTENCY_KEY_INVALID");
    expectHttpError(() => normalizeIdempotencyKey(null), 400, "IDEMPOTENCY_KEY_INVALID");
    expectHttpError(() => normalizeIdempotencyKey("x".repeat(201)), 400, "IDEMPOTENCY_KEY_INVALID");
    expect(normalizeIdempotencyKey("  abcdefgh  ")).toBe("abcdefgh");
  });

  it("rejoue une charge identique et refuse une charge différente", () => {
    const hash = requestHash("surface_finish.confirm", { a: 1, b: [1, 2] });
    expect(requestHash("surface_finish.confirm", { b: [1, 2], a: 1 })).toBe(hash);
    expect(decideReceipt(null, hash)).toBe("NEW");
    expect(decideReceipt(hash, hash)).toBe("REPLAY");
    expect(decideReceipt("autre", hash)).toBe("CONFLICT");
    expectHttpError(() => assertNoIdempotencyConflict("CONFLICT"), 409, "IDEMPOTENCY_CONFLICT");
    expect(() => assertNoIdempotencyConflict("REPLAY")).not.toThrow();
  });
});

describe("#210 verrou optimiste", () => {
  it("exige expected_updated_at et détecte une modification concurrente", () => {
    const now = "2026-07-28T08:00:00.000Z";
    expectHttpError(
      () => assertOptimisticVersion({ expectedUpdatedAt: null, currentUpdatedAt: now, label: "La gamme" }),
      422,
      "EXPECTED_VERSION_REQUIRED"
    );
    expectHttpError(
      () => assertOptimisticVersion({ expectedUpdatedAt: "pas-une-date", currentUpdatedAt: now, label: "La gamme" }),
      422,
      "EXPECTED_VERSION_INVALID"
    );
    expectHttpError(
      () =>
        assertOptimisticVersion({
          expectedUpdatedAt: "2026-07-28T07:00:00.000Z",
          currentUpdatedAt: now,
          label: "La gamme",
        }),
      409,
      "CONCURRENT_MODIFICATION"
    );
    expect(() => assertOptimisticVersion({ expectedUpdatedAt: now, currentUpdatedAt: now, label: "La gamme" })).not.toThrow();
  });

  it("tolère les représentations équivalentes d'une même date", () => {
    expect(() =>
      assertOptimisticVersion({
        expectedUpdatedAt: "2026-07-28T08:00:00.000Z",
        currentUpdatedAt: new Date("2026-07-28T08:00:00.000Z"),
        label: "La gamme",
      })
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 9) Taxonomie de l'article généré                                           */
/* -------------------------------------------------------------------------- */

describe("#210 taxonomie CAT", () => {
  it("fixe la CAT métier à traitement_surface, jamais un enum « CAT » inventé", () => {
    expect(GENERATED_ARTICLE_TAXONOMY.article_categories).toEqual(["traitement_surface"]);
    expect(GENERATED_ARTICLE_TAXONOMY.article_type).toBe("PURCHASED");
    expect(GENERATED_ARTICLE_TAXONOMY.article_category).toBe("traitement");
    expect(GENERATED_ARTICLE_TAXONOMY.default_family_code).toBe("TRT");
  });

  it("ne gère ni stock ni lot sur la prestation elle-même", () => {
    expect(GENERATED_ARTICLE_TAXONOMY.stock_managed).toBe(false);
    expect(GENERATED_ARTICLE_TAXONOMY.lot_tracking).toBe(false);
  });

  it("distingue la ligne d'achat pièce et la catégorie du catalogue fournisseur", () => {
    expect(PURCHASE_LINE_TYPE).toBe("TRAITEMENT");
    expect(SUPPLIER_CATALOGUE_CATEGORY).toBe("SOUS_TRAITANCE");
  });
});
