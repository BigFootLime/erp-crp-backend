import type { PoolClient } from "pg";

export function canCarryMinorRevisionDocuments(input: { changeLevel: string; sourceIndex: string; targetIndex: string; sourcePlan: string | null; targetPlan: string | null }): boolean {
  return input.changeLevel === "MINOR" && input.sourceIndex.trim().toUpperCase() === input.targetIndex.trim().toUpperCase()
    && (input.sourcePlan?.trim() || null) === (input.targetPlan?.trim() || null);
}

/** Preserve existing approved files for an internal revision, never for a new client drawing. */
export async function copyMinorRevisionDocumentsTx(tx: Pick<PoolClient, "query">, pieceId: string, sourceId: string, targetId: string, actorId: number): Promise<number> {
  const result = await tx.query(`INSERT INTO public.ged_document_links(document_id,entity_type,entity_id,link_role,created_by)
    SELECT DISTINCT l.document_id,'PIECE_TECHNIQUE_VERSION',target.id::text,l.link_role,$4::integer
      FROM public.piece_technique_versions source
      JOIN public.piece_technique_versions target ON target.id=$3::uuid AND target.piece_technique_id=source.piece_technique_id
        AND target.change_level='MINOR' AND target.copied_from_version_id=source.id
        AND upper(trim(COALESCE(target.indice_externe_original,target.indice)))=upper(trim(COALESCE(source.indice_externe_original,source.indice)))
        AND NULLIF(trim(target.plan_reference),'') IS NOT DISTINCT FROM NULLIF(trim(source.plan_reference),'')
      JOIN public.ged_document_links l ON l.entity_type='PIECE_TECHNIQUE_VERSION' AND l.entity_id=source.id::text
      JOIN public.ged_documents d ON d.id=l.document_id AND d.archived_at IS NULL
      JOIN public.ged_document_versions v ON v.id=d.current_version_id AND v.status='APPLICABLE'
      JOIN public.ged_upload_sessions scan ON scan.id=v.upload_session_id AND scan.scan_status='clean' AND scan.quarantine_status='released'
     WHERE source.id=$2::uuid AND source.piece_technique_id=$1::uuid
       AND ((l.link_role='PLAN_CLIENT' AND d.class_key='PLAN_CLIENT')
         OR (l.link_role='PLAN_FABRICATION' AND d.class_key='GAMME_DOC')
         OR (l.link_role='FICHE_AUTOCONTROLE' AND d.class_key='RELEVE_CONTROLE'))
    ON CONFLICT(document_id,entity_type,entity_id,link_role) DO NOTHING`, [pieceId, sourceId, targetId, actorId]);
  return result.rowCount ?? 0;
}
