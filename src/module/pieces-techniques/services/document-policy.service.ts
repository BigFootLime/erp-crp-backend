// src/module/pieces-techniques/services/document-policy.service.ts
// Issue #227 — assemblage du dossier documentaire d'une pièce technique.
//
// UN SEUL CONSTRUCTEUR DE PAYLOAD
// `buildPieceDocumentDossier` est la seule source de vérité : l'aperçu écran le sérialise
// en JSON, le PDF contrôlé le rend en pages. Deux chemins de calcul auraient fini par
// diverger, et un dossier de contrôle qui contredit l'écran ne vaut rien.
import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  buildDocumentSlots,
  resolveDocumentRequirements,
  summarizeDocumentSlots,
  type ClientDocumentPolicy,
  type DocumentRequirement,
  type DocumentSlot,
} from "../domain/document-policy";
import {
  DocumentPolicyInfrastructureMissing,
  repoDocumentPolicyInfrastructureReady,
  repoFreezeVersionRequirements,
  repoGetClientDocumentPolicy,
  repoGetPieceDocumentContext,
  repoListDocumentTypes,
  repoListFrozenRequirements,
  repoSetClientDocumentPolicy,
  repoSetPieceCritique,
  repoCreateDocumentType,
  repoUpdateDocumentType,
  type ClientDocumentPolicyRecord,
  type PieceDocumentTypeRecord,
  type UpsertDocumentTypeInput,
} from "../repository/document-policy.repository";
import type { AuditContext } from "../repository/pieces-techniques.repository";

export type PieceDocumentDossier = {
  piece: {
    id: string;
    code_piece: string;
    designation: string;
    client_id: string | null;
    client_name: string | null;
    piece_critique: boolean;
    piece_critique_motif: string | null;
  };
  version: {
    id: string | null;
    indice: string | null;
    statut: string | null;
    /** Horodatage du gel — `null` tant que la version n'a pas été publiée. */
    requirements_frozen_at: string | null;
  };
  policy: {
    value: ClientDocumentPolicy;
    label: string;
    /** `true` quand les exigences affichées viennent de l'instantané figé. */
    frozen: boolean;
    /**
     * `true` quand la politique du client a changé DEPUIS le gel. La version publiée
     * reste sur son instantané ; la divergence est signalée, jamais appliquée en douce.
     */
    diverged_from_client: boolean;
  };
  not_required_reason: { reason_code: string; reason_label: string } | null;
  slots: DocumentSlot[];
  summary: ReturnType<typeof summarizeDocumentSlots>;
  /** `false` quand le patch #227 n'est pas appliqué : le module reste utilisable. */
  policy_infrastructure_ready: boolean;
  generated_at: string;
};

/** Politique neutre servie quand le référentiel n'est pas installé sur la base. */
const NEUTRAL_POLICY: PieceDocumentDossier["policy"] = {
  value: "NONE",
  label: "Aucun document supplémentaire",
  frozen: false,
  diverged_from_client: false,
};

/**
 * Construit le dossier documentaire complet d'une pièce.
 *
 * Règle de lecture : si la version courante porte un GEL, ce sont les exigences gelées
 * qui font foi, quoi qu'ait fait le client depuis. Sinon, les exigences sont recalculées
 * en direct depuis la politique courante.
 */
