import pool from "../../../config/database";
import type { WorkshopSupportKind } from "../services/workshop-support-paper";
import type { DbQueryer, OfDocumentRow } from "./of-versioning.repository";
export type FolderSourcePart = {
    kind: string;
    name: string;
    sha256: string;
    id?: string;
    version_id?: string;
    source_hash?: string;
};
export type WorkshopFolderRow = {
    id: string;
    of_id: number;
    document_id: string;
    revision_id: string;
    document_status: string;
    source_fingerprint: string;
    source_manifest: FolderSourcePart[];
    preparation_kind: WorkshopSupportKind | null;
    created_by: number;
    created_at: string;
    preparation_actor_id?: number;
};
export type FolderCopyRow = {
    folder_id: string;
    copy_mark: string;
    pdf_sha256: string;
    pdf_byte_size: number;
    page_count: number;
    page_manifest: Array<{
        kind: string;
        name: string;
        sha256: string;
        first_page: number;
        page_count: number;
    }>;
    ged_document_id: string;
    ged_version_id: string;
};
const select = `SELECT id::text,of_id::int,document_id::text,revision_id::text,document_status,source_fingerprint,
  source_manifest,preparation_kind,created_by,created_at FROM public.of_workshop_folders`;
export async function getWorkshopFolder(ofId: number, id: string, tx: DbQueryer = pool): Promise<WorkshopFolderRow | null> {
    return (await tx.query<WorkshopFolderRow>(`${select} WHERE of_id=$1 AND id=$2::uuid`, [ofId, id])).rows[0] ?? null;
}
export async function findWorkshopFolderByKey(key: string, tx: DbQueryer = pool): Promise<WorkshopFolderRow | null> {
    return (await tx.query<WorkshopFolderRow>(`SELECT folder.id::text,folder.of_id::int,folder.document_id::text,folder.revision_id::text,
    folder.document_status,folder.source_fingerprint,folder.source_manifest,folder.preparation_kind,folder.created_by,folder.created_at,
    request.actor_id AS preparation_actor_id FROM public.of_workshop_folders folder
    JOIN public.of_workshop_folder_preparations request ON request.folder_id=folder.id WHERE request.idempotency_key=$1`, [key])).rows[0] ?? null;
}
export async function bindWorkshopFolderPreparation(tx: DbQueryer, key: string, folderId: string, actorId: number) {
    await tx.query(`INSERT INTO public.of_workshop_folder_preparations(idempotency_key,folder_id,actor_id) VALUES($1,$2::uuid,$3)`, [key, folderId, actorId]);
}
export async function findWorkshopFolderBySource(tx: DbQueryer, documentId: string, fingerprint: string): Promise<WorkshopFolderRow | null> {
    return (await tx.query<WorkshopFolderRow>(`${select} WHERE document_id=$1::uuid AND source_fingerprint=$2`, [documentId, fingerprint])).rows[0] ?? null;
}
export async function insertWorkshopFolder(tx: DbQueryer, document: OfDocumentRow, input: {
    fingerprint: string;
    manifest: FolderSourcePart[];
    preparationKind: WorkshopSupportKind | null;
    actorId: number;
    key: string;
}) {
    const result = await tx.query<{
        id: string;
    }>(`INSERT INTO public.of_workshop_folders
    (of_id,document_id,revision_id,document_status,source_fingerprint,source_manifest,preparation_kind,created_by,idempotency_key)
    VALUES($1,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id::text`, [document.of_id, document.id, document.revision_id, document.statut, input.fingerprint, JSON.stringify(input.manifest), input.preparationKind, input.actorId, input.key]);
    return (await getWorkshopFolder(document.of_id, result.rows[0].id, tx))!;
}
export async function getWorkshopFolderCopy(tx: DbQueryer, folderId: string, mark: string): Promise<FolderCopyRow | null> {
    return (await tx.query<FolderCopyRow>(`SELECT folder_id::text,copy_mark,pdf_sha256,pdf_byte_size,page_count,page_manifest,
    ged_document_id::text,ged_version_id::text FROM public.of_workshop_folder_copies WHERE folder_id=$1::uuid AND copy_mark=$2`, [folderId, mark])).rows[0] ?? null;
}
export async function insertWorkshopFolderCopy(tx: DbQueryer, copy: FolderCopyRow) {
    await tx.query(`INSERT INTO public.of_workshop_folder_copies
    (folder_id,copy_mark,pdf_sha256,pdf_byte_size,page_count,page_manifest,ged_document_id,ged_version_id)
    VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::uuid,$8::uuid)`, [copy.folder_id, copy.copy_mark, copy.pdf_sha256, copy.pdf_byte_size, copy.page_count, JSON.stringify(copy.page_manifest), copy.ged_document_id, copy.ged_version_id]);
}
export async function getWorkshopFolderPrint(intentId: string, tx: DbQueryer = pool): Promise<{
    folder_id: string;
    copy_mark: string;
} | null> {
    return (await tx.query<{
        folder_id: string;
        copy_mark: string;
    }>(`SELECT folder_id::text,copy_mark FROM public.of_workshop_folder_prints WHERE intent_id=$1::uuid`, [intentId])).rows[0] ?? null;
}
export async function insertWorkshopFolderPrint(tx: DbQueryer, intentId: string, folderId: string, mark: string) {
    await tx.query(`INSERT INTO public.of_workshop_folder_prints(intent_id,folder_id,copy_mark) VALUES($1::uuid,$2::uuid,$3)`, [intentId, folderId, mark]);
}
/** Freeze the preparation-sheet decision on the first packet edition. An older
 * validated OF for the same root/indice makes this a repeat, not a new piece. */
export async function workshopPreparationKind(tx: DbQueryer, ofId: number, index: string | null): Promise<WorkshopSupportKind | null> {
    const row = (await tx.query<{
        previous: boolean;
        same_index: boolean;
    }>(`
    SELECT count(*)>0 AS previous,COALESCE(bool_or(previous.technical_snapshot#>>'{version,indice_externe}'=$2),false) AS same_index
      FROM public.ordres_fabrication current_order
      JOIN public.pieces_techniques current_piece ON current_piece.id=current_order.piece_technique_id
      JOIN public.pieces_techniques previous_piece ON previous_piece.root_piece_technique_id=current_piece.root_piece_technique_id
      JOIN public.ordres_fabrication previous ON previous.piece_technique_id=previous_piece.id
       AND previous.id<>current_order.id AND previous.created_at<current_order.created_at
     WHERE current_order.id=$1 AND previous.technical_readiness='VALIDATED' AND previous.technical_snapshot_sha256 IS NOT NULL
       AND previous.statut::text NOT IN('ANNULE','ARCHIVE')`, [ofId, index])).rows[0];
    return row?.same_index ? null : row?.previous ? "PREPARATION_INDEX" : "PREPARATION_CREATION";
}
