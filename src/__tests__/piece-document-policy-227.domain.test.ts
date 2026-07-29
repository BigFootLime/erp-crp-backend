/**
 * #227 — moteur d'exigences documentaires Client → Pièce technique.
 *
 * Ces tests sont la spécification exécutable des trois politiques. Ils tiennent aussi
 * lieu de garde de gouvernance : ils échouent si quelqu'un réintroduit un booléen
 * « documents complets », si un motif disparaît, ou si l'aperçu recommence à confondre
 * « non requis » et « absent ».
 */
import { describe, expect, it } from "vitest";

import {
  buildDocumentSlots,
  CLIENT_DOCUMENT_POLICIES,
  DOCUMENT_SLOT_STATES,
  normalizeClientDocumentPolicy,
  resolveDocumentRequirements,
  summarizeDocumentSlots,
  type AttachedDocument,
  type PieceDocumentType,
} from "../module/pieces-techniques/domain/document-policy";

const CATALOG: PieceDocumentType[] = [
  { code: "PLAN", label: "Plan", ged_class_key: "PLAN_CLIENT", is_active: true, sort_order: 10 },
  { code: "CERTIF_MATIERE", label: "Certificat matière", ged_class_key: "CERTIF_MATIERE", is_active: true, sort_order: 20 },
  { code: "CC_CCPU", label: "CC / CCPU", ged_class_key: null, is_active: true, sort_order: 30 },
  { code: "BL_CERTIFIE", label: "BL certifié", ged_class_key: null, is_active: true, sort_order: 40 },
  { code: "CERTIF_TRAITEMENT", label: "Certificat de traitement", ged_class_key: null, is_active: true, sort_order: 50 },
  { code: "RAPPORT_CONTROLE", label: "Rapport de contrôle / PV", ged_class_key: "RELEVE_CONTROLE", is_active: true, sort_order: 60 },
  { code: "ANCIEN_TYPE", label: "Type retiré", ged_class_key: null, is_active: false, sort_order: 70 },
];

function doc(overrides: Partial<AttachedDocument> = {}): AttachedDocument {
  return {
    id: "doc-1",
    original_name: "plan.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    document_type_code: "PLAN",
    piece_technique_version_id: "version-1",
    created_at: "2026-07-29T08:00:00.000Z",
    removed_at: null,
    ...overrides,
  };
}

