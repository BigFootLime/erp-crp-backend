import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoCreateArticleTx, type AuditContext as ArticleAuditContext } from "../../stock/repository/stock.repository";
import { repoCreateCommandeFournisseur, type AuditContext as PurchaseAuditContext } from "../../commande-fournisseur/repository/commande-fournisseur.repository";
import type { CommercialCatalogueCreate, CommercialCatalogueItem, CommercialCataloguePatch } from "./commercial-catalogue";

type Tx = Pick<PoolClient, "query">;

const COLUMNS = `id::text,relation_id::text,local_article_id::text,supplier_catalogue_id::text,supplier_catalogue_mapping_id::text,supplier_article_id::text,
 supplier_piece_technique_id::text,supplier_piece_technique_version_id::text,supplier_reference,designation,unit,
 buyer_sale_unit_price::float8,buyer_sale_vat_rate::float8,purchase_unit_price::float8,purchase_vat_rate::float8,currency,version,active`;

function item(row: Record<string, unknown>): CommercialCatalogueItem {
  return {
    id: String(row.id), relation_id: String(row.relation_id), local_article_id: String(row.local_article_id), supplier_catalogue_id: String(row.supplier_catalogue_id), supplier_catalogue_mapping_id: String(row.supplier_catalogue_mapping_id),
    supplier_article_id: String(row.supplier_article_id), supplier_piece_technique_id: row.supplier_piece_technique_id == null ? null : String(row.supplier_piece_technique_id),
    supplier_piece_technique_version_id: row.supplier_piece_technique_version_id == null ? null : String(row.supplier_piece_technique_version_id),
    supplier_reference: row.supplier_reference == null ? null : String(row.supplier_reference), designation: String(row.designation), unit: String(row.unit),
    buyer_sale_unit_price: Number(row.buyer_sale_unit_price), buyer_sale_vat_rate: Number(row.buyer_sale_vat_rate),
    purchase_unit_price: Number(row.purchase_unit_price), purchase_vat_rate: Number(row.purchase_vat_rate), currency: String(row.currency), version: Number(row.version), active: Boolean(row.active),
  };
}

async function assertRelationAndCatalogue(tx: Tx, relationId: string, catalogueId: string, buyerCompanyId: string) {
  const result = await tx.query<{ local_supplier_id: string; status: string; catalogue_supplier_id: string; catalogue_active: boolean }>(
    `SELECT r.local_supplier_id::text,r.status,c.fournisseur_id::text AS catalogue_supplier_id,c.actif AS catalogue_active
       FROM public.intercompany_supplier_relations r JOIN public.fournisseur_catalogue c ON c.id=$2::uuid
      WHERE r.id=$1::uuid AND r.buyer_company_id=$3::uuid FOR SHARE OF r,c`, [relationId, catalogueId, buyerCompanyId]);
  const row = result.rows[0];
  if (!row || row.status !== "ACTIVE" || !row.catalogue_active || row.local_supplier_id !== row.catalogue_supplier_id)
    throw new HttpError(409, "INTERCOMPANY_RELATION_NOT_PURCHASABLE", "La relation fournisseur ou sa référence catalogue n'est pas active.");
}

export async function repoListCommercialCatalogueTx(tx: Tx, buyerCompanyId: string): Promise<CommercialCatalogueItem[]> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM public.intercompany_commercial_catalogue c
      JOIN public.intercompany_supplier_relations r ON r.id=c.relation_id
     WHERE r.buyer_company_id=$1::uuid ORDER BY c.designation,c.id`, [buyerCompanyId]);
  return result.rows.map(item);
}

export async function repoCreateCommercialCatalogueTx(tx: PoolClient, buyerCompanyId: string, input: CommercialCatalogueCreate, audit: ArticleAuditContext): Promise<CommercialCatalogueItem> {
  await assertRelationAndCatalogue(tx, input.relation_id, input.supplier_catalogue_id, buyerCompanyId);
  const localArticleId = input.local_article_id ?? (await repoCreateArticleTx(tx, {
    designation: input.local_article!.designation, article_type: "PURCHASED", article_category: "achat", family_code: input.local_article!.family_code,
    stock_managed: false, lot_tracking: false, is_sold: true, status: "VALIDE", unite: input.local_article!.unit, is_active: true,
  }, audit)).id;
  const linked = await tx.query<{ article_id: string | null }>(`SELECT article_id::text FROM public.fournisseur_catalogue WHERE id=$1::uuid FOR UPDATE`, [input.supplier_catalogue_id]);
  if (!linked.rows[0] || (linked.rows[0].article_id && linked.rows[0].article_id !== localArticleId))
    throw new HttpError(409, "INTERCOMPANY_CATALOGUE_ARTICLE_CONFLICT", "La référence fournisseur est déjà liée à un autre article local.");
  await tx.query(`UPDATE public.fournisseur_catalogue SET article_id=$2::uuid,updated_by=$3 WHERE id=$1::uuid`, [input.supplier_catalogue_id, localArticleId, audit.user_id]);
  const result = await tx.query<Record<string, unknown>>(
    `INSERT INTO public.intercompany_commercial_catalogue(relation_id,local_article_id,supplier_catalogue_id,supplier_catalogue_mapping_id,supplier_article_id,supplier_piece_technique_id,supplier_piece_technique_version_id,supplier_reference,designation,unit,buyer_sale_unit_price,buyer_sale_vat_rate,purchase_unit_price,purchase_vat_rate,currency,created_by,updated_by)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING ${COLUMNS}`,
    [input.relation_id, localArticleId, input.supplier_catalogue_id, input.supplier_catalogue_mapping_id, input.supplier_article_id, input.supplier_piece_technique_id ?? null, input.supplier_piece_technique_version_id ?? null, input.supplier_reference ?? null, input.designation, input.unit, input.buyer_sale_unit_price, input.buyer_sale_vat_rate, input.purchase_unit_price, input.purchase_vat_rate, input.currency, audit.user_id]);
  return item(result.rows[0]);
}

export async function repoPatchCommercialCatalogueTx(tx: Tx, buyerCompanyId: string, id: string, input: CommercialCataloguePatch, actorUserId: number): Promise<CommercialCatalogueItem> {
  const allowed = ["supplier_article_id","supplier_piece_technique_id","supplier_piece_technique_version_id","supplier_reference","designation","unit","buyer_sale_unit_price","buyer_sale_vat_rate","purchase_unit_price","purchase_vat_rate","currency","active"] as const;
  const values: unknown[] = [id, buyerCompanyId, input.expected_version]; const sets: string[] = [];
  for (const field of allowed) if (field in input) { values.push(input[field]); sets.push(`${field}=$${values.length}`); }
  if (!sets.length) throw new HttpError(400, "INTERCOMPANY_CATALOGUE_EMPTY_PATCH", "Aucune modification catalogue n'a été fournie.");
  values.push(actorUserId); sets.push(`updated_by=$${values.length}`, "version=version+1", "updated_at=now()");
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE public.intercompany_commercial_catalogue c SET ${sets.join(",")}
      FROM public.intercompany_supplier_relations r WHERE c.id=$1::uuid AND r.id=c.relation_id AND r.buyer_company_id=$2::uuid AND c.version=$3
      RETURNING ${COLUMNS}`, values);
  if (!result.rows[0]) throw new HttpError(409, "INTERCOMPANY_CATALOGUE_VERSION_CONFLICT", "Le catalogue a été modifié ou n'est plus disponible.");
  return item(result.rows[0]);
}

