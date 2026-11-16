import db from "../../../config/database";
import type { StockDocument } from "../types/stock.types";

export async function repoListArticleDocuments(articleId: string): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid`,
    [articleId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        ad.type,
        ad.revision,
        ad.version::int AS version,
        sd.mime_type,
        sd.size_bytes::float8 AS size_bytes,
        sd.sha256,
        ad.uploaded_by,
        ad.created_at::text AS created_at,
        ad.updated_at::text AS updated_at,
        ad.is_active
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1::uuid
        AND ad.is_active = true
        AND sd.removed_at IS NULL
      ORDER BY ad.created_at DESC, ad.id DESC
    `,
    [articleId]
  );
  return res.rows;
}
