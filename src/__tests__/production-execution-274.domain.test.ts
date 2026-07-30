// #274 — Suivi et pointage de production 360.
// Tests des règles PURES : capacités RBAC, machine d'états, immuabilité,
// séparation des tâches, temps, quantités, idempotence et frontières
// inter-modules. Aucune I/O : ces règles doivent tenir seules.

import { describe, expect, it } from "vitest";

import {
  activityToLegacyTimeLogType,
  assertActivityUsable,
  assertExecutionTransition,
  assertFiniteQuantities,
  assertIdempotencyMatch,
  assertMutable,
  assertOwnershipOrSupervision,
  assertPlausibleDuration,
  assertReasonProvided,
  assertRetroactiveAllowed,
  assertSeparationOfDuties,
  assertWithinRemaining,
  computeDurationMinutes,
  EXECUTION_EVENT_TYPES,
  fingerprintPayload,
  FORBIDDEN_SIDE_EFFECTS,
  INTERVAL_CONVENTION,
  LEGACY_TIME_LOG_TO_ACTIVITY,
  MAX_SEGMENT_MINUTES,
  PRODUCTION_EXECUTION_CAPABILITIES,
  RETROACTIVE_WINDOW_DAYS,
  roleHasProductionExecutionCapability,
  type ActivityCategory,
} from "../module/production/domain/production-execution";

const OPERATOR = "Opérateur CN";
const CHEF = "Chef d'atelier";
const ADMIN = "Administrateur Systeme et Reseau";
const COMPTA = "Comptabilité";

function category(overrides: Partial<ActivityCategory> = {}): ActivityCategory {
  return {
    code: "PRODUCTION",
    label: "Production",
    counts_operator_time: true,
    counts_machine_time: true,
    is_productive: true,
    requires_reason: false,
    criticality: "NORMAL",
    signals_planning: false,
    signals_maintenance: false,
    signals_quality: false,
    legacy_time_type: "OPERATEUR",
    legacy_of_time_log_type: "PRODUCTION",
    required_capability: null,
    disabled_at: null,
    ...overrides,
  };
}

describe("#274 capacités RBAC — refus par défaut", () => {
  it("refuse toute capacité à un rôle vide ou inconnu", () => {
    for (const capability of PRODUCTION_EXECUTION_CAPABILITIES) {
      expect(roleHasProductionExecutionCapability(null, capability)).toBe(false);
      expect(roleHasProductionExecutionCapability("", capability)).toBe(false);
      expect(roleHasProductionExecutionCapability("Visiteur externe", capability)).toBe(false);
    }
  });

  it("autorise l'opérateur à pointer pour lui, pas à valider ni à pointer pour autrui", () => {
    expect(roleHasProductionExecutionCapability(OPERATOR, "start_self")).toBe(true);
    expect(roleHasProductionExecutionCapability(OPERATOR, "stop_self")).toBe(true);
    expect(roleHasProductionExecutionCapability(OPERATOR, "declare_quantity")).toBe(true);
    expect(roleHasProductionExecutionCapability(OPERATOR, "validate")).toBe(false);
    expect(roleHasProductionExecutionCapability(OPERATOR, "create_for_other")).toBe(false);
    expect(roleHasProductionExecutionCapability(OPERATOR, "correct")).toBe(false);
  });

  it("réserve la validation et la correction à la hiérarchie", () => {
    expect(roleHasProductionExecutionCapability(CHEF, "validate")).toBe(true);
    expect(roleHasProductionExecutionCapability(CHEF, "reject")).toBe(true);
    expect(roleHasProductionExecutionCapability(CHEF, "correct")).toBe(true);
  });

  it("sépare l'accès aux coûts de l'accès au temps", () => {
    // Un opérateur voit son temps mais jamais l'argent.
    expect(roleHasProductionExecutionCapability(OPERATOR, "read")).toBe(true);
    expect(roleHasProductionExecutionCapability(OPERATOR, "view_costs")).toBe(false);
    expect(roleHasProductionExecutionCapability(CHEF, "view_costs")).toBe(false);
    expect(roleHasProductionExecutionCapability(COMPTA, "view_costs")).toBe(true);
    // Et la compta ne pointe pas.
    expect(roleHasProductionExecutionCapability(COMPTA, "start_self")).toBe(false);
  });
});

