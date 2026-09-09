import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoCreateFournisseurCatalogueItem, repoUpdateFournisseurCatalogueItem } from "../../fournisseurs/repository/fournisseurs.repository";
import type { AuditContext } from "./stock.repository";
import type { ArticleSupplierCondition } from "../validators/stock.validators";
import { createCatalogueSchema } from "../../fournisseurs/validators/fournisseurs.validators";

/** Article + catalogue conditions share the article transaction and its concurrency guard. */
export async function syncArticleSupplierConditionsTx(tx: PoolClient, articleId: string,
  conditions: ArticleSupplierCondition[] | undefined, audit: AuditContext) {
  if (conditions === undefined) return;
  const article = (await tx.query(`SELECT a.designation,a.unite,a.receipt_quality_required,
    EXISTS(SELECT 1 FROM public.article_category_link WHERE article_id=a.id AND category_code='consommable') AS consumable
    FROM public.articles a WHERE a.id=$1::uuid`,[articleId])).rows[0];
  if (!article?.consumable) throw new HttpError(422,"CONSUMABLE_CATEGORY_REQUIRED","Ces conditions sont réservées aux consommables.");
  if (conditions.filter(c=>c.preferred).length>1) throw new HttpError(422,"PREFERRED_SUPPLIER_AMBIGUOUS","Choisissez un seul fournisseur préféré.");
  if (!conditions.some(c=>c.preferred)) await tx.query(`UPDATE public.article_procurement_profile
    SET preferred_catalogue_id=NULL,updated_at=now(),updated_by=$2 WHERE article_id=$1::uuid`,[articleId,audit.user_id]);
  for (const condition of conditions) {
    const {supplier_id,catalogue_id,preferred,...input}=condition;
    if (catalogue_id && !(await tx.query(`SELECT id FROM public.fournisseur_catalogue WHERE id=$1::uuid
      AND article_id=$2::uuid AND fournisseur_id=$3::uuid FOR UPDATE`,[catalogue_id,articleId,supplier_id])).rowCount)
      throw new HttpError(409,"ARTICLE_CATALOGUE_CHANGED","La référence fournisseur ne correspond plus à cet article.");
    const unit=input.unite??article.unite;
    const stockUnit=input.unite_stock??article.unite;
    if(stockUnit!==article.unite || (unit!==stockUnit && !input.coef_conversion))
      throw new HttpError(422,"SUPPLIER_CONVERSION_REQUIRED","Précisez la conversion vers l’unité de stock de l’article.");
    const body={...input,type:"CONSOMMABLE" as const,article_id:articleId,designation:article.designation,
      unite:unit,unite_stock:stockUnit,coef_conversion:input.coef_conversion??1};
    const saved=catalogue_id
      ? await repoUpdateFournisseurCatalogueItem(supplier_id,catalogue_id,body,audit,tx)
      : await repoCreateFournisseurCatalogueItem(supplier_id,createCatalogueSchema.parse({body}).body,audit,tx);
    if (!saved) throw new HttpError(404,"SUPPLIER_NOT_FOUND","Le fournisseur ou sa référence n’existe plus.");
    if(preferred && !saved.actif) throw new HttpError(422,"PREFERRED_SUPPLIER_INACTIVE","Le fournisseur préféré doit avoir une référence active.");
    if(preferred) await tx.query(`INSERT INTO public.article_procurement_profile(article_id,preferred_catalogue_id,created_by,updated_by)
      VALUES($1::uuid,$2::uuid,$3,$3) ON CONFLICT(article_id) DO UPDATE SET preferred_catalogue_id=EXCLUDED.preferred_catalogue_id,
      updated_at=now(),updated_by=EXCLUDED.updated_by`,[articleId,saved.id,audit.user_id]);
  }
}
