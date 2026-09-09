import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { coverageFingerprint,quantity } from '../../production/domain/of-material';
import type { ExpectedReceiptsQuery } from '../validators/grouped-receipts.validators';
import { readReceiptLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { HttpError } from '../../../utils/httpError';

export type ExpectedReceiptLine={id:string;orderId:string;orderCode:string;supplierId:string;supplierName:string;supplierCode:string|null;articleId:string|null;articleCode:string|null;crpReference:string|null;supplierReference:string|null;
  designation:string;type:string;categories:string[];unit:string|null;stockUnit:string|null;coefficient:number;ordered:number;received:number;remaining:number;accepted:number;stocked:number;
  stockManaged:boolean;qualityRequired:boolean;consumptionMode:string;lotTracking:boolean;due:string|null;destinationId:string|null;price:number|null;currency:string;
  ofs:Array<{id:number;number:string}>;version:string;orderVersion:string;articleVersion:string;status:string;total:number};
export async function readExpectedReceiptLinesTx(tx:Pick<PoolClient,'query'>,filters:ExpectedReceiptsQuery,lineIds?:string[]){
  const values:unknown[]=[],conditions=["l.statut_ligne='ACTIVE'","c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE','RECUE')"];
  const bind=(v:unknown)=>{values.push(v);return `$${values.length}`;};
  if(lineIds)conditions.push(`l.id=ANY(${bind(lineIds)}::uuid[])`);else conditions.push('l.quantite-l.qty_annulee-COALESCE(r.received,0)>0');
  if(filters.q){const p=bind(`%${filters.q}%`);conditions.push(`concat_ws(' ',c.code,f.nom,f.raison_sociale,a.code,a.internal_reference,l.reference_fournisseur,l.designation) ILIKE ${p}`);}
  if(filters.orderId)conditions.push(`c.id=${bind(filters.orderId)}::uuid`);
  if(filters.orderCode)conditions.push(`c.code ILIKE ${bind(`%${filters.orderCode}%`)}`);
  if(filters.supplierName)conditions.push(`concat_ws(' ',f.code,f.code_fournisseur,f.nom,f.raison_sociale) ILIKE ${bind(`%${filters.supplierName}%`)}`);
  if(filters.ofNumber)conditions.push(`EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne_besoin b JOIN public.ordres_fabrication o ON o.id=b.besoin_of_id WHERE b.ligne_id=l.id AND NOT b.annule AND o.numero ILIKE ${bind(`%${filters.ofNumber}%`)})`);
  if(filters.supplierId)conditions.push(`c.fournisseur_id=${bind(filters.supplierId)}::uuid`);
  if(filters.category){const p=bind(filters.category);conditions.push(`(l.type=${p} OR ${p}=ANY(COALESCE(categories.codes,'{}'::text[])))`);}
  if(filters.ofId)conditions.push(`EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne_besoin b WHERE b.ligne_id=l.id AND NOT b.annule AND b.besoin_of_id=${bind(filters.ofId)})`);
  if(filters.dateFrom)conditions.push(`COALESCE(l.date_promesse,c.date_promesse,l.date_besoin,c.date_besoin)>=${bind(filters.dateFrom)}::date`);
  if(filters.dateTo)conditions.push(`COALESCE(l.date_promesse,c.date_promesse,l.date_besoin,c.date_besoin)<=${bind(filters.dateTo)}::date`);
  if(filters.partial==='true')conditions.push('COALESCE(r.received,0)>0 AND COALESCE(r.received,0)<l.quantite-l.qty_annulee');
  if(filters.partial==='false')conditions.push('COALESCE(r.received,0)=0');
  const limit=lineIds?'':`LIMIT ${bind(filters.pageSize)} OFFSET ${bind((filters.page-1)*filters.pageSize)}`;
  const items=(await tx.query<ExpectedReceiptLine>(`SELECT l.id::text,c.id::text AS "orderId",c.code AS "orderCode",c.statut AS status,f.id::text AS "supplierId",COALESCE(f.nom,f.raison_sociale) AS "supplierName",COALESCE(f.code,f.code_fournisseur) AS "supplierCode",
    l.article_id::text AS "articleId",a.code AS "articleCode",a.internal_reference AS "crpReference",l.reference_fournisseur AS "supplierReference",l.designation,l.type,COALESCE(categories.codes,'{}'::text[]) AS categories,
    l.unite AS unit,COALESCE(l.unite_stock,a.unite,l.unite) AS "stockUnit",COALESCE(l.coef_conversion,1)::float8 AS coefficient,l.quantite::float8 AS ordered,
    COALESCE(r.received,0)::float8 AS received,GREATEST(0,l.quantite-l.qty_annulee-COALESCE(r.received,0))::float8 AS remaining,
    COALESCE(s.qty,0)::float8 AS stocked,COALESCE(l.receipt_stock_managed,a.stock_managed,false) AS "stockManaged",
    COALESCE(l.receipt_quality_required,a.receipt_quality_required,true) AS "qualityRequired",COALESCE(l.receipt_consumption_mode,a.consumption_mode,'UNIT') AS "consumptionMode",
    COALESCE(a.lot_tracking,false) AS "lotTracking",COALESCE(l.date_promesse,c.date_promesse,l.date_besoin,c.date_besoin)::text AS due,
    COALESCE(l.magasin_id,c.magasin_livraison_id)::text AS "destinationId",l.prix_unitaire_ht::float8 AS price,c.devise AS currency,
    COALESCE(alloc.ofs,'[]'::jsonb) AS ofs,l.updated_at::text AS version,c.updated_at::text AS "orderVersion",a.updated_at::text AS "articleVersion",count(*) OVER()::int AS total
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id JOIN public.fournisseurs f ON f.id=c.fournisseur_id LEFT JOIN public.articles a ON a.id=l.article_id
    LEFT JOIN LATERAL(SELECT array_agg(category_code) AS codes FROM public.article_category_link WHERE article_id=a.id) categories ON true
    LEFT JOIN LATERAL(SELECT sum(qty_received) AS received FROM public.reception_fournisseur_lignes WHERE commande_fournisseur_ligne_id=l.id) r ON true
    LEFT JOIN LATERAL(SELECT sum(s.qty) AS qty FROM public.reception_fournisseur_stock_receipts s JOIN public.reception_fournisseur_lignes r ON r.id=s.reception_line_id WHERE r.commande_fournisseur_ligne_id=l.id) s ON true
    LEFT JOIN LATERAL(SELECT jsonb_agg(DISTINCT jsonb_build_object('id',o.id,'number',o.numero)) AS ofs FROM public.commande_fournisseur_ligne_besoin b JOIN public.ordres_fabrication o ON o.id=b.besoin_of_id WHERE b.ligne_id=l.id AND NOT b.annule) alloc ON true
    WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(l.date_promesse,c.date_promesse,l.date_besoin,c.date_besoin) NULLS LAST,c.code,l.position,l.id ${limit}`,values)).rows;
  const receipts=(await tx.query<{id:string;orderLineId:string;lotId:string|null;quantity:number;stockUnit:string;coefficient:number;qualityRequired:boolean}>(`SELECT r.id::text,r.commande_fournisseur_ligne_id::text AS "orderLineId",r.lot_id::text AS "lotId",r.qty_received::float8 AS quantity,
    r.stock_unit AS "stockUnit",COALESCE(r.stock_conversion_coef,1)::float8 AS coefficient,r.receipt_quality_required AS "qualityRequired"
    FROM public.reception_fournisseur_lignes r WHERE r.commande_fournisseur_ligne_id=ANY($1::uuid[])`,[items.map(i=>i.id)])).rows;
  for(const item of items){
    item.accepted=0;
    for(const receipt of receipts.filter(r=>r.orderLineId===item.id)){
      if(!receipt.qualityRequired){item.accepted+=receipt.quantity;continue;}
      if(!receipt.lotId)continue;
      try{const gate=await readReceiptLotQualityEligibility({client:tx,lotId:receipt.lotId,receiptLineId:receipt.id,qty:receipt.quantity*receipt.coefficient,unit:receipt.stockUnit});
        item.accepted+=Math.min(receipt.quantity,gate.eligibility.qty_allowed/receipt.coefficient);
      }catch(e){if(!(e instanceof HttpError)||e.status>=500)throw e;}
    }
    item.accepted=quantity(item.accepted);
    const {total:_total,version:lineVersion,...facts}=item;
    item.version=coverageFingerprint({...facts,lineVersion});
  }
  return {items,total:items[0]?.total??0,page:filters.page,pageSize:filters.pageSize};
}
export async function getExpectedReceiptLines(filters:ExpectedReceiptsQuery){
  const tx=await pool.connect();try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await readExpectedReceiptLinesTx(tx,filters);await tx.query('COMMIT');return result;}
  catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}