export async function buildPieceDocumentDossier(params: {
  pieceTechniqueId: string;
  canRead: boolean;
}): Promise<PieceDocumentDossier | null> {
  const generatedAt = new Date().toISOString();

  let context: Awaited<ReturnType<typeof repoGetPieceDocumentContext>>;
  let catalog: PieceDocumentTypeRecord[];
  try {
    context = await repoGetPieceDocumentContext(params.pieceTechniqueId);
    if (!context) return null;
    catalog = await repoListDocumentTypes({ includeInactive: true });
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) {
      // Base sans le patch : on rend un dossier vide et HONNÊTE plutôt qu'une erreur 500
      // qui rendrait la fiche pièce inaccessible.
      return {
        piece: {
          id: params.pieceTechniqueId,
          code_piece: "",
          designation: "",
          client_id: null,
          client_name: null,
          piece_critique: false,
          piece_critique_motif: null,
        },
        version: { id: null, indice: null, statut: null, requirements_frozen_at: null },
        policy: NEUTRAL_POLICY,
        not_required_reason: {
          reason_code: "POLICY_INFRASTRUCTURE_MISSING",
          reason_label:
            "Politique documentaire indisponible sur cette base : le référentiel n'est pas installé. Aucun document n'est exigé tant qu'il ne l'est pas.",
        },
        slots: [],
        summary: { required_total: 0, present_total: 0, missing_total: 0, obsolete_total: 0, complete: true },
        policy_infrastructure_ready: false,
        generated_at: generatedAt,
      };
    }
    throw err;
  }

  const frozen = context.current_version_id ? await repoListFrozenRequirements(context.current_version_id) : [];
  const isFrozen = Boolean(context.frozen_at) && frozen.length >= 0 && Boolean(context.current_version_id);

  const liveResolution = resolveDocumentRequirements({
    policy: context.policy,
    pieceCritique: context.piece_critique,
    catalog,
    selectedTypeCodes: context.selected_type_codes,
    hasClient: Boolean(context.client_id),
  });

  const resolution =
    isFrozen && context.frozen_policy
      ? {
          policy: context.frozen_policy,
          policy_label: liveResolution.policy_label,
          piece_critique: frozen[0]?.piece_critique ?? context.piece_critique,
          requirements: frozen.map(
            (row): DocumentRequirement => ({
              document_type_code: row.document_type_code,
              document_type_label: row.document_type_label,
              ged_class_key: catalog.find((t) => t.code === row.document_type_code)?.ged_class_key ?? null,
              reason_code: row.reason_code as DocumentRequirement["reason_code"],
              reason_label: row.reason_label,
            })
          ),
          not_required_reason:
            frozen.length === 0
              ? {
                  reason_code: "NOT_REQUIRED_POLICY_NONE" as const,
                  reason_label:
                    "Aucun document supplémentaire : aucune exigence n'était applicable au moment de la publication de cet indice.",
                }
              : null,
        }
      : liveResolution;

  const slots = buildDocumentSlots({
    resolution,
    catalog,
    documents: context.documents,
    currentVersionId: context.current_version_id,
    canRead: params.canRead,
  });

  const divergedFromClient =
    isFrozen &&
    (context.frozen_policy !== context.policy ||
      frozen.map((r) => r.document_type_code).sort().join("|") !==
        liveResolution.requirements
          .map((r) => r.document_type_code)
          .sort()
          .join("|"));

  return {
    piece: {
      id: context.piece_technique_id,
      code_piece: context.code_piece,
      designation: context.designation,
      client_id: context.client_id,
      client_name: context.client_name,
      piece_critique: context.piece_critique,
      piece_critique_motif: context.piece_critique_motif,
    },
    version: {
      id: context.current_version_id,
      indice: context.current_version_indice,
      statut: context.current_version_statut,
      requirements_frozen_at: context.frozen_at,
    },
    policy: {
      value: resolution.policy,
      label: resolution.policy_label,
      frozen: isFrozen,
      diverged_from_client: divergedFromClient,
    },
    not_required_reason: resolution.not_required_reason,
    slots,
    summary: summarizeDocumentSlots(slots),
    policy_infrastructure_ready: true,
    generated_at: generatedAt,
  };
}

/**
 * Fige les exigences d'une version. Appelé au passage APPLICABLE. Silencieusement sans
 * effet quand le patch #227 n'est pas appliqué : publier un indice ne doit jamais échouer
 * parce qu'un référentiel optionnel manque.
 */
