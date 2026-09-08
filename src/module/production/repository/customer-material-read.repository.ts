import type {DossierDb} from './of-dossier.repository';
import type {MaterialRequirements} from '../domain/of-material';

export type CustomerMaterialCall={id:string;need_id:string;client_id:string;quantity:number;unit:string;requirements:MaterialRequirements;need_date:string|null;status:'PREPARED'|'SENT'|'ANNOUNCED'|'CANCELLED';sent_reference:string|null;announced_date:string|null;note:string;row_version:number;received:number;transferred:number;receipts:Array<{id:string;number:string;quantity:number;lotId:string|null}>};
export async function readCustomerMaterialCallsTx(tx:DossierDb,ofId:number){
  return (await tx.query<CustomerMaterialCall>(`SELECT c.*,c.need_id::text AS original_need_id,COALESCE(destination.target_need_id,c.need_id)::text AS need_id,c.quantity::float8,c.need_date::text,c.announced_date::text,
    COALESCE(r.received,0)::float8 AS received,COALESCE(t.transferred,0)::float8 AS transferred,COALESCE(r.receipts,'[]'::jsonb) AS receipts
    FROM public.of_customer_material_calls c JOIN public.of_material_needs n ON n.id=c.need_id
    LEFT JOIN public.v_of_material_need_destinations destination ON destination.source_need_id=c.need_id
    LEFT JOIN LATERAL(SELECT sum(l.qty_received*l.stock_conversion_coef) AS received,
      jsonb_agg(jsonb_build_object('id',h.id,'number',h.reception_no,'quantity',l.qty_received,'lotId',l.lot_id) ORDER BY l.created_at,l.id) AS receipts
      FROM public.reception_fournisseur_lignes l JOIN public.receptions_fournisseurs h ON h.id=l.reception_id WHERE l.customer_material_call_id=c.id) r ON true
    LEFT JOIN LATERAL(SELECT sum(s.qty_reserved) AS transferred FROM public.of_customer_material_receipt_transfers t JOIN public.stock_reservations s ON s.id=t.reservation_id WHERE t.call_id=c.id) t ON true
    WHERE n.of_id=$1 ORDER BY c.created_at,c.id`,[ofId])).rows;
}
