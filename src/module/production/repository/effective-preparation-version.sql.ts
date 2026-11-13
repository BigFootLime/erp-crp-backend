/**
 * A preparation draft may deliberately follow a newer compatible technical
 * revision before its immutable snapshot is created.  Once an OF is engaged
 * or frozen, its physical snapshot reference remains the only authority.
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

export function canAutoFollowCompatibleRevision(input: {
  mode?: "AUTO" | "MANUAL" | null;
  state: Pick<PreparationVersionState, "statut" | "technicalSnapshotSha256" | "technicalReadiness">;
  effectiveVersionId: string | null;
  sourceVersionId: string;
  sourceClientIndex: string | null;
  targetClientIndex: string | null;
  targetChangeLevel?: "MINOR" | "MAJOR";
  targetInterchangeable?: boolean;
}) {
  return input.mode !== "MANUAL" && input.state.statut === "BROUILLON" && !input.state.technicalSnapshotSha256
    && input.state.technicalReadiness !== "VALIDATED" && input.effectiveVersionId === input.sourceVersionId
    && !!input.sourceClientIndex && input.sourceClientIndex === input.targetClientIndex
    && (input.targetChangeLevel ?? "MINOR") === "MINOR" && input.targetInterchangeable !== true;
}
