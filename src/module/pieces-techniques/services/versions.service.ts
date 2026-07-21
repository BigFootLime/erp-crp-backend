// src/module/pieces-techniques/services/versions.service.ts
// GPAO B2.1 — logique métier des versions (transitions + règle "une seule APPLICABLE").
import { HttpError } from "../../../utils/httpError"
import type { AuditContext } from "../repository/pieces-techniques.repository"
import {
  repoCreateNextVersion,
  repoCreateVersion,
  repoGetVersion,
  repoListVersions,
  repoUpdateVersion,
  repoUpdateVersionStatus,
} from "../repository/versions.repository"
import type {
  CreateNextVersionBodyDTO,
  CreateVersionBodyDTO,
  UpdateVersionBodyDTO,
  VersionStatusBodyDTO,
  VersionStatutDTO,
} from "../validators/versions.validators"

// BROUILLON → EN_VALIDATION → APPLICABLE → OBSOLETE (retour EN_VALIDATION→BROUILLON permis).
const TRANSITIONS: Record<VersionStatutDTO, readonly VersionStatutDTO[]> = {
  BROUILLON: ["EN_VALIDATION", "OBSOLETE"],
  EN_VALIDATION: ["APPLICABLE", "BROUILLON", "OBSOLETE"],
  APPLICABLE: ["OBSOLETE"],
  OBSOLETE: [],
}

export function isValidVersionTransition(from: VersionStatutDTO, to: VersionStatutDTO): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

export const listVersionsSVC = (pieceTechniqueId: string) => repoListVersions(pieceTechniqueId)

export const createVersionSVC = (pieceTechniqueId: string, body: CreateVersionBodyDTO, audit: AuditContext) =>
  repoCreateVersion(pieceTechniqueId, body, audit)

export const updateVersionSVC = (pieceTechniqueId: string, versionId: string, body: UpdateVersionBodyDTO, audit: AuditContext) =>
  repoUpdateVersion(pieceTechniqueId, versionId, body, audit)

export async function updateVersionStatusSVC(
  pieceTechniqueId: string,
  versionId: string,
  body: VersionStatusBodyDTO,
  audit: AuditContext
) {
  const current = await repoGetVersion(pieceTechniqueId, versionId)
  if (!current) return null
  if (!isValidVersionTransition(current.statut, body.next_statut)) {
    throw new HttpError(409, "INVALID_TRANSITION", `Transition invalide ${current.statut} → ${body.next_statut}`)
  }
  return repoUpdateVersionStatus(
    pieceTechniqueId,
    versionId,
    body.next_statut,
    {
      // The authenticated actor is the only valid validation author.  A client
      // supplied user id would make the audit trail forgeable.
      valide_par: audit.user_id,
      date_application: body.date_application ?? null,
      commentaire_validation: body.commentaire_validation ?? null,
      expected_updated_at: body.expected_updated_at,
    },
    audit
  )
}

export const createNextVersionSVC = (
  pieceTechniqueId: string,
  sourceVersionId: string,
  body: CreateNextVersionBodyDTO,
  audit: AuditContext
) => repoCreateNextVersion(pieceTechniqueId, sourceVersionId, body, audit)
