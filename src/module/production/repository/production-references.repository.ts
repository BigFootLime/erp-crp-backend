import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { listConsolidatedInventorySVC } from "../../stock/services/stock.service";
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
  // Prove the production boundary before reading Stock: a caller cannot obtain
  // a general lot projection by supplying an unrelated movement identifier.
  const receipt = await pool.query<{ lot_id: string; lot_code: string }>(
    `SELECT receipt.lot_id::text AS lot_id, lot.lot_code
     FROM public.of_receipts receipt
     JOIN public.lots lot ON lot.id = receipt.lot_id
     WHERE receipt.stock_movement_id = $1::uuid
       AND receipt.of_id = $2::bigint
     LIMIT 1`,
    [params.movementId, params.ofId],
  );
  const linked = receipt.rows[0];
  if (!linked) throw new HttpError(404, "OF_RECEIPT_NOT_FOUND", "Réception introuvable pour cet OF.");

  // The stock read model remains the source of truth for article/customer and
  // traceability references. Match the immutable lot UUID afterwards; the lot
  // code is only the bounded search criterion accepted by that existing API.
  const inventory = await listConsolidatedInventorySVC({
    lot: linked.lot_code,
    page: 1,
    pageSize: 200,
    sortBy: "article_code",
    sortDir: "asc",
  });
  const row = inventory.items.find((item) => item.lot_id === linked.lot_id);
  if (!row) throw new HttpError(404, "OF_RECEIPT_STOCK_REFERENCE_NOT_FOUND", "Référence stock indisponible pour cette réception.");

  return {
    lot_id: linked.lot_id,
    lot_code: linked.lot_code,
    client_code: row.client_code,
    article_reference: row.article_reference,
    piece_indice: row.piece_indice,
    article_designation: row.article_designation,
    of_references: row.of_references,
    mp_references: row.mp_references,
    tr_references: row.tr_references,
  };
}
