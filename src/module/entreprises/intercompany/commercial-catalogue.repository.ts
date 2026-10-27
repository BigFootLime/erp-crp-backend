import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../../../utils/httpError";
import { repoCreateArticleTx, type AuditContext as ArticleAuditContext } from "../../stock/repository/stock.repository";
import { repoCreateFournisseurCatalogueItem } from "../../fournisseurs/repository/fournisseurs.repository";
import { createCatalogueSchema } from "../../fournisseurs/validators/fournisseurs.validators";
import { repoCreateCommandeFournisseur, type AuditContext as PurchaseAuditContext } from "../../commande-fournisseur/repository/commande-fournisseur.repository";
import { enqueueIntercompanyMessageTx } from "./intercompany-outbox.repository";
import { purchaseSubmittedPayloadSchema } from "./intercompany-purchase.contract";
import type { CommercialCatalogueCreate, CommercialCatalogueItem, CommercialCataloguePatch, SupplierCommercialOffer, SupplierCommercialOfferPatch } from "./commercial-catalogue";

type Tx = Pick<PoolClient, "query">;

const COLUMNS = `c.id::text,c.relation_id::text,c.local_article_id::text,c.supplier_catalogue_id::text,c.supplier_catalogue_mapping_id::text,c.supplier_article_id::text,
 c.supplier_piece_technique_id::text,c.supplier_piece_technique_version_id::text,c.supplier_reference,c.designation,c.unit,c.supplier_mapping_version,
 c.buyer_sale_unit_price::float8,c.buyer_sale_vat_rate::float8,c.purchase_unit_price::float8,c.supplier_sale_unit_price::float8,c.purchase_vat_rate::float8,c.currency,c.version,c.active,c.variant_code,c.options_snapshot`;

