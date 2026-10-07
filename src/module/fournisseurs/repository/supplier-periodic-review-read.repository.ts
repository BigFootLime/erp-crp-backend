import type { PoolClient } from "pg";
import pool from "../../../config/database";
type Queryer = Pick<PoolClient, "query">;
export const REVIEW_POLICIES_SQL = `SELECT s.id::text AS scope_id,s.supplier_id::text,s.domaine_code,p.id::text AS policy_id,p.revision,p.enabled,p.cadence_months,p.first_due::text,p.owner_id,
 concat_ws(' ',NULLIF(u.name,''),NULLIF(u.surname,'')) AS owner_name,u.username AS owner_username,p.reason,p.created_at::text,
 e.id::text AS last_evaluation_id,e.outcome AS last_outcome,e.evaluated_on::text AS last_evaluated_on,
 COALESCE(e.next_due,p.first_due)::text AS due_on,
 (p.enabled AND COALESCE(e.next_due,p.first_due)<(statement_timestamp() AT TIME ZONE 'Europe/Paris')::date) AS overdue,
 (p.enabled AND COALESCE(e.next_due,p.first_due)<=(statement_timestamp() AT TIME ZONE 'Europe/Paris')::date+30) AS due_soon
 FROM public.supplier_review_scopes s
 JOIN LATERAL(SELECT * FROM public.supplier_review_policies x WHERE x.scope_id=s.id ORDER BY revision DESC LIMIT 1)p ON true
 JOIN public.users u ON u.id=p.owner_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.supplier_review_evaluations x WHERE x.scope_id=s.id
 AND NOT EXISTS(SELECT 1 FROM public.supplier_review_evaluations replacement WHERE replacement.supersedes_id=x.id)
 ORDER BY x.evaluated_on DESC,x.created_at DESC LIMIT 1)e ON true`;
export const REVIEW_HISTORY_SQL = `SELECT e.id::text,e.scope_id::text,e.policy_id::text,p.revision AS policy_revision,e.period_from::text,e.period_to::text,
 e.evaluated_on::text,e.next_due::text,e.outcome,e.quality_score,e.delivery_score,e.responsiveness_score,e.observations,e.actions,e.evidence_snapshot AS evidence,
 e.supersedes_id::text,e.correction_reason,e.created_by,e.created_at::text,
 EXISTS(SELECT 1 FROM public.supplier_review_evaluations x WHERE x.supersedes_id=e.id) AS superseded
 FROM public.supplier_review_evaluations e JOIN public.supplier_review_scopes s ON s.id=e.scope_id JOIN public.supplier_review_policies p ON p.id=e.policy_id
 WHERE s.supplier_id=$1::uuid ORDER BY e.evaluated_on DESC,e.created_at DESC LIMIT 200`;
export const REVIEW_EVIDENCE_SQL = `SELECT d.id::text AS document_id,v.id::text AS version_id,d.code,d.title,v.version_number,v.original_name AS filename,b.sha256,b.size_bytes::int
 FROM public.ged_documents d JOIN public.ged_document_versions v ON v.document_id=d.id JOIN public.ged_blobs b ON b.id=v.blob_id
 WHERE d.class_key='CERP_EVALUATION_FOURNISSEUR' AND d.archived_at IS NULL AND v.status='APPLICABLE' AND b.mime_type='application/pdf' AND b.size_bytes<=10485760
 AND EXISTS(SELECT 1 FROM public.ged_upload_sessions u WHERE u.id=v.upload_session_id AND u.scan_status='clean' AND u.quarantine_status='released')
 AND (SELECT count(*) FROM public.ged_document_links l WHERE l.document_id=d.id)=1
 AND EXISTS(SELECT 1 FROM public.ged_document_links l WHERE l.document_id=d.id AND l.entity_type='FOURNISSEUR' AND l.entity_id=$1::text)`;
export async function readReviewEvidence(
  tx: Queryer,
  supplierId: string,
  versionId: string,
) {
  return (
    (
      await tx.query(
        REVIEW_EVIDENCE_SQL + " AND v.id=$2::uuid FOR SHARE OF d,v,b",
        [supplierId, versionId],
      )
    ).rows[0] ?? null
  );
}
export async function repoSupplierReviewBoard(supplierId: string) {
  const [policies, evaluations, policyHistory] = await Promise.all([
    pool.query(
      REVIEW_POLICIES_SQL +
        " WHERE s.supplier_id=$1::uuid ORDER BY s.domaine_code NULLS FIRST",
      [supplierId],
    ),
    pool.query(REVIEW_HISTORY_SQL, [supplierId]),
    pool.query(
      `SELECT p.id::text AS policy_id,p.scope_id::text,p.revision,p.enabled,p.cadence_months,p.first_due::text,p.owner_id,u.username AS owner_username,p.reason,p.created_by,p.created_at::text FROM public.supplier_review_policies p JOIN public.supplier_review_scopes s ON s.id=p.scope_id JOIN public.users u ON u.id=p.owner_id WHERE s.supplier_id=$1::uuid ORDER BY p.created_at DESC LIMIT 200`,
      [supplierId],
    ),
  ]);
  return {
    policies: policies.rows,
    evaluations: evaluations.rows,
    policy_history: policyHistory.rows,
  };
}
export async function repoReviewDueBoard() {
  return (
    await pool.query(
      `SELECT p.*,f.code,f.nom FROM (${REVIEW_POLICIES_SQL})p JOIN public.fournisseurs f ON f.id=p.supplier_id::uuid WHERE p.enabled AND p.due_soon ORDER BY p.due_on,p.owner_username,f.code LIMIT 500`,
    )
  ).rows;
}
export async function repoReviewEvidenceChoices(supplierId: string) {
  return (
    await pool.query(
      REVIEW_EVIDENCE_SQL + " ORDER BY d.code,v.version_number DESC LIMIT 100",
      [supplierId],
    )
  ).rows;
}
export async function repoReviewOwners() {
  return (
    await pool.query(
      `SELECT id::int,username,concat_ws(' ',NULLIF(name,''),NULLIF(surname,'')) AS name FROM public.users WHERE COALESCE(NULLIF(lower(trim(status)),''),'active') NOT IN ('inactive','blocked','suspended') ORDER BY username LIMIT 500`,
    )
  ).rows;
}
