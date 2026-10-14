import pool from "../../../config/database";
import type { DbQueryer } from "./of-versioning.repository";

export type OfPrintIntent = {
  id: string; of_id: number; document_id: string; revision_id: string; actor_id: number;
  document_status: string; official_ordinal: number | null; copy_mark: string | null;
  copy_sha256: string; copy_byte_size: number; created_at: string;
};
export type OfPrintVariant = {
  pdf_sha256: string; pdf_byte_size: number; ged_document_id: string; ged_version_id: string;
};
const intentSelect = `SELECT id::text, of_id::int, document_id::text, revision_id::text, actor_id,
  document_status, official_ordinal, copy_mark, copy_sha256, copy_byte_size, created_at
  FROM public.of_document_print_intents`;

export async function findPrintIntent(key: string, tx: DbQueryer = pool): Promise<OfPrintIntent | null> {
  return (await tx.query<OfPrintIntent>(`${intentSelect} WHERE idempotency_key=$1`, [key])).rows[0] ?? null;
}
export async function lockPrintKey(tx: DbQueryer, key: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1320))", [key]);
}
export async function officialPrintCount(tx: DbQueryer, ofId: number, revisionId: string): Promise<number> {
  const result = await tx.query<{ count: number }>(`SELECT COALESCE(MAX(official_ordinal),0)::int AS count
    FROM public.of_document_print_intents WHERE of_id=$1 AND revision_id=$2::uuid`, [ofId, revisionId]);
  return result.rows[0].count;
}
export async function readPrintVariant(tx: DbQueryer, documentId: string, mark: string): Promise<OfPrintVariant | null> {
  return (await tx.query<OfPrintVariant>(`SELECT pdf_sha256,pdf_byte_size,ged_document_id::text,ged_version_id::text
    FROM public.of_document_print_variants WHERE document_id=$1::uuid AND copy_mark=$2`, [documentId,mark])).rows[0] ?? null;
}
export async function insertPrintVariant(tx: DbQueryer, documentId: string, mark: string, variant: OfPrintVariant) {
  await tx.query(`INSERT INTO public.of_document_print_variants
    (document_id,copy_mark,pdf_sha256,pdf_byte_size,ged_document_id,ged_version_id)
    VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid)`,
  [documentId,mark,variant.pdf_sha256,variant.pdf_byte_size,variant.ged_document_id,variant.ged_version_id]);
}
export async function insertPrintIntent(tx: DbQueryer, key: string, input: Omit<OfPrintIntent,"id"|"created_at">): Promise<OfPrintIntent> {
  const row = await tx.query<{ id: string }>(`INSERT INTO public.of_document_print_intents
    (of_id,document_id,revision_id,actor_id,document_status,official_ordinal,copy_mark,copy_sha256,copy_byte_size,idempotency_key)
    VALUES($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
  [input.of_id,input.document_id,input.revision_id,input.actor_id,input.document_status,input.official_ordinal,input.copy_mark,
    input.copy_sha256,input.copy_byte_size,key]);
  const result = await tx.query<OfPrintIntent>(`${intentSelect} WHERE id=$1::uuid`, [row.rows[0].id]);
  return result.rows[0];
}