function item(row: Record<string, unknown>): CommercialCatalogueItem {
  return {
    id: String(row.id), relation_id: String(row.relation_id), local_article_id: String(row.local_article_id), supplier_catalogue_id: String(row.supplier_catalogue_id), supplier_catalogue_mapping_id: String(row.supplier_catalogue_mapping_id),
    supplier_article_id: String(row.supplier_article_id), supplier_piece_technique_id: row.supplier_piece_technique_id == null ? null : String(row.supplier_piece_technique_id),
    supplier_piece_technique_version_id: row.supplier_piece_technique_version_id == null ? null : String(row.supplier_piece_technique_version_id),
    supplier_reference: row.supplier_reference == null ? null : String(row.supplier_reference), designation: String(row.designation), unit: String(row.unit), supplier_mapping_version: Number(row.supplier_mapping_version),
    buyer_sale_unit_price: Number(row.buyer_sale_unit_price), buyer_sale_vat_rate: Number(row.buyer_sale_vat_rate),
    purchase_unit_price: Number(row.purchase_unit_price), purchase_vat_rate: Number(row.purchase_vat_rate), currency: String(row.currency), version: Number(row.version), active: Boolean(row.active),
    supplier_sale_unit_price: row.supplier_sale_unit_price == null ? null : Number(row.supplier_sale_unit_price), variant_code: String(row.variant_code ?? ""), options_snapshot: (row.options_snapshot as Record<string, unknown> | null) ?? {},
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
     WHERE r.buyer_company_id=$1::uuid AND r.local_role='BUYER' AND c.local_role='BUYER' ORDER BY c.designation,c.id`, [buyerCompanyId]);
  return result.rows.map(item);
}

export async function repoCreateCommercialCatalogueTx(tx: PoolClient, buyerCompanyId: string, input: CommercialCatalogueCreate, audit: ArticleAuditContext): Promise<CommercialCatalogueItem> {
  const published = (await tx.query<Record<string, unknown>>(
    `SELECT p.supplier_catalogue_mapping_id::text,p.relation_id::text,p.supplier_article_id::text,
            p.supplier_piece_technique_id::text,p.supplier_piece_technique_version_id::text,p.supplier_reference,
            p.designation,p.unit,p.variant_code,p.options_snapshot,p.supplier_sale_unit_price::float8,
            p.purchase_vat_rate::float8,p.currency,p.supplier_mapping_version,r.local_supplier_id::text
       FROM public.intercompany_supplier_catalogue_projections p
       JOIN public.intercompany_supplier_relations r ON r.id=p.relation_id
      WHERE p.supplier_catalogue_mapping_id=$1::uuid AND p.relation_id=$2::uuid
        AND r.buyer_company_id=$3::uuid AND r.local_role='BUYER' AND r.status='ACTIVE' AND p.active
      FOR SHARE OF p,r`, [input.supplier_catalogue_mapping_id, input.relation_id, buyerCompanyId]
  )).rows[0];
  if (!published) throw new HttpError(409, "INTERCOMPANY_PUBLISHED_OFFER_NOT_AVAILABLE", "L’offre fournisseur publiée est absente, inactive ou hors périmètre.");
  const same = (left: unknown, right: unknown) => isDeepStrictEqual(left ?? null, right ?? null);
  if (input.supplier_mapping_version !== Number(published.supplier_mapping_version)
    || input.supplier_article_id !== String(published.supplier_article_id)
    || !same(input.supplier_piece_technique_id, published.supplier_piece_technique_id)
    || !same(input.supplier_piece_technique_version_id, published.supplier_piece_technique_version_id)
    || !same(input.supplier_reference, published.supplier_reference)
    || input.designation !== String(published.designation)
    || input.unit !== String(published.unit)
    || input.variant_code !== String(published.variant_code)
    || !same(input.options_snapshot, published.options_snapshot)
    || input.purchase_unit_price !== Number(published.supplier_sale_unit_price)
    || input.purchase_vat_rate !== Number(published.purchase_vat_rate)
    || input.currency !== String(published.currency)) {
    throw new HttpError(409, "INTERCOMPANY_PUBLISHED_OFFER_CHANGED", "L’offre publiée a changé ; actualisez la sélection avant de créer la liaison.");
  }
  const localArticleId = input.local_article_id ?? (await repoCreateArticleTx(tx, {
    designation: input.local_article!.designation, article_type: "PURCHASED", article_category: "achat", family_code: input.local_article!.family_code,
    stock_managed: false, lot_tracking: false, is_sold: true, status: "VALIDE", unite: input.local_article!.unit, is_active: true,
  }, audit)).id;
  const catalogueId = input.supplier_catalogue_id ?? (await repoCreateFournisseurCatalogueItem(
    String(published.local_supplier_id),
    createCatalogueSchema.parse({ body: {
      type: "AUTRE", article_id: localArticleId, designation: String(published.designation),
      reference_fournisseur: published.supplier_reference == null ? null : String(published.supplier_reference),
      unite: String(published.unit), prix_unitaire: Number(published.supplier_sale_unit_price), devise: String(published.currency),
      actif: true,
    } }).body,
    audit,
    tx,
  ))?.id;
  if (!catalogueId) throw new HttpError(404, "INTERCOMPANY_LOCAL_SUPPLIER_NOT_FOUND", "Le fournisseur local de la relation n’est plus disponible.");
  await assertRelationAndCatalogue(tx, input.relation_id, catalogueId, buyerCompanyId);
  const linked = await tx.query<{ article_id: string | null }>(`SELECT article_id::text FROM public.fournisseur_catalogue WHERE id=$1::uuid FOR UPDATE`, [catalogueId]);
  if (!linked.rows[0] || (linked.rows[0].article_id && linked.rows[0].article_id !== localArticleId))
    throw new HttpError(409, "INTERCOMPANY_CATALOGUE_ARTICLE_CONFLICT", "La référence fournisseur est déjà liée à un autre article local.");
  await tx.query(`UPDATE public.fournisseur_catalogue SET article_id=$2::uuid,updated_by=$3 WHERE id=$1::uuid`, [catalogueId, localArticleId, audit.user_id]);
  const result = await tx.query<Record<string, unknown>>(
    `INSERT INTO public.intercompany_commercial_catalogue(relation_id,local_role,local_article_id,supplier_catalogue_id,supplier_catalogue_mapping_id,supplier_mapping_version,supplier_article_id,supplier_piece_technique_id,supplier_piece_technique_version_id,supplier_reference,designation,unit,variant_code,options_snapshot,buyer_sale_unit_price,buyer_sale_vat_rate,purchase_unit_price,purchase_vat_rate,currency,created_by,updated_by)
     VALUES($1::uuid,'BUYER',$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$20,$20) RETURNING id::text,relation_id::text,local_article_id::text,supplier_catalogue_id::text,supplier_catalogue_mapping_id::text,supplier_article_id::text,supplier_piece_technique_id::text,supplier_piece_technique_version_id::text,supplier_reference,designation,unit,supplier_mapping_version,buyer_sale_unit_price::float8,buyer_sale_vat_rate::float8,purchase_unit_price::float8,supplier_sale_unit_price::float8,purchase_vat_rate::float8,currency,version,active,variant_code,options_snapshot`,
    [input.relation_id, localArticleId, catalogueId, published.supplier_catalogue_mapping_id, published.supplier_mapping_version, published.supplier_article_id, published.supplier_piece_technique_id, published.supplier_piece_technique_version_id, published.supplier_reference, published.designation, published.unit, published.variant_code, JSON.stringify(published.options_snapshot), input.buyer_sale_unit_price, input.buyer_sale_vat_rate, published.supplier_sale_unit_price, published.purchase_vat_rate, published.currency, audit.user_id]);
  return item(result.rows[0]);
}

/** Safe selector for commercial order forms. IDs are returned only as choices scoped to the runtime buyer. */
export async function repoCommercialCatalogueOptionsTx(tx: Tx, buyerCompanyId: string) {
  const rows = await repoListCommercialCatalogueTx(tx, buyerCompanyId);
  const offers=await tx.query<Record<string,unknown>>(`SELECT p.supplier_catalogue_mapping_id::text,p.relation_id::text,p.supplier_article_id::text,p.supplier_piece_technique_id::text,p.supplier_piece_technique_version_id::text,p.supplier_reference,p.designation,p.unit,p.variant_code,p.options_snapshot,p.supplier_sale_unit_price::float8,p.purchase_vat_rate::float8,p.currency,p.supplier_mapping_version,p.active FROM public.intercompany_supplier_catalogue_projections p JOIN public.intercompany_supplier_relations r ON r.id=p.relation_id WHERE r.buyer_company_id=$1::uuid AND r.local_role='BUYER' AND p.active ORDER BY p.designation`,[buyerCompanyId]);
  const publishedOffers = offers.rows.map(row=>({relation_id:String(row.relation_id),supplier_catalogue_mapping_id:String(row.supplier_catalogue_mapping_id),supplier_article_id:String(row.supplier_article_id),supplier_piece_technique_id:row.supplier_piece_technique_id==null?null:String(row.supplier_piece_technique_id),supplier_piece_technique_version_id:row.supplier_piece_technique_version_id==null?null:String(row.supplier_piece_technique_version_id),supplier_reference:row.supplier_reference??null,designation:String(row.designation),unit:String(row.unit),variant_code:String(row.variant_code),options_snapshot:row.options_snapshot??{},supplier_sale_unit_price:Number(row.supplier_sale_unit_price),purchase_vat_rate:Number(row.purchase_vat_rate),currency:String(row.currency),supplier_mapping_version:Number(row.supplier_mapping_version)}));
  return { items: publishedOffers, offers: publishedOffers, mappings: rows.filter(row => row.active).map(row => ({
    catalogue_mapping_id: row.id,
    relation_id: row.relation_id,
    supplier_catalogue_id: row.supplier_catalogue_id,
    supplier_catalogue_mapping_id: row.supplier_catalogue_mapping_id,
    supplier_article_id: row.supplier_article_id,
    supplier_reference: row.supplier_reference,
    designation: row.designation,
    unit: row.unit,
    variant_code: row.variant_code ?? "",
    options_snapshot: row.options_snapshot ?? {},
    sale_unit_price: row.buyer_sale_unit_price,
    sale_vat_rate: row.buyer_sale_vat_rate,
    currency: row.currency,
    mapping_version: row.version,
    supplier_mapping_version: row.supplier_mapping_version,
  }))};
}

/** Publishes only supplier-side offer data; buyer retail pricing is never selected. */
export async function repoPublishSupplierCatalogueTx(tx: Tx, supplierCompanyId: string, id: string) {
  const found=await tx.query<Record<string,unknown>>(`SELECT c.id::text,c.relation_id::text,c.supplier_article_id::text,c.supplier_piece_technique_id::text,c.supplier_piece_technique_version_id::text,c.supplier_reference,c.designation,c.unit,c.variant_code,c.options_snapshot,c.supplier_sale_unit_price::float8,c.purchase_vat_rate::float8,c.currency,c.version,c.active,r.buyer_company_id::text
    FROM public.intercompany_commercial_catalogue c JOIN public.intercompany_supplier_relations r ON r.id=c.relation_id
    WHERE c.id=$1::uuid AND r.supplier_company_id=$2::uuid AND r.local_role='SUPPLIER' AND c.local_role='SUPPLIER' AND r.status='ACTIVE' FOR SHARE OF c,r`,[id,supplierCompanyId]);
  const row=found.rows[0]; if(!row)throw new HttpError(404,"INTERCOMPANY_SUPPLIER_OFFER_NOT_FOUND","L'offre fournisseur n'est pas disponible.");
  const payload={schema_version:1,relation_id:String(row.relation_id),supplier_catalogue_mapping_id:String(row.id),supplier_article_id:String(row.supplier_article_id),supplier_piece_technique_id:row.supplier_piece_technique_id==null?null:String(row.supplier_piece_technique_id),supplier_piece_technique_version_id:row.supplier_piece_technique_version_id==null?null:String(row.supplier_piece_technique_version_id),supplier_reference:row.supplier_reference==null?null:String(row.supplier_reference),designation:String(row.designation),unit:String(row.unit),variant_code:String(row.variant_code||"standard"),options_snapshot:(row.options_snapshot as Record<string,string|number|boolean|null>)??{},supplier_sale_unit_price:Number(row.supplier_sale_unit_price),purchase_vat_rate:Number(row.purchase_vat_rate),currency:String(row.currency),supplier_mapping_version:Number(row.version),active:Boolean(row.active)};
  const { purchaseSubmittedPayloadSchema }=await import("./intercompany-purchase.contract"); // retained runtime dependency boundary
  void purchaseSubmittedPayloadSchema;
  const snapshot={supplier_article_id:payload.supplier_article_id,supplier_piece_technique_id:payload.supplier_piece_technique_id,supplier_piece_technique_version_id:payload.supplier_piece_technique_version_id,supplier_reference:payload.supplier_reference,designation:payload.designation,unit:payload.unit,variant_code:payload.variant_code,options_snapshot:payload.options_snapshot,supplier_sale_unit_price:payload.supplier_sale_unit_price,purchase_vat_rate:payload.purchase_vat_rate,currency:payload.currency};
  const hash=createHash("sha256").update(JSON.stringify(snapshot),"utf8").digest("hex");
  await tx.query(`INSERT INTO public.intercompany_supplier_offer_revisions(relation_id,supplier_catalogue_mapping_id,version,snapshot,snapshot_sha256) VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5) ON CONFLICT(relation_id,supplier_catalogue_mapping_id,version) DO NOTHING`,[payload.relation_id,payload.supplier_catalogue_mapping_id,payload.supplier_mapping_version,JSON.stringify(snapshot),hash]);
  await enqueueIntercompanyMessageTx(tx,{destination_company_id:String(row.buyer_company_id),kind:"CATALOGUE_PUBLISHED",aggregate_id:payload.supplier_catalogue_mapping_id,revision:payload.supplier_mapping_version,payload});
  return payload;
}
export async function repoCreateSupplierOfferTx(tx:Tx,supplierCompanyId:string,input:SupplierCommercialOffer,actor:number){
  const article=(await tx.query<{piece_technique_id:string|null}>(`SELECT piece_technique_id::text FROM public.articles WHERE id=$1::uuid FOR SHARE`,[input.local_article_id])).rows[0];
  if(!article) throw new HttpError(404,"INTERCOMPANY_SUPPLIER_ARTICLE_NOT_FOUND","L’article fournisseur est introuvable.");
  if(input.supplier_piece_technique_id && input.supplier_piece_technique_id!==article.piece_technique_id) throw new HttpError(409,"INTERCOMPANY_SUPPLIER_TECHNICAL_BINDING_INVALID","La pièce technique ne correspond pas à l’article fournisseur.");
  const technicalId=article.piece_technique_id;
  const currentVersion=technicalId?(await tx.query<{id:string}>(`SELECT id::text FROM public.piece_technique_versions WHERE piece_technique_id=$1::uuid AND is_current=true ORDER BY version_interne DESC NULLS LAST LIMIT 1 FOR SHARE`,[technicalId])).rows[0]?.id??null:null;
  if(input.supplier_piece_technique_version_id && input.supplier_piece_technique_version_id!==currentVersion) throw new HttpError(409,"INTERCOMPANY_SUPPLIER_TECHNICAL_VERSION_INVALID","La version technique publiée n’est plus la version courante de l’article.");
  const q=await tx.query<Record<string,unknown>>(`INSERT INTO public.intercompany_commercial_catalogue(relation_id,local_role,local_article_id,supplier_catalogue_mapping_id,supplier_mapping_version,supplier_article_id,supplier_piece_technique_id,supplier_piece_technique_version_id,supplier_reference,designation,unit,variant_code,options_snapshot,supplier_sale_unit_price,purchase_vat_rate,currency,created_by,updated_by) SELECT $1::uuid,'SUPPLIER',$2::uuid,gen_random_uuid(),1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13 FROM public.intercompany_supplier_relations r WHERE r.id=$1::uuid AND r.local_role='SUPPLIER' AND r.supplier_company_id=$14::uuid AND r.status='ACTIVE' RETURNING id::text,relation_id::text,supplier_catalogue_mapping_id::text,supplier_article_id::text,supplier_piece_technique_id::text,supplier_piece_technique_version_id::text,designation,unit,variant_code,options_snapshot,supplier_sale_unit_price::float8,purchase_vat_rate::float8,currency,version,active`,[input.relation_id,input.local_article_id,technicalId,currentVersion,input.supplier_reference??null,input.designation,input.unit,input.variant_code,JSON.stringify(input.options_snapshot),input.supplier_sale_unit_price,input.purchase_vat_rate,input.currency,actor,supplierCompanyId]);if(!q.rows[0])throw new HttpError(403,"INTERCOMPANY_SUPPLIER_RELATION_DENIED","Relation vendeur active requise.");return q.rows[0]}
export async function repoListSupplierOffersTx(tx:Tx,companyId:string){return (await tx.query(`SELECT c.id::text,c.relation_id::text,c.supplier_catalogue_mapping_id::text,c.supplier_article_id::text,c.supplier_piece_technique_id::text,c.supplier_piece_technique_version_id::text,c.supplier_reference,c.designation,c.unit,c.variant_code,c.options_snapshot,c.supplier_sale_unit_price::float8,c.purchase_vat_rate::float8,c.currency,c.version,c.active FROM public.intercompany_commercial_catalogue c JOIN public.intercompany_supplier_relations r ON r.id=c.relation_id WHERE c.local_role='SUPPLIER' AND r.local_role='SUPPLIER' AND r.supplier_company_id=$1::uuid ORDER BY c.designation`,[companyId])).rows}
export async function repoPatchSupplierOfferTx(tx:Tx,companyId:string,id:string,input:SupplierCommercialOfferPatch,actor:number){const allowed=["supplier_reference","designation","unit","variant_code","options_snapshot","supplier_sale_unit_price","purchase_vat_rate","currency","active"] as const;const vals:unknown[]=[id,companyId,input.expected_version];const sets:string[]=[];for(const k of allowed)if(k in input){vals.push(input[k]);sets.push(`${k}=$${vals.length}${k==='options_snapshot'?'::jsonb':''}`)}if(!sets.length)throw new HttpError(400,"INTERCOMPANY_SUPPLIER_OFFER_EMPTY_PATCH","Aucune modification.");vals.push(actor);sets.push(`updated_by=$${vals.length}`,"version=version+1","updated_at=now()");const q=await tx.query(`UPDATE public.intercompany_commercial_catalogue c SET ${sets.join(',')} FROM public.intercompany_supplier_relations r WHERE c.id=$1::uuid AND c.relation_id=r.id AND c.local_role='SUPPLIER' AND r.local_role='SUPPLIER' AND r.supplier_company_id=$2::uuid AND c.version=$3 RETURNING c.id::text,c.version,c.active`,vals);if(!q.rows[0])throw new HttpError(409,"INTERCOMPANY_SUPPLIER_OFFER_CONFLICT","Offre hors périmètre ou modifiée.");return q.rows[0]}

export async function repoPatchCommercialCatalogueTx(tx: Tx, buyerCompanyId: string, id: string, input: CommercialCataloguePatch, actorUserId: number): Promise<CommercialCatalogueItem> {
  const allowed = ["supplier_article_id","supplier_piece_technique_id","supplier_piece_technique_version_id","supplier_reference","designation","unit","buyer_sale_unit_price","buyer_sale_vat_rate","purchase_unit_price","purchase_vat_rate","currency","active"] as const;
  const values: unknown[] = [id, buyerCompanyId, input.expected_version]; const sets: string[] = [];
  for (const field of allowed) if (field in input) { values.push(input[field]); sets.push(`${field}=$${values.length}`); }
  if (!sets.length) throw new HttpError(400, "INTERCOMPANY_CATALOGUE_EMPTY_PATCH", "Aucune modification catalogue n'a été fournie.");
  values.push(actorUserId); sets.push(`updated_by=$${values.length}`, "version=version+1", "updated_at=now()");
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE public.intercompany_commercial_catalogue c SET ${sets.join(",")}
      FROM public.intercompany_supplier_relations r WHERE c.id=$1::uuid AND r.id=c.relation_id AND r.buyer_company_id=$2::uuid AND r.local_role='BUYER' AND c.local_role='BUYER' AND c.version=$3
      RETURNING ${COLUMNS}`, values);
  if (!result.rows[0]) throw new HttpError(409, "INTERCOMPANY_CATALOGUE_VERSION_CONFLICT", "Le catalogue a été modifié ou n'est plus disponible.");
  return item(result.rows[0]);
}

