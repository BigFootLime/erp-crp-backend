/**
 * A preparation draft uses its explicitly selected technical definition. Legacy
 * AUTO values remain readable but no longer retarget an OF when a revision is
 * created (#1833). Engaged or frozen OFs use their physical snapshot reference.
 */
export function effectivePreparationVersionSql(orderAlias: string) {
  const preparation = `${orderAlias}.technical_preparation`;
  return `CASE WHEN ${orderAlias}.statut='BROUILLON'
    AND ${orderAlias}.technical_snapshot_sha256 IS NULL
    AND COALESCE(${orderAlias}.technical_readiness,'')<>'VALIDATED'
    THEN COALESCE(NULLIF(${preparation}->>'selected_version_id','')::uuid,
      NULLIF(${preparation}->>'selected_draft_version_id','')::uuid,
      ${orderAlias}.piece_technique_version_id)
    ELSE ${orderAlias}.piece_technique_version_id END`;
}

export type PreparationVersionState = {
  statut: string;
  technicalSnapshotSha256: string | null;
  technicalReadiness: string | null;
  selectedVersionId: string | null;
  selectedDraftVersionId: string | null;
  physicalVersionId: string | null;
};

export function canAutoFollowCompatibleRevision(_input: {
  mode?: "AUTO" | "MANUAL" | null;
  state: Pick<PreparationVersionState, "statut" | "technicalSnapshotSha256" | "technicalReadiness">;
  effectiveVersionId: string | null;
  sourceVersionId: string;
  sourceClientIndex: string | null;
  targetClientIndex: string | null;
  targetChangeLevel?: "MINOR" | "MAJOR";
  targetInterchangeable?: boolean;
}) {
  // Revisions are chosen for the OF and no longer follow technical edits automatically.
  return false;
}