describe("#227 — les trois politiques documentaires", () => {
  it("expose exactement trois politiques nommées, jamais un booléen", () => {
    expect([...CLIENT_DOCUMENT_POLICIES]).toEqual(["NONE", "REQUIRED_FOR_ALL_LINKED_PT", "PER_PT_CRITICAL"]);
  });

  it("NONE — aucun document supplémentaire, avec son motif", () => {
    const out = resolveDocumentRequirements({ policy: "NONE", catalog: CATALOG });
    expect(out.requirements).toEqual([]);
    expect(out.not_required_reason?.reason_code).toBe("NOT_REQUIRED_POLICY_NONE");
    expect(out.not_required_reason?.reason_label).toContain("Aucun document supplémentaire");
  });

  it("REQUIRED_FOR_ALL_LINKED_PT — tous les types actifs sont requis, criticité indifférente", () => {
    const nonCritique = resolveDocumentRequirements({
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
      pieceCritique: false,
      catalog: CATALOG,
    });
    const critique = resolveDocumentRequirements({
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
      pieceCritique: true,
      catalog: CATALOG,
    });

    expect(nonCritique.requirements.map((r) => r.document_type_code)).toEqual([
      "PLAN",
      "CERTIF_MATIERE",
      "CC_CCPU",
      "BL_CERTIFIE",
      "CERTIF_TRAITEMENT",
      "RAPPORT_CONTROLE",
    ]);
    // Le type désactivé n'est jamais exigé.
    expect(nonCritique.requirements.map((r) => r.document_type_code)).not.toContain("ANCIEN_TYPE");
    expect(critique.requirements).toEqual(nonCritique.requirements);
    expect(nonCritique.not_required_reason).toBeNull();
  });

  it("PER_PT_CRITICAL + critique — documents requis, motif « pièce critique »", () => {
    const out = resolveDocumentRequirements({
      policy: "PER_PT_CRITICAL",
      pieceCritique: true,
      catalog: CATALOG,
    });
    expect(out.requirements).toHaveLength(6);
    expect(out.requirements.every((r) => r.reason_code === "CLIENT_POLICY_CRITICAL_PIECE")).toBe(true);
    expect(out.requirements[0].reason_label).toContain("critique");
  });

  it("PER_PT_CRITICAL + non critique — aucun ajout, motif explicite", () => {
    const out = resolveDocumentRequirements({
      policy: "PER_PT_CRITICAL",
      pieceCritique: false,
      catalog: CATALOG,
    });
    expect(out.requirements).toEqual([]);
    expect(out.not_required_reason?.reason_code).toBe("NOT_REQUIRED_PIECE_NOT_CRITICAL");
  });

  it("une sélection explicite restreint les types exigés", () => {
    const out = resolveDocumentRequirements({
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
      catalog: CATALOG,
      selectedTypeCodes: ["CERTIF_MATIERE", "RAPPORT_CONTROLE"],
    });
    expect(out.requirements.map((r) => r.document_type_code)).toEqual(["CERTIF_MATIERE", "RAPPORT_CONTROLE"]);
  });

  it("une pièce sans client n'hérite d'aucune politique", () => {
    const out = resolveDocumentRequirements({
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
      catalog: CATALOG,
      hasClient: false,
    });
    expect(out.requirements).toEqual([]);
    expect(out.not_required_reason?.reason_code).toBe("NOT_REQUIRED_NO_CLIENT");
  });

  it("une politique inconnue retombe sur NONE et n'invente aucune obligation", () => {
    expect(normalizeClientDocumentPolicy("DOCUMENTS_COMPLETS")).toBe("NONE");
    expect(normalizeClientDocumentPolicy(true)).toBe("NONE");
    expect(normalizeClientDocumentPolicy(null)).toBe("NONE");
    const out = resolveDocumentRequirements({ policy: "ce-que-vous-voulez", catalog: CATALOG });
    expect(out.requirements).toEqual([]);
  });

  it("chaque exigence porte son motif lisible — jamais une exigence muette", () => {
    const out = resolveDocumentRequirements({ policy: "REQUIRED_FOR_ALL_LINKED_PT", catalog: CATALOG });
    for (const requirement of out.requirements) {
      expect(requirement.reason_code).toBe("CLIENT_POLICY_ALL_PT");
      expect(requirement.reason_label.length).toBeGreaterThan(20);
      expect(requirement.reason_label).toContain(requirement.document_type_label);
    }
  });

  it("le résultat est déterministe et trié par ordre du référentiel", () => {
    const shuffled = [...CATALOG].reverse();
    const a = resolveDocumentRequirements({ policy: "REQUIRED_FOR_ALL_LINKED_PT", catalog: CATALOG });
    const b = resolveDocumentRequirements({ policy: "REQUIRED_FOR_ALL_LINKED_PT", catalog: shuffled });
    expect(b.requirements).toEqual(a.requirements);
  });
});