describe("#274 anti-IDOR", () => {
  it("laisse un opérateur agir sur son propre pointage", () => {
    expect(() =>
      assertOwnershipOrSupervision({ actorUserId: 7, actorRole: OPERATOR, ownerUserId: 7, action: "arrêt" })
    ).not.toThrow();
  });

  it("refuse à un opérateur d'agir sur le pointage d'un tiers", () => {
    expect(() =>
      assertOwnershipOrSupervision({ actorUserId: 7, actorRole: OPERATOR, ownerUserId: 9, action: "arrêt" })
    ).toThrowError(/appartient à un autre opérateur/i);
  });

  it("autorise le chef d'atelier à superviser le pointage d'un tiers", () => {
    expect(() =>
      assertOwnershipOrSupervision({ actorUserId: 1, actorRole: CHEF, ownerUserId: 9, action: "arrêt" })
    ).not.toThrow();
  });
});

describe("#274 machine d'états", () => {
  it("autorise RUNNING vers DONE et CANCELLED uniquement", () => {
    expect(() => assertExecutionTransition("RUNNING", "DONE")).not.toThrow();
    expect(() => assertExecutionTransition("RUNNING", "CANCELLED")).not.toThrow();
    expect(() => assertExecutionTransition("RUNNING", "CORRECTED")).toThrowError(/interdite/i);
  });

  it("ferme définitivement CANCELLED et CORRECTED", () => {
    expect(() => assertExecutionTransition("CANCELLED", "DONE")).toThrowError(/interdite/i);
    expect(() => assertExecutionTransition("CORRECTED", "DONE")).toThrowError(/interdite/i);
  });
});

describe("#274 immuabilité après validation", () => {
  it("refuse toute modification d'un pointage validé", () => {
    expect(() =>
      assertMutable({ id: "p1", status: "DONE", validated_at: "2026-07-26T08:00:00Z" })
    ).toThrowError(/immuable/i);
  });

  it("refuse de modifier un pointage annulé ou corrigé", () => {
    expect(() => assertMutable({ id: "p1", status: "CANCELLED", validated_at: null })).toThrowError(
      /CANCELLED/
    );
    expect(() => assertMutable({ id: "p1", status: "CORRECTED", validated_at: null })).toThrowError(
      /CORRECTED/
    );
  });

  it("laisse passer un pointage arrêté non validé", () => {
    expect(() => assertMutable({ id: "p1", status: "DONE", validated_at: null })).not.toThrow();
  });
});

describe("#274 séparation des tâches", () => {
  it("interdit à un opérateur de valider son propre pointage", () => {
    expect(() =>
      assertSeparationOfDuties({ actorUserId: 7, ownerUserId: 7, actorRole: OPERATOR })
    ).toThrowError(/propre auteur/i);
  });

  it("autorise la validation du pointage d'un tiers", () => {
    expect(() =>
      assertSeparationOfDuties({ actorUserId: 1, ownerUserId: 7, actorRole: CHEF })
    ).not.toThrow();
  });

  it("n'exempte aucun rôle de la séparation auteur/validateur", () => {
    expect(() =>
      assertSeparationOfDuties({ actorUserId: 1, ownerUserId: 1, actorRole: ADMIN })
    ).toThrowError(/propre auteur/i);
  });
});