/** Creates the buyer-local supplier PO from explicit catalogue mappings only. */
export async function repoCreateDropshipPurchaseOrderTx(tx: PoolClient, params: { buyerCompanyId: string; buyerSalesOrderId: number; mappingIds: string[]; audit: PurchaseAuditContext }): Promise<{ id: string; code: string }> {
  const lines = await tx.query<{ id: string; article_id: string; quantite: number; designation: string; unite: string; mapping_id: string; relation_id: string; supplier_id: string; catalogue_id: string; purchase_unit_price: number; purchase_vat_rate: number; currency: string; version: number; supplier_mapping_version: number; supplier_catalogue_mapping_id: string; supplier_article_id: string; supplier_piece_technique_id: string | null; supplier_piece_technique_version_id: string | null; supplier_reference: string | null; variant_code: string; options_snapshot: Record<string, string | number | boolean | null> }>(
    `SELECT line.id::text,line.article_id::text,line.quantite::float8,line.designation,line.unite,m.id::text AS mapping_id,
            m.relation_id::text,r.local_supplier_id::text AS supplier_id,m.supplier_catalogue_id::text AS catalogue_id,m.purchase_unit_price::float8,m.purchase_vat_rate::float8,m.currency,m.version,m.supplier_mapping_version,m.supplier_catalogue_mapping_id::text,m.supplier_article_id::text,m.supplier_piece_technique_id::text,m.supplier_piece_technique_version_id::text,m.supplier_reference,m.variant_code,m.options_snapshot
       FROM public.commande_ligne line JOIN public.intercompany_commercial_catalogue m ON m.id=ANY($2::uuid[]) JOIN public.intercompany_supplier_relations r ON r.id=m.relation_id
      WHERE line.commande_id=$1::bigint AND line.article_id=m.local_article_id AND r.buyer_company_id=$3::uuid AND r.local_role='BUYER' AND m.local_role='BUYER' AND r.status='ACTIVE' AND m.active
      ORDER BY line.id`, [params.buyerSalesOrderId, params.mappingIds, params.buyerCompanyId]);
  if (lines.rows.length !== params.mappingIds.length || new Set(lines.rows.map(line => line.relation_id)).size !== 1) throw new HttpError(409, "INTERCOMPANY_DROPSHIP_MAPPING_INVALID", "Les lignes commande ne correspondent pas à une relation catalogue active unique.");
  const first = lines.rows[0];
  const po = await repoCreateCommandeFournisseur({ idempotency_key: `intercompany:${params.buyerSalesOrderId}:purchase`, origine: "AUTRE", fournisseur_id: first.supplier_id, devise: first.currency, adresse_livraison_texte: "Livraison directe client", frais_port_ht: 0, tva_frais_pct: 20, lignes: lines.rows.map(line => ({ type: "ARTICLE", article_id: line.article_id, catalogue_id: line.catalogue_id, apply_catalogue_pricing: false, reference_fournisseur: line.supplier_reference, designation: line.designation, unite: line.unite, quantite: line.quantite, prix_unitaire_ht: line.purchase_unit_price, tva_pct: line.purchase_vat_rate, remise_pct: 0, frais_ht: 0, commande_client_id: params.buyerSalesOrderId, exigences_qualite: [], documents_attendus: [], besoins: [] })) }, params.audit, tx);
  await tx.query(`INSERT INTO public.intercompany_purchase_order_links(buyer_sales_order_id,buyer_purchase_order_id,relation_id,created_by) VALUES($1,$2::uuid,$3::uuid,$4)`, [params.buyerSalesOrderId, po.id, first.relation_id, params.audit.user_id]);
  const poLines = await tx.query<{ id: string }>(`SELECT id::text FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid ORDER BY position`, [po.id]);
  if (poLines.rows.length !== lines.rows.length) throw new Error("INTERCOMPANY_PURCHASE_LINE_CREATION_INCOMPLETE");
  for (const [index, line] of lines.rows.entries()) await tx.query(`INSERT INTO public.intercompany_purchase_order_line_links(buyer_sales_order_line_id,buyer_purchase_order_line_id,catalogue_mapping_id,mapping_version) VALUES($1::bigint,$2::uuid,$3::uuid,$4)`, [line.id, poLines.rows[index].id, line.mapping_id, line.version]);
  const snapshot = await tx.query<{ delivery: unknown; legal_name: string | null; street: string | null; house_number: string | null; postal_code: string | null; city: string | null; country: string | null; registration_number: string | null; vat_number: string | null; destination_company_id: string }>(
    `SELECT command.intercompany_delivery_address AS delivery,
            biller.biller_name AS legal_name,biller.street,biller.house_number,biller.postal_code,biller.city,biller.country,
            COALESCE(mentions.siret,mentions.siren) AS registration_number,mentions.vat_number,
            relation.supplier_company_id::text AS destination_company_id
       FROM public.commande_client command
       JOIN public.intercompany_supplier_relations relation ON relation.id=$2::uuid
       JOIN public.erp_settings setting ON setting.key='company.primary_biller_id'
       JOIN public.factureur biller ON biller.biller_id::text=setting.value_text
       LEFT JOIN LATERAL(SELECT * FROM public.finance_legal_mentions legal WHERE legal.biller_id=biller.biller_id AND legal.effective_to IS NULL ORDER BY legal.version DESC LIMIT 1) mentions ON true
      WHERE command.id=$1::bigint FOR SHARE OF command,relation,biller`, [params.buyerSalesOrderId, first.relation_id]);
  const header = snapshot.rows[0];
  if (!header || !header.legal_name || !header.street || !header.postal_code || !header.city || !header.country || !header.delivery)
    throw new HttpError(409, "INTERCOMPANY_SNAPSHOT_REQUIRED", "La destination persistée et l'identité légale active sont requises avant l'envoi interentreprises.");
  const delivery = header.delivery as Record<string, unknown>;
  const recipient = typeof delivery.recipient_name === "string" ? delivery.recipient_name : typeof delivery.name === "string" ? delivery.name : null;
  const addressLine1 = typeof delivery.address_line_1 === "string" ? delivery.address_line_1.trim() : null;
  const postalCode = typeof delivery.postal_code === "string" ? delivery.postal_code.trim() : null;
  const city = typeof delivery.city === "string" ? delivery.city.trim() : null;
  if (!recipient || !addressLine1 || !postalCode || !city) {
    throw new HttpError(409, "INTERCOMPANY_DELIVERY_ADDRESS_STRUCTURED_REQUIRED", "La destination fournisseur doit contenir rue, code postal et ville structurés.");
  }
  const addressLines = Array.isArray(delivery.address_lines)
    ? delivery.address_lines.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [delivery.house_number, delivery.street, delivery.address_complement, delivery.postal_code, delivery.city].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const payload = purchaseSubmittedPayloadSchema.parse({
    schema_version: 1, relation_id: first.relation_id, buyer_sales_order_id: String(params.buyerSalesOrderId), buyer_purchase_order_id: po.id,
    buyer_legal_snapshot: { legal_name: header.legal_name, registration_number: header.registration_number ?? undefined, vat_number: header.vat_number ?? undefined, address_lines: [`${header.house_number ?? ""} ${header.street}`.trim(), `${header.postal_code} ${header.city}`], issued_at: new Date().toISOString() },
    final_delivery_address_snapshot: { recipient_name: recipient, address_lines: addressLines, address_line_1: addressLine1, address_line_2: typeof delivery.address_line_2 === "string" ? delivery.address_line_2.trim() : undefined, postal_code: postalCode, city, country_code: typeof delivery.country_code === "string" ? delivery.country_code.toUpperCase() : undefined, contact_name: typeof delivery.contact_name === "string" ? delivery.contact_name : undefined, contact_phone: typeof delivery.contact_phone === "string" ? delivery.contact_phone : undefined },
    lines: lines.rows.map((line, index) => ({ buyer_sales_order_line_id: line.id, buyer_purchase_order_line_id: poLines.rows[index].id, catalogue_mapping_id: line.mapping_id, supplier_catalogue_mapping_id: line.supplier_catalogue_mapping_id, mapping_version: line.version, supplier_mapping_version: line.supplier_mapping_version, supplier_article_id: line.supplier_article_id, supplier_piece_technique_id: line.supplier_piece_technique_id, supplier_piece_technique_version_id: line.supplier_piece_technique_version_id, supplier_reference: line.supplier_reference, variant_code: line.variant_code || "standard", options_snapshot: line.options_snapshot ?? {}, quantity: line.quantite, unit: line.unite, purchase_unit_price: line.purchase_unit_price, purchase_vat_rate: line.purchase_vat_rate, currency: line.currency })),
  });
  await enqueueIntercompanyMessageTx(tx, { destination_company_id: header.destination_company_id, kind: "PURCHASE_SUBMITTED", aggregate_id: po.id, revision: 1, payload });
  // The durable outbox row is the actual transmission intent.  Keep the native
  // PO lifecycle truthful without fabricating a supplier email/document.
  await tx.query(`UPDATE public.commande_fournisseur SET statut='ENVOYEE',date_envoi=now(),sent_by=$2,updated_by=$2 WHERE id=$1::uuid AND statut='BROUILLON'`, [po.id, params.audit.user_id]);
  await tx.query(`INSERT INTO public.commande_fournisseur_transition(commande_id,from_statut,to_statut,motif,acteur_id) VALUES($1::uuid,'BROUILLON','A_VALIDER','Soumission interentreprises automatique',$2),($1::uuid,'A_VALIDER','APPROUVEE','Approbation du flux interentreprises',$2),($1::uuid,'APPROUVEE','ENVOYEE','Message PURCHASE_SUBMITTED inscrit dans l''outbox',$2)`, [po.id, params.audit.user_id]);
  return po;
}
