import type { PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import type { IntercompanyMessage } from "./intercompany-message";

const decisionSchema=z.object({schema_version:z.literal(1),request_id:z.string().uuid(),buyer_sales_order_id:z.string().regex(/^[1-9]\d*$/),buyer_purchase_order_id:z.string().uuid(),request_revision:z.number().int().positive(),decision_version:z.number().int().positive(),state:z.enum(["ACCEPTED","REJECTED","CANCELLED","CANCELLATION_REJECTED","CANCEL_REQUESTED"]),supplier_sales_order_id:z.string().trim().min(1).max(200).nullable(),reason:z.string().trim().min(1).max(1000).nullable()}).strict();
const publishedSchema=z.object({schema_version:z.literal(1),relation_id:z.string().uuid(),supplier_catalogue_mapping_id:z.string().uuid(),supplier_article_id:z.string().uuid(),supplier_piece_technique_id:z.string().uuid().nullable(),supplier_piece_technique_version_id:z.string().uuid().nullable(),supplier_reference:z.string().max(160).nullable(),designation:z.string().min(1).max(400),unit:z.string().min(1).max(30),variant_code:z.string().min(1).max(100),options_snapshot:z.record(z.string(),z.union([z.string(),z.number(),z.boolean(),z.null()])),supplier_sale_unit_price:z.number().finite().min(0),purchase_vat_rate:z.number().finite().min(0).max(100),currency:z.string().regex(/^[A-Z]{3}$/),supplier_mapping_version:z.number().int().positive(),active:z.boolean()}).strict();

/** Applies an authenticated supplier decision to opaque buyer-local PO links only. */
export async function applyCommercialIntercompanyMessageTx(tx:Pick<PoolClient,"query">,message:IntercompanyMessage):Promise<void>{
  if(message.kind==="RELATION_PROPOSED"){
    const p=z.object({schema_version:z.literal(1),relation_id:z.string().uuid(),buyer_company_id:z.string().uuid(),supplier_company_id:z.string().uuid(),currency:z.string().regex(/^[A-Z]{3}$/)}).strict().parse(message.payload);
    if(message.aggregate_id!==p.relation_id||message.source_company_id===message.destination_company_id||(message.source_company_id!==p.buyer_company_id&&message.source_company_id!==p.supplier_company_id)||message.destination_company_id===message.source_company_id)throw new HttpError(400,"INTERCOMPANY_RELATION_PROPOSAL_INVALID","Proposition de relation invalide.");
    await tx.query(`INSERT INTO public.intercompany_relation_proposals(relation_id,source_company_id,destination_company_id,environment,currency,proposed_role) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) ON CONFLICT(relation_id) DO NOTHING`,[p.relation_id,message.source_company_id,message.destination_company_id,message.environment,p.currency,message.destination_company_id===p.buyer_company_id?'BUYER':'SUPPLIER']);return;
  }
  if(message.kind==="RELATION_ACCEPTED") return;
  if(message.kind==="CATALOGUE_PUBLISHED"){
    const p=publishedSchema.parse(message.payload);
    if(message.aggregate_id!==p.supplier_catalogue_mapping_id||message.revision!==p.supplier_mapping_version) throw new HttpError(400,"INTERCOMPANY_CATALOGUE_ENVELOPE_INVALID","La révision catalogue ne correspond pas à son enveloppe.");
    const scope=await tx.query(`SELECT 1 FROM public.intercompany_supplier_relations r WHERE r.id=$1::uuid AND r.local_role='BUYER' AND r.buyer_company_id=$2::uuid AND r.supplier_company_id=$3::uuid AND r.environment=$4 AND r.status='ACTIVE' FOR SHARE`,[p.relation_id,message.destination_company_id,message.source_company_id,message.environment]);
    if(!scope.rows[0]) throw new HttpError(404,"INTERCOMPANY_CATALOGUE_RELATION_NOT_FOUND","La relation acheteur de cette offre est absente ou inactive.");
    const applied=await tx.query(`INSERT INTO public.intercompany_supplier_catalogue_projections(supplier_catalogue_mapping_id,relation_id,supplier_article_id,supplier_piece_technique_id,supplier_piece_technique_version_id,supplier_reference,designation,unit,variant_code,options_snapshot,supplier_sale_unit_price,purchase_vat_rate,currency,supplier_mapping_version,active)
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15
      ON CONFLICT(supplier_catalogue_mapping_id) DO UPDATE SET designation=EXCLUDED.designation,unit=EXCLUDED.unit,variant_code=EXCLUDED.variant_code,options_snapshot=EXCLUDED.options_snapshot,supplier_sale_unit_price=EXCLUDED.supplier_sale_unit_price,purchase_vat_rate=EXCLUDED.purchase_vat_rate,currency=EXCLUDED.currency,supplier_mapping_version=EXCLUDED.supplier_mapping_version,active=EXCLUDED.active,published_at=now()
      WHERE public.intercompany_supplier_catalogue_projections.relation_id=EXCLUDED.relation_id AND public.intercompany_supplier_catalogue_projections.supplier_mapping_version < EXCLUDED.supplier_mapping_version RETURNING supplier_catalogue_mapping_id`,[p.supplier_catalogue_mapping_id,p.relation_id,p.supplier_article_id,p.supplier_piece_technique_id,p.supplier_piece_technique_version_id,p.supplier_reference,p.designation,p.unit,p.variant_code,JSON.stringify(p.options_snapshot),p.supplier_sale_unit_price,p.purchase_vat_rate,p.currency,p.supplier_mapping_version,p.active]);
    if((applied.rowCount??0)===0){const replay=await tx.query<{relation_id:string;supplier_mapping_version:number}>(`SELECT relation_id::text,supplier_mapping_version FROM public.intercompany_supplier_catalogue_projections WHERE supplier_catalogue_mapping_id=$1::uuid`,[p.supplier_catalogue_mapping_id]);if(!replay.rows[0]||replay.rows[0].relation_id!==p.relation_id||replay.rows[0].supplier_mapping_version!==p.supplier_mapping_version)throw new HttpError(409,"INTERCOMPANY_CATALOGUE_REPLAY_CONFLICT","Cette publication catalogue entre en conflit avec une autre relation ou révision.");}
    return;
  }
  if(message.kind!=="ORDER_DECIDED") throw new HttpError(409,"INTERCOMPANY_COMMERCIAL_KIND_UNSUPPORTED","Le message commercial n'est pas une décision fournisseur.");
  const payload=decisionSchema.parse(message.payload);
  if(message.aggregate_id!==payload.buyer_purchase_order_id||message.revision!==payload.decision_version) throw new HttpError(400,"INTERCOMPANY_DECISION_ENVELOPE_INVALID","La révision de décision ne correspond pas à son enveloppe.");
  const result=await tx.query(`UPDATE public.intercompany_purchase_order_links link SET supplier_request_id=$3::uuid,supplier_request_revision=$4,supplier_decision_version=$5,supplier_order_state=$6,supplier_sales_order_id=$7
    FROM public.intercompany_supplier_relations relation
    WHERE link.buyer_purchase_order_id=$1::uuid AND link.buyer_sales_order_id=$2::bigint AND link.relation_id=relation.id
      AND relation.buyer_company_id=$8::uuid AND relation.supplier_company_id=$9::uuid AND relation.environment=$10
      AND (link.supplier_decision_version IS NULL OR link.supplier_decision_version < $5)`,[payload.buyer_purchase_order_id,payload.buyer_sales_order_id,payload.request_id,payload.request_revision,payload.decision_version,payload.state,payload.supplier_sales_order_id,message.destination_company_id,message.source_company_id,message.environment]);
  if((result.rowCount??0)===0){const exists=await tx.query(`SELECT 1 FROM public.intercompany_purchase_order_links WHERE buyer_purchase_order_id=$1::uuid`,[payload.buyer_purchase_order_id]);if(!exists.rows[0])throw new HttpError(404,"INTERCOMPANY_PURCHASE_LINK_NOT_FOUND","Le lien d'achat interentreprises est introuvable.");}
}
