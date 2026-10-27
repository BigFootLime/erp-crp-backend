import pool from "../../../config/database";

export type ImportedEquipmentSource = {
  id: string; storage_path: string; source_name: string; mime_type: string | null;
  size_bytes: string; sha256: string; av_status: string; created_at: string;
};

export async function repoListEquipmentDocumentRefs(equipmentId: string, page: number, pageSize: number) {
  const result = await pool.query<{ id: string; origin: "ged" | "source"; total: string }>([
    "WITH refs AS (",
    "SELECT d.id, 'ged'::text AS origin, d.created_at FROM public.ged_documents d",
    "JOIN public.ged_document_links l ON l.document_id=d.id",
    "WHERE l.entity_type='METROLOGIE_EQUIPEMENT' AND l.entity_id=$1",
    "AND d.class_key='METROLOGIE_SCAN' AND d.archived_at IS NULL",
    "UNION",
    "SELECT f.id, 'source'::text AS origin, f.created_at FROM public.metrologie_import_source_files f",
    "WHERE EXISTS (SELECT 1 FROM public.metrologie_import_raw_rows r",
    "WHERE r.source_file_id=f.id AND r.target_equipment_id=$1::uuid)",
    ") SELECT id::text,origin,count(*) OVER()::text AS total FROM refs",
    "ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
  ].join(" "), [equipmentId, pageSize, (page - 1) * pageSize]);
  // COUNT OVER is absent on an empty later page. Count that case explicitly
  // so pagination never reports a false zero while other pages contain data.
  let total = Number(result.rows[0]?.total ?? 0);
  if (page > 1 && result.rows.length === 0) {
    const count = await pool.query<{ total: string }>([
      "SELECT (",
      "(SELECT count(DISTINCT d.id) FROM public.ged_documents d",
      "JOIN public.ged_document_links l ON l.document_id=d.id",
      "WHERE l.entity_type='METROLOGIE_EQUIPEMENT' AND l.entity_id=$1",
      "AND d.class_key='METROLOGIE_SCAN' AND d.archived_at IS NULL)+",
      "(SELECT count(*) FROM public.metrologie_import_source_files f WHERE EXISTS",
      "(SELECT 1 FROM public.metrologie_import_raw_rows r WHERE r.source_file_id=f.id AND r.target_equipment_id=$1::uuid))",
      ")::text AS total",
    ].join(" "), [equipmentId]);
    total = Number(count.rows[0]?.total ?? 0);
  }
  return { items: result.rows.map(({ total: _total, ...row }) => row), total };
}

export async function repoGetImportedEquipmentSource(equipmentId: string, sourceId: string): Promise<ImportedEquipmentSource | null> {
  const result = await pool.query<ImportedEquipmentSource>([
    "SELECT f.id::text,f.storage_path,f.source_name,f.mime_type,f.size_bytes::text,",
    "f.sha256,f.av_status,f.created_at::text FROM public.metrologie_import_source_files f",
    "WHERE f.id=$2::uuid AND EXISTS (SELECT 1 FROM public.metrologie_import_raw_rows r",
    "WHERE r.source_file_id=f.id AND r.target_equipment_id=$1::uuid)",
  ].join(" "), [equipmentId, sourceId]);
  return result.rows[0] ?? null;
}
