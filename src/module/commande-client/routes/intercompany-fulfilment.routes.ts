import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { companyContextForRequest } from "../../entreprises/runtime/company-runtime.middleware";
import { requireFinanceCapability } from "../../facturation/middlewares/finance-authorization.middleware";

type Queryable = Pick<PoolClient, "query">;
type ReceiptRow = { message_id:string; receipt_id:string; seller_delivery_id:string; seller_delivery_number:string; dispatched_at:string; received_at:string; document_id:string; document_kind:"AUTHORITATIVE_SNAPSHOT"; document_snapshot_sha256:string; buyer_sales_order_id:string; commande_numero:string|null; client_id:string; client_name:string; line_no:number; buyer_sales_order_line_id:string; buyer_purchase_order_line_id:string; designation:string; code_piece:string|null; unit:string; quantity_proved:string; quantity_invoiced:string };

export type IntercompanyFulfilmentReceiptLineDto = {
  source_type:"EXTERNAL_FULFILMENT_RECEIPT_LINE"; source_id:string; source_line_id:string; line_no:number;
  commande_id:number; commande_numero:string|null; commande_ligne_id:number; buyer_purchase_order_line_id:string;
  designation:string; code_piece:string|null; unit:string; quantity_proved:string; quantity_already_invoiced:string; quantity_available:string;
};
export type IntercompanyFulfilmentReceiptDto = {
  message_id:string; receipt_id:string; seller_delivery:{id:string;number:string;dispatched_at:string}; received_at:string;
  buyer_order:{id:number;numero:string|null;client_id:string;client_name:string};
  document:{id:string;kind:"AUTHORITATIVE_SNAPSHOT";snapshot_sha256:string;publication_ready:false;native_document:null};
  lines:IntercompanyFulfilmentReceiptLineDto[];
};

function quantityAvailable(proved:string,invoiced:string):string {
  const available=Number(proved)-Number(invoiced);
  if (!Number.isFinite(available)) throw new Error("INTERCOMPANY_FULFILMENT_RECEIPT_QUANTITY_INVALID");
  return Math.max(0,available).toFixed(3);
}
function receiptRowsSql(detail:boolean):string { return `
 SELECT receipt.message_id::text AS message_id,receipt.receipt_id::text AS receipt_id,receipt.seller_delivery_id,receipt.seller_delivery_number,receipt.dispatched_at::text,receipt.received_at::text,receipt.document_id,receipt.document_kind,receipt.document_snapshot_sha256,receipt.buyer_sales_order_id::text,command.numero AS commande_numero,command.client_id,customer.company_name AS client_name,line.line_no,line.buyer_sales_order_line_id::text,line.buyer_purchase_order_line_id::text,order_line.designation,order_line.code_piece,line.unit,line.quantity::text AS quantity_proved,COALESCE(invoiced.quantity,0)::numeric(18,3)::text AS quantity_invoiced
 FROM public.cerp_intercompany_external_fulfilment_receipts receipt
 JOIN public.commande_client command ON command.id=receipt.buyer_sales_order_id AND command.fulfilment_mode='SUPPLIER_DROPSHIP'
 JOIN public.clients customer ON customer.client_id=command.client_id
 JOIN public.cerp_intercompany_external_fulfilment_receipt_lines line ON line.message_id=receipt.message_id
 JOIN public.commande_ligne order_line ON order_line.id=line.buyer_sales_order_line_id
 LEFT JOIN LATERAL (SELECT COALESCE(SUM(source.quantity_consumed),0) AS quantity FROM public.facture_source_allocations source WHERE source.source_type='EXTERNAL_FULFILMENT_RECEIPT_LINE' AND source.source_line_id=concat(line.message_id::text,':',line.line_no::text) AND source.allocation_status IN ('DRAFT','CONSUMED')) invoiced ON TRUE
 WHERE receipt.destination_company_id=$1::uuid AND receipt.environment=$2 ${detail?"AND receipt.message_id=$3::uuid":""}
 ORDER BY receipt.dispatched_at DESC,receipt.message_id,line.line_no`; }

/** Buyer-scoped evidence read model. Company and environment only come from the authenticated fixed runtime. */
export async function readIntercompanyFulfilmentReceipts(tx:Queryable,context:{company_id:string;environment:string},messageId?:string):Promise<IntercompanyFulfilmentReceiptDto[]> {
 const result=await tx.query<ReceiptRow>(receiptRowsSql(Boolean(messageId)),messageId?[context.company_id,context.environment,messageId]:[context.company_id,context.environment]);
 const receipts=new Map<string,IntercompanyFulfilmentReceiptDto>();
 for(const row of result.rows){let receipt=receipts.get(row.message_id);if(!receipt){receipt={message_id:row.message_id,receipt_id:row.receipt_id,seller_delivery:{id:row.seller_delivery_id,number:row.seller_delivery_number,dispatched_at:row.dispatched_at},received_at:row.received_at,buyer_order:{id:Number(row.buyer_sales_order_id),numero:row.commande_numero,client_id:row.client_id,client_name:row.client_name},document:{id:row.document_id,kind:row.document_kind,snapshot_sha256:row.document_snapshot_sha256,publication_ready:false,native_document:null},lines:[]};receipts.set(row.message_id,receipt)}receipt.lines.push({source_type:"EXTERNAL_FULFILMENT_RECEIPT_LINE",source_id:row.message_id,source_line_id:`${row.message_id}:${row.line_no}`,line_no:row.line_no,commande_id:Number(row.buyer_sales_order_id),commande_numero:row.commande_numero,commande_ligne_id:Number(row.buyer_sales_order_line_id),buyer_purchase_order_line_id:row.buyer_purchase_order_line_id,designation:row.designation,code_piece:row.code_piece,unit:row.unit,quantity_proved:row.quantity_proved,quantity_already_invoiced:row.quantity_invoiced,quantity_available:quantityAvailable(row.quantity_proved,row.quantity_invoiced)})}
 return [...receipts.values()];
}
export function contextForBuyer(req:import("express").Request){const context=companyContextForRequest(req);if(!context)throw new HttpError(403,"COMPANY_CONTEXT_REQUIRED","Sélectionnez votre entreprise.");return context}
const paramsSchema=z.object({messageId:z.string().uuid()}).strict();
const router=Router();
router.get("/",requireFinanceCapability("read"),asyncHandler(async(req,res)=>res.json({items:await readIntercompanyFulfilmentReceipts(pool,contextForBuyer(req))})));
router.get("/:messageId",requireFinanceCapability("read"),asyncHandler(async(req,res)=>{const {messageId}=paramsSchema.parse(req.params);const receipt=(await readIntercompanyFulfilmentReceipts(pool,contextForBuyer(req),messageId))[0];if(!receipt)throw new HttpError(404,"INTERCOMPANY_FULFILMENT_RECEIPT_NOT_FOUND","Reçu d'expédition introuvable.");res.json(receipt)}));
export default router;
