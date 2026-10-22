import type { PoolClient } from "pg";
import { HttpError } from "../../../../utils/httpError";
import { catalogFor } from "../../domain/cutover-catalog";
import { assertGedVersionParentReadable } from "../../../ged/services/ged-parent-authorization.service";

function evidenceField(domain: Parameters<typeof catalogFor>[0], fieldKey: string) {
  const field = catalogFor(domain).fields.find((item) => item.key === fieldKey && item.group === "Justificatifs");
  if (!field) throw new HttpError(422,"CUTOVER_EVIDENCE_FIELD_INVALID","Ce champ n'accepte pas de justificatif GED.");
}
export async function linkCutoverEvidenceTx(tx: PoolClient, input: {batchId:string;rowId:string;fieldKey:string;gedDocumentId:string;actorId:number}) {
  const row=(await tx.query<{domain:Parameters<typeof catalogFor>[0]}>("SELECT domain FROM public.data_cutover_rows WHERE id=$1::uuid AND batch_id=$2::uuid FOR KEY SHARE",[input.rowId,input.batchId])).rows[0];
  if(!row) throw new HttpError(404,"CUTOVER_ROW_NOT_FOUND","Fiche de reprise introuvable.");
  evidenceField(row.domain,input.fieldKey);
  const document=(await tx.query<{id:string;version_id:string;title:string;original_name:string;sha256:string;size_bytes:string}>(`SELECT d.id::text,v.id::text AS version_id,d.title,v.original_name,b.sha256,b.size_bytes::text FROM public.ged_documents d JOIN public.ged_document_versions v ON v.id=d.current_version_id JOIN public.ged_blobs b ON b.id=v.blob_id WHERE d.id=$1::uuid AND d.archived_at IS NULL`,[input.gedDocumentId])).rows[0];
  if(!document) throw new HttpError(404,"GED_VERSION_NOT_FOUND","Version introuvable.");
  // Native GED authorization is evaluated against the document owning the current version.
  await assertGedVersionParentReadable(input.actorId,document.id);
  const snapshot={document_id:document.id,current_version_id:document.version_id,title:document.title,original_name:document.original_name,sha256:document.sha256,size_bytes:document.size_bytes};
  const inserted = await tx.query<{ snapshot: typeof snapshot }>(`INSERT INTO public.data_cutover_evidence_links(batch_id,row_id,field_key,ged_document_id,snapshot,created_by) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb,$6) ON CONFLICT(row_id,field_key,ged_document_id) DO NOTHING RETURNING snapshot`,[input.batchId,input.rowId,input.fieldKey,input.gedDocumentId,JSON.stringify(snapshot),input.actorId]);
  if (inserted.rows[0]) return inserted.rows[0].snapshot;
  // A retry must describe the version originally frozen, even if a newer GED
  // version has since become current. Never report an unrecorded snapshot.
  const existing = await tx.query<{ snapshot: typeof snapshot }>("SELECT snapshot FROM public.data_cutover_evidence_links WHERE row_id=$1::uuid AND field_key=$2 AND ged_document_id=$3::uuid", [input.rowId,input.fieldKey,input.gedDocumentId]);
  if (!existing.rows[0]) throw new Error("CUTOVER_EVIDENCE_LINK_MISSING");
  return existing.rows[0].snapshot;
}
export async function listEvidenceTx(tx:Pick<PoolClient,"query">,batchId:string,rowId?:string) {
 const result=await tx.query<{row_id:string;field_key:string;ged_document_id:string;snapshot:Record<string,unknown>;created_at:string}>(`SELECT row_id::text,field_key,ged_document_id::text,snapshot,created_at::text FROM public.data_cutover_evidence_links WHERE batch_id=$1::uuid AND ($2::uuid IS NULL OR row_id=$2::uuid) ORDER BY created_at,id`,[batchId,rowId??null]);
 return result.rows;
}
