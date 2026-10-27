import type { PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import type { IntercompanyMessage } from "./intercompany-message";

const decisionSchema=z.object({schema_version:z.literal(1),request_id:z.string().uuid(),buyer_sales_order_id:z.string().regex(/^[1-9]\d*$/),buyer_purchase_order_id:z.string().uuid(),request_revision:z.number().int().positive(),decision_version:z.number().int().positive(),state:z.enum(["ACCEPTED","REJECTED","CANCELLED"]),supplier_sales_order_id:z.string().trim().min(1).max(200).nullable(),reason:z.string().trim().min(1).max(1000).nullable()}).strict();

/** Applies an authenticated supplier decision to opaque buyer-local PO links only. */
export async function applyCommercialIntercompanyMessageTx(tx:Pick<PoolClient,"query">,message:IntercompanyMessage):Promise<void>{
  if(message.kind!=="ORDER_DECIDED") throw new HttpError(409,"INTERCOMPANY_COMMERCIAL_KIND_UNSUPPORTED","Le message commercial n'est pas une décision fournisseur.");
  const payload=decisionSchema.parse(message.payload);
  if(message.aggregate_id!==payload.buyer_purchase_order_id||message.revision!==payload.decision_version) throw new HttpError(400,"INTERCOMPANY_DECISION_ENVELOPE_INVALID","La révision de décision ne correspond pas à son enveloppe.");
  const result=await tx.query(`UPDATE public.intercompany_purchase_order_links link SET supplier_request_id=$4::uuid,supplier_request_revision=$5,supplier_decision_version=$6,supplier_order_state=$7,supplier_sales_order_id=$8
    FROM public.intercompany_supplier_relations relation
    WHERE link.buyer_purchase_order_id=$1::uuid AND link.buyer_sales_order_id=$2::bigint AND link.relation_id=relation.id
      AND relation.buyer_company_id=$8::uuid AND relation.supplier_company_id=$9::uuid AND relation.environment=$10
      AND (link.supplier_decision_version IS NULL OR link.supplier_decision_version < $5)`,[payload.buyer_purchase_order_id,payload.buyer_sales_order_id,payload.request_id,payload.request_revision,payload.decision_version,payload.state,payload.supplier_sales_order_id,message.destination_company_id,message.source_company_id,message.environment]);
  if((result.rowCount??0)===0){const exists=await tx.query(`SELECT 1 FROM public.intercompany_purchase_order_links WHERE buyer_purchase_order_id=$1::uuid`,[payload.buyer_purchase_order_id]);if(!exists.rows[0])throw new HttpError(404,"INTERCOMPANY_PURCHASE_LINK_NOT_FOUND","Le lien d'achat interentreprises est introuvable.");}
}
