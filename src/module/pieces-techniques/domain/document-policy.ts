/**
 * Moteur d'exigences documentaires Client → Pièce technique — issue #227.
 *
 * Domaine PUR : aucune dépendance base, aucune dépendance HTTP. Toute la décision
 * « quels documents cette pièce doit-elle porter, et pourquoi » vit ici, ce qui la rend
 * éprouvable sans infrastructure et réutilisable à l'identique par l'aperçu écran et par
 * le PDF contrôlé (même payload, une seule vérité).
 *
 * MODÈLE
 * La politique est une valeur NOMMÉE portée par le client, jamais un booléen « documents
 * complets » : un booléen ne sait pas dire pour qui il vaut, ni pourquoi, ni depuis quand.
 *
 *   NONE                       → aucun document supplémentaire.
 *   REQUIRED_FOR_ALL_LINKED_PT → documents complets obligatoires pour TOUTES les pièces
 *                                du client.
 *   PER_PT_CRITICAL            → la décision se prend pièce par pièce, via l'attribut
 *                                « pièce critique ».
 *
 * Un client sans politique explicite se comporte comme NONE : on n'invente pas une
 * exigence qu'aucun humain n'a posée.
 */

export const CLIENT_DOCUMENT_POLICIES = [
  "NONE",
  "REQUIRED_FOR_ALL_LINKED_PT",
  "PER_PT_CRITICAL",
] as const;

export type ClientDocumentPolicy = (typeof CLIENT_DOCUMENT_POLICIES)[number];

export const DEFAULT_CLIENT_DOCUMENT_POLICY: ClientDocumentPolicy = "NONE";

export function isClientDocumentPolicy(value: unknown): value is ClientDocumentPolicy {
  return typeof value === "string" && (CLIENT_DOCUMENT_POLICIES as readonly string[]).includes(value);
}

/**
 * Normalise une valeur venue de la base ou d'un contrat externe. Une valeur inconnue
 * retombe sur NONE : côté exigence documentaire, l'inconnu ne doit jamais devenir une
 * obligation silencieuse.
 */
export function normalizeClientDocumentPolicy(value: unknown): ClientDocumentPolicy {
  return isClientDocumentPolicy(value) ? value : DEFAULT_CLIENT_DOCUMENT_POLICY;
}

export const CLIENT_DOCUMENT_POLICY_LABELS: Record<ClientDocumentPolicy, string> = {
  NONE: "Aucun document supplémentaire",
  REQUIRED_FOR_ALL_LINKED_PT: "Documents complets pour toutes les pièces du client",
  PER_PT_CRITICAL: "Décision par pièce (pièce critique)",
};

/** Type de document exigible, tel que le porte le référentiel `piece_document_types`. */
export type PieceDocumentType = {
  code: string;
  label: string;
  description?: string | null;
  ged_class_key?: string | null;
  is_active: boolean;
  sort_order: number;
};

/**
 * Motifs. Le code est stable (contrat, tests, gel en base) ; le libellé est la phrase
 * affichée à l'utilisateur sur la fiche pièce — « pourquoi ce document est requis ».
 */
export const DOCUMENT_REQUIREMENT_REASONS = [
  "CLIENT_POLICY_ALL_PT",
  "CLIENT_POLICY_CRITICAL_PIECE",
  "NOT_REQUIRED_POLICY_NONE",
  "NOT_REQUIRED_PIECE_NOT_CRITICAL",
  "NOT_REQUIRED_NO_CLIENT",
] as const;

export type DocumentRequirementReason = (typeof DOCUMENT_REQUIREMENT_REASONS)[number];

export type DocumentRequirement = {
  document_type_code: string;
  document_type_label: string;
  ged_class_key: string | null;
  reason_code: DocumentRequirementReason;
  reason_label: string;
};