/** Creates the buyer-local supplier PO from explicit catalogue mappings only. */
export async function repoCreateDropshipPurchaseOrderTx(tx: PoolClient, params: { buyerCompanyId: string; buyerSalesOrderId: number; mappingIds: string[]; audit: PurchaseAuditContext }): Promise<{ id: string; code: string }> {
  const lines = await tx.query<{ id: string; article_id: string; quantite: number; designation: string; unite: string; mapping_id: string; relation_id: string; supplier_id: string; catalogue_id: string; purchase_unit_price: number; purchase_vat_rate: number; currency: string; version: number; supplier_reference: string | null }>(
    `SELECT line.id::text,line.article_id::text,line.quantite::float8,line.designation,line.unite,$2::uuid[] [array_position($2::uuid[],m.id)]::text AS mapping_id,
            m.relation_id::text,r.local_supplier_id::text AS supplier_id,m.supplier_catalogue_id::text AS catalogue_id,m.purchase_unit_price::float8,m.purchase_vat_rate::float8,m.currency,m.version,m.supplier_reference
       FROM public.commande_ligne line JOIN public.intercompany_commercial_catalogue m ON m.id=ANY($2::uuid[]) JOIN public.intercompany_supplier_relations r ON r.id=m.relation_id
      WHERE line.commande_id=$1::bigint AND line.article_id=m.local_article_id AND r.buyer_company_id=$3::uuid AND r.status='ACTIVE' AND m.active
      ORDER BY line.id`, [params.buyerSalesOrderId, params.mappingIds, params.buyerCompanyId]);
  if (lines.rows.length !== params.mappingIds.length || new Set(lines.rows.map(line => line.relation_id)).size !== 1) throw new HttpError(409, "INTERCOMPANY_DROPSHIP_MAPPING_INVALID", "Les lignes commande ne correspondent pas à une relation catalogue active unique.");
  const first = lines.rows[0];
  const po = await repoCreateCommandeFournisseur({ idempotency_key: `intercompany:${params.buyerSalesOrderId}:purchase`, origine: "AUTRE", fournisseur_id: first.supplier_id, devise: first.currency, adresse_livraison_texte: "Livraison directe client", lignes: lines.rows.map(line => ({ type: "ARTICLE", article_id: line.article_id, catalogue_id: line.catalogue_id, apply_catalogue_pricing: false, reference_fournisseur: line.supplier_reference, designation: line.designation, unite: line.unite, quantite: line.quantite, prix_unitaire_ht: line.purchase_unit_price, tva_pct: line.purchase_vat_rate, remise_pct: 0, frais_ht: 0, commande_client_id: params.buyerSalesOrderId, exigences_qualite: [], documents_attendus: [], besoins: [] })) }, params.audit, tx);
  await tx.query(`INSERT INTO public.intercompany_purchase_order_links(buyer_sales_order_id,buyer_purchase_order_id,relation_id,created_by) VALUES($1,$2::uuid,$3::uuid,$4)`, [params.buyerSalesOrderId, po.id, first.relation_id, params.audit.user_id]);
  const poLines = await tx.query<{ id: string }>(`SELECT id::text FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid ORDER BY position`, [po.id]);
  if (poLines.rows.length !== lines.rows.length) throw new Error("INTERCOMPANY_PURCHASE_LINE_CREATION_INCOMPLETE");
  for (const [index, line] of lines.rows.entries()) await tx.query(`INSERT INTO public.intercompany_purchase_order_line_links(buyer_sales_order_line_id,buyer_purchase_order_line_id,catalogue_mapping_id,mapping_version) VALUES($1::bigint,$2::uuid,$3::uuid,$4)`, [line.id, poLines.rows[index].id, line.mapping_id, line.version]);
  return po;
}
