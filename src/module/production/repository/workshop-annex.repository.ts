import { HttpError } from "../../../utils/httpError";
import type { OfDocumentPayload } from "../domain/of-document";
import { documentUuid, resolveOfDocumentTechnicalSource } from "../domain/of-document-technical-source";
import { workshopFrozenPlans } from "../domain/workshop-pack-documents";
import { getRevision, type DbQueryer, type OfDocumentRow } from "./of-versioning.repository";
import { readWorkshopPlanSources } from "./workshop-plan-sources.repository";

type InspectionSource = { id: string; pdf: Buffer; pdf_sha256: string; source_hash: string; quality_plan_id: string };
type RootSource = { snapshot: unknown; hash: string | null; sheet_id: string | null; execution_plan_id: string | null };

/** Internal sources only. The packet service will verify blobs and freeze the
 * exact selected annexes before accepting any print request. */
export async function readWorkshopAnnexSources(tx: DbQueryer, document: Pick<OfDocumentRow,"of_id"|"revision_id"|"payload">) {
  const root = (await tx.query<RootSource>(`
    SELECT technical_snapshot AS snapshot, technical_snapshot_sha256 AS hash,
           technical_preparation->>'self_inspection_sheet_id' AS sheet_id,
           technical_preparation#>>'{execution_quality,quality_plan,id}' AS execution_plan_id
      FROM public.ordres_fabrication WHERE id=$1`, [document.of_id])).rows[0];
  const revision = await getRevision(document.of_id, document.revision_id, tx);
  if (!root || !revision) throw new HttpError(404,"OF_DOCUMENT_NOT_FOUND","Dossier introuvable sur cet OF.");
  const source = resolveOfDocumentTechnicalSource({ revisionStatus: revision.statut, revisionHash: revision.snapshot_sha256,
    revisionSnapshot: revision.snapshot, rootHash: root.hash, rootSnapshot: root.snapshot });
  const payload = document.payload as OfDocumentPayload;
  const expected = payload.technicalEvidence?.source;
  if (!source.technicalVersionId || !expected || source.hash !== expected.hash
    || source.technicalVersionId !== expected.technicalVersionId) {
    throw new HttpError(409,"WORKSHOP_DEFINITION_UNAVAILABLE","Retrouvez la définition figée de cet OF avant de préparer son dossier.");
  }
  const references = workshopFrozenPlans(source.snapshot);
  const plans = await readWorkshopPlanSources(tx,source.technicalVersionId,references);
  const missingPlans = references.filter(ref => !plans.some(plan => plan.document_id === ref.id
    && plan.version_id === ref.version_id && plan.sha256 === ref.sha256 && plan.role === ref.role));
  const evidence = source.snapshot.preparation_evidence as { quality_plan?: { id?: unknown } } | undefined;
  const planId = documentUuid(evidence?.quality_plan?.id) ?? documentUuid(root.execution_plan_id);
  const sheetId = documentUuid(root.sheet_id);
  const inspection = sheetId && planId && payload.quantiteLancee !== undefined ? (await tx.query<InspectionSource>(`
    SELECT id::text,pdf,pdf_sha256,source_hash,quality_plan_id::text
      FROM public.of_self_inspection_sheets
     WHERE of_id=$1 AND id=$2::uuid AND piece_technique_version_id=$3::uuid
       AND quality_plan_id=$4::uuid AND state='READY' AND pdf IS NOT NULL AND pdf_sha256 IS NOT NULL
       AND snapshot#>>'{of,id}'=$1::text AND snapshot#>>'{version,id}'=$3::text
       AND snapshot#>>'{plan,id}'=$4::text AND snapshot#>'{of,quantite_lancee}'=to_jsonb($5::numeric)`,
    [document.of_id,sheetId,source.technicalVersionId,planId,payload.quantiteLancee])).rows[0] ?? null : null;
  return { source, plans, missingPlans, inspection, hasClientPlan: plans.some(plan => plan.role === "PLAN_CLIENT") };
}
