import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { ProductionReferenceListQuery } from "../validators/production-references.validators";

export type ReferenceOption = { value: string; label: string };
export type ProductionPieceReference = { id: string; code_piece: string; designation: string };
export type ProductionPieceVersionReference = {
  id: string;
  indice: string;
  indice_externe_original: string | null;
  version_interne: number | null;
  statut: "BROUILLON" | "EN_VALIDATION" | "APPLICABLE" | "OBSOLETE";
  plan_reference: string | null;
  date_application: string | null;
  date_effet: string | null;
  raison_changement: string | null;
  updated_at: string;
};

export async function repoListProductionReferenceClients(query: ProductionReferenceListQuery): Promise<{ items: ReferenceOption[] }> {
  const values: unknown[] = [];
  const conditions = ["TRUE"];
  if (query.q) {
    values.push(`%${query.q}%`);
    conditions.push(`(c.company_name ILIKE $${values.length} OR COALESCE(c.client_code, '') ILIKE $${values.length})`);
  }
  values.push(query.limit);
  const result = await pool.query<{ value: string; label: string }>(
    `SELECT c.client_id::text AS value,
      CASE WHEN NULLIF(btrim(c.client_code), '') IS NULL THEN c.company_name
        ELSE c.company_name || ' (' || c.client_code || ')' END AS label
     FROM public.clients c
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.company_name ASC, c.client_id ASC
     LIMIT $${values.length}`,
    values,
  );
  return { items: result.rows };
}

export async function repoListProductionReferencePieces(query: ProductionReferenceListQuery): Promise<{ items: ProductionPieceReference[] }> {
  const values: unknown[] = [];
  const conditions = ["p.deleted_at IS NULL"];
  if (query.client_id) {
    values.push(query.client_id);
    conditions.push(`p.client_id = $${values.length}`);
  }
  if (query.q) {
    values.push(`%${query.q}%`);
    conditions.push(`(p.code_piece ILIKE $${values.length} OR p.designation ILIKE $${values.length})`);
  }
  values.push(query.limit);
  const result = await pool.query<ProductionPieceReference>(
    `SELECT p.id::text AS id, p.code_piece, p.designation
     FROM public.pieces_techniques p
     WHERE ${conditions.join(" AND ")}
     ORDER BY p.code_piece ASC, p.id ASC
     LIMIT $${values.length}`,
    values,
  );
  return { items: result.rows };
}

export async function repoListProductionReferencePieceVersions(pieceId: string): Promise<{ items: ProductionPieceVersionReference[] }> {
  const result = await pool.query<ProductionPieceVersionReference>(
    `SELECT v.id::text AS id, v.indice, v.indice_externe_original,
        v.version_interne::int AS version_interne, v.statut, v.plan_reference,
        v.date_application::text AS date_application, v.date_effet::text AS date_effet,
        v.raison_changement, v.updated_at::text AS updated_at
     FROM public.piece_technique_versions v
     JOIN public.pieces_techniques p ON p.id = v.piece_technique_id
     WHERE v.piece_technique_id = $1::uuid
       AND p.deleted_at IS NULL
     ORDER BY v.version_interne DESC NULLS LAST, v.updated_at DESC, v.id DESC`,
    [pieceId],
  );
  return { items: result.rows };
}

export type ReceiptStockReference = {
  lot_id: string;
  lot_code: string;
  client_code: string | null;
  article_reference: string | null;
  piece_indice: string | null;
  article_designation: string;
  of_references: string[];
  mp_references: string[];
  tr_references: string[];
};

export async function repoGetReceiptStockReference(params: { ofId: number; movementId: string }): Promise<ReceiptStockReference> {
  const result = await pool.query<ReceiptStockReference>(
    `SELECT r.lot_id::text AS lot_id, l.lot_code, pt.code_client,
        v.plan_reference AS article_reference, v.indice AS piece_indice,
        pt.designation AS article_designation,
        ARRAY[o.numero]::text[] AS of_references,
        ARRAY[]::text[] AS mp_references, ARRAY[]::text[] AS tr_references
     FROM public.of_receipts r
     JOIN public.ordres_fabrication o ON o.id = r.of_id
     JOIN public.lots l ON l.id = r.lot_id
     JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
     LEFT JOIN public.piece_technique_versions v ON v.id = o.piece_technique_version_id
     WHERE r.stock_movement_id = $1::uuid AND r.of_id = $2::bigint
     LIMIT 1`,
    [params.movementId, params.ofId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "OF_RECEIPT_NOT_FOUND", "Réception introuvable pour cet OF.");
  return row;
}