describe("#274 temps", () => {
  it("documente la convention d'intervalle [début, fin)", () => {
    expect(INTERVAL_CONVENTION).toBe("[start, end)");
  });

  it("ne compte pas deux fois la minute de bascule entre deux segments", () => {
    // Segment A 08:00 → 09:00, segment B 09:00 → 10:00 : 60 + 60, pas 121.
    const a = computeDurationMinutes("2026-07-26T08:00:00Z", "2026-07-26T09:00:00Z");
    const b = computeDurationMinutes("2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    expect(a + b).toBe(120);
  });

  it("calcule la durée indépendamment du fuseau d'écriture", () => {
    // Même instant, deux représentations : la durée ne change pas.
    expect(computeDurationMinutes("2026-07-26T08:00:00Z", "2026-07-26T12:00:00+02:00")).toBe(120);
  });

  it("traverse un changement d'heure sans perdre ni inventer de minutes", () => {
    // 2026-10-25, passage à l'heure d'hiver en Europe/Paris : 03:00 CEST → 02:00 CET.
    // En UTC l'intervalle reste continu : 2 heures réelles.
    expect(computeDurationMinutes("2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z")).toBe(120);
  });

  it("refuse une durée négative", () => {
    expect(() => computeDurationMinutes("2026-07-26T10:00:00Z", "2026-07-26T09:00:00Z")).toThrowError(
      /ne peut pas précéder/i
    );
  });

  it("refuse un horodatage illisible", () => {
    expect(() => computeDurationMinutes("pas-une-date", "2026-07-26T09:00:00Z")).toThrowError(
      /invalides/i
    );
  });

  it("refuse un segment aberrant au-delà de 24 h", () => {
    expect(() => assertPlausibleDuration(MAX_SEGMENT_MINUTES)).not.toThrow();
    expect(() => assertPlausibleDuration(MAX_SEGMENT_MINUTES + 1)).toThrowError(/dépasser/i);
  });

  it("borne la saisie rétroactive et refuse le futur", () => {
    const now = "2026-07-26T12:00:00Z";
    expect(() => assertRetroactiveAllowed("2026-07-25T12:00:00Z", now)).not.toThrow();
    expect(() =>
      assertRetroactiveAllowed(`2026-07-${String(26 - RETROACTIVE_WINDOW_DAYS - 1).padStart(2, "0")}T12:00:00Z`, now)
    ).toThrowError(/rétroactive/i);
    expect(() => assertRetroactiveAllowed("2026-07-26T13:00:00Z", now)).toThrowError(/futur/i);
  });
});

describe("#274 référentiel d'activités", () => {
  it("refuse une catégorie inconnue ou désactivée", () => {
    expect(() => assertActivityUsable(undefined, "INEXISTANT")).toThrowError(/inconnue/i);
    expect(() =>
      assertActivityUsable(category({ disabled_at: "2026-01-01T00:00:00Z" }), "PRODUCTION")
    ).toThrowError(/désactivée/i);
  });

  it("exige un motif quand la catégorie le demande", () => {
    const panne = category({ code: "BREAKDOWN", requires_reason: true });
    expect(() => assertReasonProvided(panne, null)).toThrowError(/motif/i);
    expect(() => assertReasonProvided(panne, "ab")).toThrowError(/motif/i);
    expect(() => assertReasonProvided(panne, "Broche bloquée")).not.toThrow();
  });

  it("n'exige pas de motif pour une catégorie ordinaire", () => {
    expect(() => assertReasonProvided(category(), null)).not.toThrow();
  });

  it("mappe les cinq types legacy of_time_logs sans perte", () => {
    expect(Object.keys(LEGACY_TIME_LOG_TO_ACTIVITY).sort()).toEqual([
      "CONTROL",
      "MAINTENANCE",
      "PRODUCTION",
      "PROGRAMMING",
      "SETUP",
    ]);
  });

  it("ne fabrique pas de temps legacy pour une activité non comptabilisée", () => {
    // Un arrêt planifié ne consomme pas de temps opérateur : rien à écrire côté
    // legacy, sinon on inventerait des heures de travail.
    const arret = category({
      code: "PLANNED_STOP",
      counts_operator_time: false,
      legacy_of_time_log_type: null,
    });
    expect(activityToLegacyTimeLogType(arret)).toBeNull();
    // Une attente matière qui compte du temps machine mais pas opérateur non plus.
    const attente = category({
      code: "WAIT_MATERIAL",
      counts_operator_time: false,
      legacy_of_time_log_type: null,
    });
    expect(activityToLegacyTimeLogType(attente)).toBeNull();
    // Une catégorie comptabilisée sans équivalent retombe sur PRODUCTION.
    const nettoyage = category({ code: "CLEANING", legacy_of_time_log_type: null });
    expect(activityToLegacyTimeLogType(nettoyage)).toBe("PRODUCTION");
  });
});

describe("#274 quantités", () => {
  it("refuse une valeur non finie ou négative", () => {
    expect(() =>
      assertFiniteQuantities({ qty_good: Number.NaN, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0 })
    ).toThrowError(/invalide/i);
    expect(() =>
      assertFiniteQuantities({ qty_good: -1, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0 })
    ).toThrowError(/positives/i);
    expect(() =>
      assertFiniteQuantities({
        qty_good: Number.POSITIVE_INFINITY,
        qty_scrap: 0,
        qty_rework: 0,
        qty_pending_control: 0,
      })
    ).toThrowError(/invalide/i);
  });

  it("refuse une déclaration vide, qui n'aurait aucun effet", () => {
    expect(() =>
      assertFiniteQuantities({ qty_good: 0, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0 })
    ).toThrowError(/vide/i);
  });

  it("interdit la surproduction sans tolérance", () => {
    expect(() =>
      assertWithinRemaining({
        declared: 11,
        alreadyDeclared: 0,
        quantityTarget: 10,
        overproductionTolerance: 0,
        reason: "on en a fait un de plus",
      })
    ).toThrowError(/supérieure au restant/i);
  });

  it("exige un motif quand la surproduction est tolérée", () => {
    expect(() =>
      assertWithinRemaining({
        declared: 11,
        alreadyDeclared: 0,
        quantityTarget: 10,
        overproductionTolerance: 2,
        reason: null,
      })
    ).toThrowError(/motivée/i);
    expect(() =>
      assertWithinRemaining({
        declared: 11,
        alreadyDeclared: 0,
        quantityTarget: 10,
        overproductionTolerance: 2,
        reason: "Réglage : pièce de mise au point conservée",
      })
    ).not.toThrow();
  });

  it("tient compte de ce qui a déjà été déclaré", () => {
    expect(() =>
      assertWithinRemaining({
        declared: 5,
        alreadyDeclared: 8,
        quantityTarget: 10,
        overproductionTolerance: 0,
        reason: null,
      })
    ).toThrowError(/restant/i);
    expect(() =>
      assertWithinRemaining({
        declared: 2,
        alreadyDeclared: 8,
        quantityTarget: 10,
        overproductionTolerance: 0,
        reason: null,
      })
    ).not.toThrow();
  });
});

describe("#274 idempotence", () => {
  it("produit la même empreinte quel que soit l'ordre des clés", () => {
    const a = fingerprintPayload("scope", { b: 2, a: 1, nested: { y: 2, x: 1 } });
    const b = fingerprintPayload("scope", { a: 1, nested: { x: 1, y: 2 }, b: 2 });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("distingue deux portées différentes", () => {
    expect(fingerprintPayload("start", { a: 1 })).not.toBe(fingerprintPayload("stop", { a: 1 }));
  });

  it("ignore les champs indéfinis mais pas les nuls", () => {
    expect(fingerprintPayload("s", { a: 1, b: undefined })).toBe(fingerprintPayload("s", { a: 1 }));
    expect(fingerprintPayload("s", { a: 1, b: null })).not.toBe(fingerprintPayload("s", { a: 1 }));
  });

  it("rejoue à l'identique et refuse une charge utile divergente", () => {
    const fp = fingerprintPayload("start", { of_id: 1 });
    expect(() =>
      assertIdempotencyMatch({ key: "k", storedFingerprint: fp, incomingFingerprint: fp })
    ).not.toThrow();
    expect(() =>
      assertIdempotencyMatch({
        key: "k",
        storedFingerprint: fp,
        incomingFingerprint: fingerprintPayload("start", { of_id: 2 }),
      })
    ).toThrowError(/charge utile différente/i);
  });
});

describe("#274 frontières inter-modules", () => {
  it("déclare explicitement les effets de bord interdits", () => {
    // Ces effets appartiennent à la Qualité, à la Réception de production #223,
    // au Stock, aux Livraisons, à la Facturation et au module RH #119.
    expect(FORBIDDEN_SIDE_EFFECTS).toContain("stock_movement");
    expect(FORBIDDEN_SIDE_EFFECTS).toContain("lot_creation");
    expect(FORBIDDEN_SIDE_EFFECTS).toContain("delivery_note");
    expect(FORBIDDEN_SIDE_EFFECTS).toContain("invoice");
    expect(FORBIDDEN_SIDE_EFFECTS).toContain("hr_attendance");
    expect(FORBIDDEN_SIDE_EFFECTS).toContain("payroll");
  });

  it("n'expose aucune capacité de présence ou de paie", () => {
    // Le pointage de production ne doit jamais devenir un outil RH.
    const forbidden = ["attendance", "presence", "payroll", "overtime", "geoloc", "biometric"];
    for (const capability of PRODUCTION_EXECUTION_CAPABILITIES) {
      expect(forbidden.some((f) => capability.includes(f))).toBe(false);
    }
  });

  it("couvre les quatorze événements du journal", () => {
    expect(EXECUTION_EVENT_TYPES).toHaveLength(14);
    for (const expected of [
      "START",
      "PAUSE",
      "RESUME",
      "CHANGE_ACTIVITY",
      "CHANGE_OPERATOR",
      "CHANGE_MACHINE",
      "INCIDENT",
      "STOP",
      "DECLARE_QUANTITY",
      "SUBMIT",
      "VALIDATE",
      "REJECT",
      "CORRECT",
      "CANCEL",
    ]) {
      expect(EXECUTION_EVENT_TYPES).toContain(expected as never);
    }
  });
});