describe("#227 — aperçu documentaire : six états distincts", () => {
  const resolution = resolveDocumentRequirements({
    policy: "REQUIRED_FOR_ALL_LINKED_PT",
    catalog: CATALOG,
    selectedTypeCodes: ["PLAN", "CERTIF_MATIERE"],
  });

  it("connaît les six états + PRESENT", () => {
    expect([...DOCUMENT_SLOT_STATES]).toEqual([
      "PRESENT",
      "MISSING",
      "NOT_REQUIRED",
      "FORBIDDEN",
      "OBSOLETE",
      "PREVIEW_UNAVAILABLE",
      "SERVER_ERROR",
    ]);
  });

  it("ABSENT — requis et non déposé ; NON REQUIS — hors politique", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [],
      currentVersionId: "version-1",
      canRead: true,
    });
    const plan = slots.find((s) => s.document_type_code === "PLAN");
    const bl = slots.find((s) => s.document_type_code === "BL_CERTIFIE");

    expect(plan?.state).toBe("MISSING");
    expect(plan?.required).toBe(true);
    expect(bl?.state).toBe("NOT_REQUIRED");
    expect(bl?.required).toBe(false);
    // Les deux ne portent PAS le même message — c'est tout l'objet de la distinction.
    expect(plan?.state_detail).not.toBe(bl?.state_detail);
  });

  it("NON AUTORISÉ — aucun contenu n'est révélé, pas même la présence du fichier", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc()],
      currentVersionId: "version-1",
      canRead: false,
    });
    expect(slots.every((s) => s.state === "FORBIDDEN")).toBe(true);
    expect(slots.every((s) => s.document === null)).toBe(true);
    expect(slots.every((s) => s.can_preview === false)).toBe(true);
  });

  it("OBSOLÈTE — document rattaché à un indice antérieur, montré mais déclassé", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc({ piece_technique_version_id: "version-0" })],
      currentVersionId: "version-1",
      canRead: true,
    });
    const plan = slots.find((s) => s.document_type_code === "PLAN");
    expect(plan?.state).toBe("OBSOLETE");
    expect(plan?.document?.id).toBe("doc-1");
    expect(plan?.state_detail).toContain("indice antérieur");
  });

  it("APERÇU IMPOSSIBLE — format non affichable, le téléchargement reste annoncé", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc({ mime_type: "application/step", original_name: "modele.stp" })],
      currentVersionId: "version-1",
      canRead: true,
    });
    const plan = slots.find((s) => s.document_type_code === "PLAN");
    expect(plan?.state).toBe("PREVIEW_UNAVAILABLE");
    expect(plan?.can_preview).toBe(false);
    expect(plan?.state_detail).toContain("téléchargement");
  });

  it("PRÉSENT — requis, déposé sur l'indice courant, aperçu possible", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc()],
      currentVersionId: "version-1",
      canRead: true,
    });
    const plan = slots.find((s) => s.document_type_code === "PLAN");
    expect(plan?.state).toBe("PRESENT");
    expect(plan?.can_preview).toBe(true);
  });

  it("un document retiré ne compte pas comme déposé", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc({ removed_at: "2026-07-29T09:00:00.000Z" })],
      currentVersionId: "version-1",
      canRead: true,
    });
    expect(slots.find((s) => s.document_type_code === "PLAN")?.state).toBe("MISSING");
  });

  it("un redépôt corrige le document au lieu de l'empiler", () => {
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [
        doc({ id: "ancien", created_at: "2026-07-01T08:00:00.000Z", original_name: "plan-v1.pdf" }),
        doc({ id: "recent", created_at: "2026-07-28T08:00:00.000Z", original_name: "plan-v2.pdf" }),
      ],
      currentVersionId: "version-1",
      canRead: true,
    });
    expect(slots.find((s) => s.document_type_code === "PLAN")?.document?.id).toBe("recent");
  });

  it("un type désactivé disparaît de la grille sauf s'il porte encore un document", () => {
    const sansDoc = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [],
      currentVersionId: "version-1",
      canRead: true,
    });
    expect(sansDoc.map((s) => s.document_type_code)).not.toContain("ANCIEN_TYPE");

    const avecDoc = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc({ id: "vieux", document_type_code: "ANCIEN_TYPE" })],
      currentVersionId: "version-1",
      canRead: true,
    });
    expect(avecDoc.map((s) => s.document_type_code)).toContain("ANCIEN_TYPE");
  });
});

describe("#227 — synthèse du dossier", () => {
  it("un dossier avec un requis manquant n'est pas complet", () => {
    const resolution = resolveDocumentRequirements({
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
      catalog: CATALOG,
      selectedTypeCodes: ["PLAN", "CERTIF_MATIERE"],
    });
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc()],
      currentVersionId: "version-1",
      canRead: true,
    });
    const summary = summarizeDocumentSlots(slots);
    expect(summary.required_total).toBe(2);
    expect(summary.present_total).toBe(1);
    expect(summary.missing_total).toBe(1);
    expect(summary.complete).toBe(false);
  });

  it("un requis obsolète empêche la complétude — un vieux plan ne vaut pas preuve", () => {
    const resolution = resolveDocumentRequirements({
      policy: "REQUIRED_FOR_ALL_LINKED_PT",
      catalog: CATALOG,
      selectedTypeCodes: ["PLAN"],
    });
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [doc({ piece_technique_version_id: "version-0" })],
      currentVersionId: "version-1",
      canRead: true,
    });
    expect(summarizeDocumentSlots(slots).complete).toBe(false);
  });

  it("sans exigence, le dossier est complet et ne réclame rien", () => {
    const resolution = resolveDocumentRequirements({ policy: "NONE", catalog: CATALOG });
    const slots = buildDocumentSlots({
      resolution,
      catalog: CATALOG,
      documents: [],
      currentVersionId: "version-1",
      canRead: true,
    });
    const summary = summarizeDocumentSlots(slots);
    expect(summary.required_total).toBe(0);
    expect(summary.complete).toBe(true);
    expect(slots.every((s) => s.state === "NOT_REQUIRED")).toBe(true);
  });
});
