import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { readSupplierPurchaseQualificationTx } from '../../commande-fournisseur/repository/purchase-qualification.repository';
import { readOfPurchaseClientContextsTx } from '../../commande-fournisseur/repository/purchase-client-context.repository';
import type { PurchaseScopeLine } from '../../fournisseurs/domain/purchase-qualification';

export const OF_PURCHASE_SCOPE_SQL = `WITH dossier AS (
  SELECT COALESCE(o.technical_snapshot->'preparation_evidence'->'purchases',
    (SELECT jsonb_agg(to_jsonb(p)) FROM public.pieces_techniques_achats p
     WHERE p.piece_technique_id=o.piece_technique_id AND p.piece_technique_version_id=
       COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
         NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid)), '[]') AS purchases
  FROM public.ordres_fabrication o WHERE o.id=$1
) SELECT $2::uuid::text AS id,1 AS position,
  CASE WHEN p->>'type_achat' IN ('SOUS_TRAITANCE','TRAITEMENT') THEN 'SOUS_TRAITANCE'
    WHEN p->>'type_achat'='MATIERE' THEN 'MATIERE' ELSE 'ARTICLE' END AS type,
  CASE WHEN p->>'type_achat'='CONSOMMABLE' THEN 'CONSOMMABLE' END AS catalogue_type,
  ARRAY(SELECT ac.category_code FROM public.article_category_link ac
    WHERE ac.article_id=$2::uuid ORDER BY ac.category_code) AS categories
  FROM dossier d CROSS JOIN LATERAL jsonb_array_elements(d.purchases) p
  WHERE p->>'article_id'=$2::uuid::text
    AND p->>'type_achat' IN ('MATIERE','CONSOMMABLE','SOUS_TRAITANCE','TRAITEMENT') LIMIT 1`;

/** A diagnostic only: no order, reservation, approval or audit mutation. */
export async function getOfSupplierQualification(ofId: number, articleId: string, supplierId: string, catalogueId?: string) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const line = (await tx.query<PurchaseScopeLine>(OF_PURCHASE_SCOPE_SQL, [ofId, articleId])).rows[0];
    if (!line) throw new HttpError(409, 'OF_PURCHASE_ARTICLE_NOT_APPLICABLE',
      'Cet article ne fait pas partie des achats de la version actuelle de l’OF. Actualisez sa préparation.');
    const supplier = (await tx.query<{ today: string; checked_at: string }>(`
      SELECT (statement_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today,
        statement_timestamp()::text AS checked_at
      FROM public.fournisseurs WHERE id=$1::uuid AND actif IS NOT FALSE`, [supplierId])).rows[0];
    if (!supplier) throw new HttpError(404, 'FOURNISSEUR_NOT_FOUND', 'Fournisseur actif introuvable.');
    if (catalogueId) {
      const catalogue = (await tx.query<{type:string}>(`
        SELECT type FROM public.fournisseur_catalogue WHERE id=$1::uuid AND article_id=$2::uuid
          AND fournisseur_id=$3::uuid AND actif
          AND (valid_from IS NULL OR valid_from<=(statement_timestamp() AT TIME ZONE 'Europe/Paris')::date)
          AND (valid_to IS NULL OR valid_to>=(statement_timestamp() AT TIME ZONE 'Europe/Paris')::date)`,
        [catalogueId,articleId,supplierId])).rows[0];
      if (!catalogue) throw new HttpError(409,'OF_SUPPLIER_CATALOGUE_NOT_APPLICABLE',
        'Les conditions fournisseur ne sont plus applicables à cet article. Actualisez la sélection.');
      line.catalogue_type = catalogue.type;
    }
    const contexts = await readOfPurchaseClientContextsTx(tx, ofId, articleId);
    const data = await readSupplierPurchaseQualificationTx(tx, {
      supplierId, today: supplier.today, checkedAt: supplier.checked_at, lines: [line], contexts,
    });
    await tx.query('COMMIT');
    return { data };
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}