export type DocumentRequirementResolution = {
  policy: ClientDocumentPolicy;
  policy_label: string;
  piece_critique: boolean;
  /** Documents effectivement exigés — vide quand la politique n'en impose aucun. */
  requirements: DocumentRequirement[];
  /**
   * Explication unique quand rien n'est exigé. Un écran qui n'affiche « rien à fournir »
   * sans dire pourquoi laisse l'utilisateur douter de sa saisie.
   */
  not_required_reason: { reason_code: DocumentRequirementReason; reason_label: string } | null;
};

export type ResolveDocumentRequirementsInput = {
  /** Politique du client lié ; `null`/inconnu ⇒ NONE. */
  policy: unknown;
  /** Coche « Pièce critique » de la pièce. Ignorée hors PER_PT_CRITICAL. */
  pieceCritique?: boolean | null;
  /** Référentiel complet des types (actifs et inactifs) — le tri est fait ici. */
  catalog: readonly PieceDocumentType[];
  /**
   * Codes retenus pour ce client. Vide ⇒ tous les types actifs du référentiel :
   * un client qui exige « les documents complets » sans restreindre les exige tous.
   */
  selectedTypeCodes?: readonly string[] | null;
  /** `false` quand la pièce n'a pas de client (pièce standard). */
  hasClient?: boolean;
};

function reasonLabelFor(reason: DocumentRequirementReason, documentLabel?: string): string {
  switch (reason) {
    case "CLIENT_POLICY_ALL_PT":
      return documentLabel
        ? `${documentLabel} requis : le client exige les documents complets pour toutes ses pièces.`
        : "Le client exige les documents complets pour toutes ses pièces.";
    case "CLIENT_POLICY_CRITICAL_PIECE":
      return documentLabel
        ? `${documentLabel} requis : le client décide par pièce et celle-ci est marquée critique.`
        : "Le client décide par pièce et celle-ci est marquée critique.";
    case "NOT_REQUIRED_POLICY_NONE":
      return "Aucun document supplémentaire : le client n'en exige pas.";
    case "NOT_REQUIRED_PIECE_NOT_CRITICAL":
      return "Aucun document supplémentaire : le client décide par pièce et celle-ci n'est pas marquée critique.";
    case "NOT_REQUIRED_NO_CLIENT":
      return "Aucun document supplémentaire : la pièce n'est rattachée à aucun client.";
  }
}

function sortCatalog(catalog: readonly PieceDocumentType[]): PieceDocumentType[] {
  return [...catalog].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.code.localeCompare(b.code, "fr");
  });
}

/**
 * Résout les exigences documentaires d'une pièce. Déterministe : mêmes entrées, même
 * sortie, même ordre — c'est ce qui permet de figer le résultat et de le comparer.
 */
