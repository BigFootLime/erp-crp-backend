import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoCreateArticleTx, type AuditContext as ArticleAuditContext } from "../../stock/repository/stock.repository";
import { repoCreateCommandeFournisseur, type AuditContext as PurchaseAuditContext } from "../../commande-fournisseur/repository/commande-fournisseur.repository";
import { enqueueIntercompanyMessageTx } from "./intercompany-outbox.repository";
import { purchaseSubmittedPayloadSchema } from "./intercompany-purchase.contract";
import type { CommercialCatalogueCreate, CommercialCatalogueItem, CommercialCataloguePatch } from "./commercial-catalogue";

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
    `INSERT INTO public.intercompany_commercial_catalogue(relation_id,local_role,local_article_id,supplier_catalogue_id,supplier_catalogue_mapping_id,supplier_mapping_version,supplier_article_id,supplier_piece_technique_id,supplier_piece_technique_version_id,supplier_reference,designation,unit,buyer_sale_unit_price,buyer_sale_vat_rate,purchase_unit_price,purchase_vat_rate,currency,created_by,updated_by)
     VALUES($1::uuid,'BUYER',$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$17) RETURNING id::text,relation_id::text,local_article_id::text,supplier_catalogue_id::text,supplier_catalogue_mapping_id::text,supplier_article_id::text,supplier_piece_technique_id::text,supplier_piece_technique_version_id::text,supplier_reference,designation,unit,supplier_mapping_version,buyer_sale_unit_price::float8,buyer_sale_vat_rate::float8,purchase_unit_price::float8,supplier_sale_unit_price::float8,purchase_vat_rate::float8,currency,version,active,variant_code,options_snapshot`,
    [input.relation_id, localArticleId, input.supplier_catalogue_id, input.supplier_catalogue_mapping_id, input.supplier_mapping_version, input.supplier_article_id, input.supplier_piece_technique_id ?? null, input.supplier_piece_technique_version_id ?? null, input.supplier_reference ?? null, input.designation, input.unit, input.buyer_sale_unit_price, input.buyer_sale_vat_rate, input.purchase_unit_price, input.purchase_vat_rate, input.currency, audit.user_id]);
  return item(result.rows[0]);
}

/** Safe selector for commercial order forms. IDs are returned only as choices scoped to the runtime buyer. */
export async function repoCommercialCatalogueOptionsTx(tx: Tx, buyerCompanyId: string) {
  const rows = await repoListCommercialCatalogueTx(tx, buyerCompanyId);
  const offers=await tx.query<Record<string,unknown>>(`SELECT p.supplier_catalogue_mapping_id::text,p.relation_id::text,p.supplier_article_id::text,p.supplier_piece_technique_id::text,p.supplier_piece_technique_version_id::text,p.supplier_reference,p.designation,p.unit,p.variant_code,p.options_snapshot,p.supplier_sale_unit_price::float8,p.purchase_vat_rate::float8,p.currency,p.supplier_mapping_version,p.active FROM public.intercompany_supplier_catalogue_projections p JOIN public.intercompany_supplier_relations r ON r.id=p.relation_id WHERE r.buyer_company_id=$1::uuid AND r.local_role='BUYER' AND p.active ORDER BY p.designation`,[buyerCompanyId]);
  return { offers: offers.rows.map(row=>({relation_id:String(row.relation_id),supplier_catalogue_mapping_id:String(row.supplier_catalogue_mapping_id),supplier_article_id:String(row.supplier_article_id),supplier_piece_technique_id:row.supplier_piece_technique_id==null?null:String(row.supplier_piece_technique_id),supplier_piece_technique_version_id:row.supplier_piece_technique_version_id==null?null:String(row.supplier_piece_technique_version_id),supplier_reference:row.supplier_reference??null,designation:String(row.designation),unit:String(row.unit),variant_code:String(row.variant_code),options_snapshot:row.options_snapshot??{},supplier_sale_unit_price:Number(row.supplier_sale_unit_price),purchase_vat_rate:Number(row.purchase_vat_rate),currency:String(row.currency),supplier_mapping_version:Number(row.supplier_mapping_version)})), mappings: rows.filter(row => row.active).map(row => ({
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
  await enqueueIntercompanyMessageTx(tx,{destination_company_id:String(row.buyer_company_id),kind:"CATALOGUE_PUBLISHED",aggregate_id:payload.supplier_catalogue_mapping_id,revision:payload.supplier_mapping_version,payload});
  return payload;
}

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
  const addressLines = Array.isArray(delivery.address_lines)
    ? delivery.address_lines.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [delivery.house_number, delivery.street, delivery.address_complement, delivery.postal_code, delivery.city].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const payload = purchaseSubmittedPayloadSchema.parse({
    schema_version: 1, relation_id: first.relation_id, buyer_sales_order_id: String(params.buyerSalesOrderId), buyer_purchase_order_id: po.id,
    buyer_legal_snapshot: { legal_name: header.legal_name, registration_number: header.registration_number ?? undefined, vat_number: header.vat_number ?? undefined, address_lines: [`${header.house_number ?? ""} ${header.street}`.trim(), `${header.postal_code} ${header.city}`], issued_at: new Date().toISOString() },
    final_delivery_address_snapshot: { recipient_name: recipient, address_lines: addressLines, country_code: typeof delivery.country_code === "string" ? delivery.country_code.toUpperCase() : undefined, contact_name: typeof delivery.contact_name === "string" ? delivery.contact_name : undefined, contact_phone: typeof delivery.contact_phone === "string" ? delivery.contact_phone : undefined },
    lines: lines.rows.map((line, index) => ({ buyer_sales_order_line_id: line.id, buyer_purchase_order_line_id: poLines.rows[index].id, catalogue_mapping_id: line.mapping_id, supplier_catalogue_mapping_id: line.supplier_catalogue_mapping_id, mapping_version: line.version, supplier_mapping_version: line.supplier_mapping_version, supplier_article_id: line.supplier_article_id, supplier_piece_technique_id: line.supplier_piece_technique_id, supplier_piece_technique_version_id: line.supplier_piece_technique_version_id, supplier_reference: line.supplier_reference, variant_code: line.variant_code || "standard", options_snapshot: line.options_snapshot ?? {}, quantity: line.quantite, unit: line.unite, purchase_unit_price: line.purchase_unit_price, purchase_vat_rate: line.purchase_vat_rate, currency: line.currency })),
  });
  await enqueueIntercompanyMessageTx(tx, { destination_company_id: header.destination_company_id, kind: "PURCHASE_SUBMITTED", aggregate_id: po.id, revision: 1, payload });
  // The durable outbox row is the actual transmission intent.  Keep the native
  // PO lifecycle truthful without fabricating a supplier email/document.
  await tx.query(`UPDATE public.commande_fournisseur SET statut='ENVOYEE',date_envoi=now(),sent_by=$2,updated_by=$2 WHERE id=$1::uuid AND statut='BROUILLON'`, [po.id, params.audit.user_id]);
  await tx.query(`INSERT INTO public.commande_fournisseur_transition(commande_id,from_statut,to_statut,motif,acteur_id) VALUES($1::uuid,'BROUILLON','A_VALIDER','Soumission interentreprises automatique',$2),($1::uuid,'A_VALIDER','APPROUVEE','Approbation du flux interentreprises',$2),($1::uuid,'APPROUVEE','ENVOYEE','Message PURCHASE_SUBMITTED inscrit dans l''outbox',$2)`, [po.id, params.audit.user_id]);
  return po;
}