export async function freezePieceVersionRequirements(
  tx: Pick<PoolClient, "query">,
  params: { pieceTechniqueId: string; versionId: string; userId: number | null }
): Promise<{ already_frozen: boolean; frozen_count: number } | null> {
  // On est DANS la transaction de publication de l'indice. Une requête qui échoue ici
  // (table absente : 42P01/42703) n'échoue pas seule — elle AVORTE la transaction, et
  // tout ce qui suit repart en 25P02, y compris le COMMIT. Publier un indice se mettrait
  // donc à échouer sur une base sans le patch #227. On interroge d'abord le catalogue
  // système via `to_regclass`, qui ne peut pas échouer, et on ne touche aux tables que
  // si elles existent réellement.
  if (!(await repoDocumentPolicyInfrastructureReady(tx))) return null;

  let context: Awaited<ReturnType<typeof repoGetPieceDocumentContext>>;
  let catalog: PieceDocumentTypeRecord[];
  try {
    context = await repoGetPieceDocumentContext(params.pieceTechniqueId, tx);
    if (!context) return null;
    catalog = await repoListDocumentTypes({ includeInactive: false }, tx);
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) return null;
    throw err;
  }

  const resolution = resolveDocumentRequirements({
    policy: context.policy,
    pieceCritique: context.piece_critique,
    catalog,
    selectedTypeCodes: context.selected_type_codes,
    hasClient: Boolean(context.client_id),
  });

  try {
    return await repoFreezeVersionRequirements(tx, {
      versionId: params.versionId,
      policy: resolution.policy,
      pieceCritique: resolution.piece_critique,
      requirements: resolution.requirements,
      userId: params.userId,
    });
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) return null;
    throw err;
  }
}

/* ------------------------------ passe-plats ------------------------------ */

export async function listDocumentTypesSVC(includeInactive: boolean): Promise<PieceDocumentTypeRecord[]> {
  try {
    return await repoListDocumentTypes({ includeInactive });
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) return [];
    throw err;
  }
}

export const createDocumentTypeSVC = (input: UpsertDocumentTypeInput, audit: AuditContext) =>
  repoCreateDocumentType(input, audit);

export const updateDocumentTypeSVC = (
  code: string,
  patch: Partial<Omit<UpsertDocumentTypeInput, "code">>,
  audit: AuditContext
) => repoUpdateDocumentType(code, patch, audit);

export async function getClientDocumentPolicySVC(clientId: string): Promise<ClientDocumentPolicyRecord | null> {
  try {
    return await repoGetClientDocumentPolicy(clientId);
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) {
      throw new HttpError(
        503,
        "DOCUMENT_POLICY_UNAVAILABLE",
        "Politique documentaire indisponible sur cette base : le référentiel n'est pas installé."
      );
    }
    throw err;
  }
}

export async function setClientDocumentPolicySVC(
  clientId: string,
  input: { policy: ClientDocumentPolicy; selected_type_codes: string[] },
  audit: AuditContext
): Promise<ClientDocumentPolicyRecord | null> {
  try {
    return await repoSetClientDocumentPolicy(clientId, input, audit);
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) {
      throw new HttpError(
        503,
        "DOCUMENT_POLICY_UNAVAILABLE",
        "Politique documentaire indisponible sur cette base : le référentiel n'est pas installé."
      );
    }
    throw err;
  }
}

export async function setPieceCritiqueSVC(
  pieceTechniqueId: string,
  input: { piece_critique: boolean; motif?: string | null },
  audit: AuditContext
) {
  try {
    return await repoSetPieceCritique(pieceTechniqueId, input, audit);
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) {
      throw new HttpError(
        503,
        "DOCUMENT_POLICY_UNAVAILABLE",
        "Attribut « pièce critique » indisponible sur cette base : le référentiel n'est pas installé."
      );
    }
    throw err;
  }
}

export async function listFrozenRequirementsSVC(versionId: string) {
  try {
    return await repoListFrozenRequirements(versionId, db);
  } catch (err) {
    if (err instanceof DocumentPolicyInfrastructureMissing) return [];
    throw err;
  }
}