export function resolveDocumentRequirements(
  input: ResolveDocumentRequirementsInput
): DocumentRequirementResolution {
  const policy = normalizeClientDocumentPolicy(input.policy);
  const pieceCritique = input.pieceCritique === true;
  const hasClient = input.hasClient !== false;
  const policyLabel = CLIENT_DOCUMENT_POLICY_LABELS[policy];

  const notRequired = (reason: DocumentRequirementReason): DocumentRequirementResolution => ({
    policy,
    policy_label: policyLabel,
    piece_critique: pieceCritique,
    requirements: [],
    not_required_reason: { reason_code: reason, reason_label: reasonLabelFor(reason) },
  });

  // Une pièce standard (sans client) ne peut hériter d'aucune politique client.
  if (!hasClient) return notRequired("NOT_REQUIRED_NO_CLIENT");
  if (policy === "NONE") return notRequired("NOT_REQUIRED_POLICY_NONE");
  if (policy === "PER_PT_CRITICAL" && !pieceCritique) {
    return notRequired("NOT_REQUIRED_PIECE_NOT_CRITICAL");
  }

  const reason: DocumentRequirementReason =
    policy === "REQUIRED_FOR_ALL_LINKED_PT" ? "CLIENT_POLICY_ALL_PT" : "CLIENT_POLICY_CRITICAL_PIECE";

  const selected = new Set((input.selectedTypeCodes ?? []).map((code) => code.trim()).filter(Boolean));
  const active = sortCatalog(input.catalog).filter((type) => type.is_active);
  const retained = selected.size > 0 ? active.filter((type) => selected.has(type.code)) : active;

  return {
    policy,
    policy_label: policyLabel,
    piece_critique: pieceCritique,
    requirements: retained.map((type) => ({
      document_type_code: type.code,
      document_type_label: type.label,
      ged_class_key: type.ged_class_key ?? null,
      reason_code: reason,
      reason_label: reasonLabelFor(reason, type.label),
    })),
    not_required_reason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* État d'un document attendu, tel que l'affiche l'aperçu documentaire         */
/* -------------------------------------------------------------------------- */

/**
 * Les six états que l'aperçu doit distinguer. Confondre « non requis » et « absent »
 * fait accuser à tort ; confondre « non autorisé » et « erreur serveur » envoie
 * l'utilisateur chercher une panne qui n'existe pas.
 */
export const DOCUMENT_SLOT_STATES = [
  "PRESENT",
  "MISSING",
  "NOT_REQUIRED",
  "FORBIDDEN",
  "OBSOLETE",
  "PREVIEW_UNAVAILABLE",
  "SERVER_ERROR",
] as const;

export type DocumentSlotState = (typeof DOCUMENT_SLOT_STATES)[number];

export const DOCUMENT_SLOT_STATE_LABELS: Record<DocumentSlotState, string> = {
  PRESENT: "Présent",
  MISSING: "Absent",
  NOT_REQUIRED: "Non requis",
  FORBIDDEN: "Non autorisé",
  OBSOLETE: "Obsolète",
  PREVIEW_UNAVAILABLE: "Aperçu impossible",
  SERVER_ERROR: "Erreur serveur",
};

/** Types dont l'aperçu inline est réellement possible aujourd'hui. */
const PREVIEWABLE_MIME_TYPES = new Set(["application/pdf"]);

export function isPreviewableMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && PREVIEWABLE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export type AttachedDocument = {
  id: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  document_type_code: string | null;
  /** Version de pièce à laquelle le document était rattaché lors du dépôt. */
  piece_technique_version_id: string | null;
  created_at: string | null;
  removed_at?: string | null;
};

export type DocumentSlot = {
  document_type_code: string;
  document_type_label: string;
  required: boolean;
  reason_code: DocumentRequirementReason | null;
  reason_label: string | null;
  state: DocumentSlotState;
  state_label: string;
  /** Phrase affichée sous l'état — ce que l'utilisateur doit faire, ou pourquoi il ne peut pas. */
  state_detail: string;
  document: AttachedDocument | null;
  can_preview: boolean;
};

export type BuildDocumentSlotsInput = {
  resolution: DocumentRequirementResolution;
  /** Référentiel complet : sert à nommer aussi les types non requis. */
  catalog: readonly PieceDocumentType[];
  documents: readonly AttachedDocument[];
  /** Indice courant de la pièce ; un document rattaché à un autre indice est obsolète. */
  currentVersionId: string | null;
  /** L'utilisateur a-t-il le droit de lire les documents de cette pièce ? */
  canRead: boolean;
};

/**
 * Construit la grille documentaire complète : une ligne par type du référentiel, requise
 * ou non, avec son état et sa raison. C'est ce payload UNIQUE qui alimente à la fois
 * l'écran et le PDF contrôlé.
 */
export function buildDocumentSlots(input: BuildDocumentSlotsInput): DocumentSlot[] {
  const requiredByCode = new Map(input.resolution.requirements.map((r) => [r.document_type_code, r]));
  const liveDocuments = input.documents.filter((d) => !d.removed_at);

  return sortCatalog(input.catalog)
    // Un type désactivé n'apparaît que s'il reste requis (référentiel modifié après coup)
    // ou si un document y est encore rattaché — sinon il disparaît proprement.
    .filter(
      (type) =>
        type.is_active ||
        requiredByCode.has(type.code) ||
        liveDocuments.some((d) => d.document_type_code === type.code)
    )
    .map((type): DocumentSlot => {
      const requirement = requiredByCode.get(type.code) ?? null;
      const required = requirement !== null;
      const matching = liveDocuments.filter((d) => d.document_type_code === type.code);
      // Le plus récent fait foi : un redépôt corrige un document, il ne l'empile pas.
      const document =
        matching.length > 0
          ? [...matching].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0]
          : null;

      const base = {
        document_type_code: type.code,
        document_type_label: type.label,
        required,
        reason_code: requirement?.reason_code ?? input.resolution.not_required_reason?.reason_code ?? null,
        reason_label: requirement?.reason_label ?? input.resolution.not_required_reason?.reason_label ?? null,
        document,
      };

      if (!input.canRead) {
        return {
          ...base,
          state: "FORBIDDEN",
          state_label: DOCUMENT_SLOT_STATE_LABELS.FORBIDDEN,
          state_detail:
            "Votre profil ne donne pas accès aux documents de cette pièce. Demandez l'accès au module Données techniques.",
          document: null,
          can_preview: false,
        };
      }

      if (!document) {
        return required
          ? {
              ...base,
              state: "MISSING",
              state_label: DOCUMENT_SLOT_STATE_LABELS.MISSING,
              state_detail: "Document requis et non déposé. Ajoutez-le pour compléter le dossier.",
              can_preview: false,
            }
          : {
              ...base,
              state: "NOT_REQUIRED",
              state_label: DOCUMENT_SLOT_STATE_LABELS.NOT_REQUIRED,
              state_detail:
                base.reason_label ?? "Ce document n'est pas exigé par la politique documentaire du client.",
              can_preview: false,
            };
      }

      // Rattaché à un autre indice que l'indice courant : le contenu existe mais ne fait
      // plus foi. On le montre — le cacher ferait croire à une absence.
      if (
        input.currentVersionId &&
        document.piece_technique_version_id &&
        document.piece_technique_version_id !== input.currentVersionId
      ) {
        return {
          ...base,
          state: "OBSOLETE",
          state_label: DOCUMENT_SLOT_STATE_LABELS.OBSOLETE,
          state_detail: "Déposé pour un indice antérieur : il ne fait plus foi pour l'indice courant.",
          can_preview: isPreviewableMimeType(document.mime_type),
        };
      }

      if (!isPreviewableMimeType(document.mime_type)) {
        return {
          ...base,
          state: "PREVIEW_UNAVAILABLE",
          state_label: DOCUMENT_SLOT_STATE_LABELS.PREVIEW_UNAVAILABLE,
          state_detail: `Format ${document.mime_type ?? "inconnu"} : aperçu impossible dans le navigateur. Le téléchargement reste possible.`,
          can_preview: false,
        };
      }

      return {
        ...base,
        state: "PRESENT",
        state_label: DOCUMENT_SLOT_STATE_LABELS.PRESENT,
        state_detail: required ? "Document requis et déposé." : "Document déposé (non exigé).",
        can_preview: true,
      };
    });
}

/** Un dossier est complet quand aucun document requis ne manque et qu'aucun n'est périmé. */
export function summarizeDocumentSlots(slots: readonly DocumentSlot[]): {
  required_total: number;
  present_total: number;
  missing_total: number;
  obsolete_total: number;
  complete: boolean;
} {
  const required = slots.filter((s) => s.required);
  const missing = required.filter((s) => s.state === "MISSING");
  const obsolete = required.filter((s) => s.state === "OBSOLETE");
  const present = required.filter((s) => s.state === "PRESENT" || s.state === "PREVIEW_UNAVAILABLE");
  return {
    required_total: required.length,
    present_total: present.length,
    missing_total: missing.length,
    obsolete_total: obsolete.length,
    complete: required.length > 0 ? missing.length === 0 && obsolete.length === 0 : true,
  };
}
