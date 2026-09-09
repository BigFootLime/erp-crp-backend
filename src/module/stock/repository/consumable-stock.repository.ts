import type { PoolClient } from "pg";
import { readOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { HttpError } from "../../../utils/httpError";

export type ConsumableStockCandidate = {
  key:string;articleId:string;lotId:string|null;lotCode:string|null;batchId:string|null;levelId:string;
  magasinId:string;emplacementId:number;destinationLabel:string;unit:string|null;available:number;total:number;reserved:number;
  pack:boolean;version:string;receivedAt:string|null;qualityReason:string|null;levelAvailable:number;
};

/** Both tracked lots and unbatched unit stock come from the canonical stock ledgers. */
export async function readConsumableStockTx(tx:Pick<PoolClient,"query">,articleIds:string[]):Promise<ConsumableStockCandidate[]> {
  if(!articleIds.length)return [];
  const candidates=(await tx.query<ConsumableStockCandidate>(`SELECT
    b.id::text AS key,s.article_id::text AS "articleId",l.id::text AS "lotId",l.lot_code AS "lotCode",b.id::text AS "batchId",s.id::text AS "levelId",
    e.magasin_id::text AS "magasinId",e.id::int AS "emplacementId",concat_ws(' / ',m.code,e.code) AS "destinationLabel",a.unite AS unit,
    GREATEST(0,LEAST(b.qty_total-b.qty_reserved-b.qty_depreciated,s.qty_total-s.qty_reserved-s.qty_depreciated))::float8 AS available,
    b.qty_total::float8 AS total,b.qty_reserved::float8 AS reserved,l.is_consumable_pack AS pack,
    concat_ws(':',s.updated_at,l.updated_at,b.qty_total,b.qty_reserved,b.qty_depreciated) AS version,l.received_at::text AS "receivedAt",NULL::text AS "qualityReason",
    GREATEST(0,s.qty_total-s.qty_reserved-s.qty_depreciated)::float8 AS "levelAvailable"
    FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id JOIN public.lots l ON l.id=b.lot_id
    JOIN public.articles a ON a.id=s.article_id JOIN public.emplacements e ON e.location_id=s.location_id JOIN public.magasins m ON m.id=e.magasin_id
    WHERE s.article_id=ANY($1::uuid[]) AND a.stock_managed AND b.qty_total>0
    UNION ALL
    SELECT s.id::text,s.article_id::text,NULL,NULL,NULL,s.id::text,e.magasin_id::text,e.id::int,concat_ws(' / ',m.code,e.code),a.unite,
      GREATEST(0,s.qty_total-s.qty_reserved-s.qty_depreciated-COALESCE(b.available,0))::float8,
      GREATEST(0,s.qty_total-COALESCE(b.total,0))::float8,GREATEST(0,s.qty_reserved-COALESCE(b.reserved,0))::float8,false,s.updated_at::text,NULL,NULL,
      GREATEST(0,s.qty_total-s.qty_reserved-s.qty_depreciated)::float8
    FROM public.stock_levels s JOIN public.articles a ON a.id=s.article_id JOIN public.emplacements e ON e.location_id=s.location_id JOIN public.magasins m ON m.id=e.magasin_id
    LEFT JOIN LATERAL(SELECT sum(qty_total) AS total,sum(qty_reserved) AS reserved,sum(qty_total-qty_reserved-qty_depreciated) AS available FROM public.stock_batches WHERE stock_level_id=s.id) b ON true
    WHERE s.article_id=ANY($1::uuid[]) AND a.stock_managed AND NOT a.lot_tracking AND s.qty_total>COALESCE(b.total,0)
    ORDER BY "receivedAt" NULLS LAST,key`,[articleIds])).rows;
  const quality=new Map<string,{available:number;reason:string|null}>();
  for(const c of candidates){
    if(!c.lotId)continue;
    if(!quality.has(c.lotId))try{
      const decision=await readOperationalLotQualityEligibility({client:tx,lotId:c.lotId,qty:candidates.filter(s=>s.lotId===c.lotId).reduce((sum,s)=>sum+s.available,0),unit:c.unit,purpose:"RESERVE"});
      quality.set(c.lotId,{available:decision.available,reason:decision.eligibility.blocks.filter(b=>b.code!=="QTY_NOT_RELEASED").map(b=>b.message).join(" ")||null});
    }catch(e){if(!(e instanceof HttpError)||e.status>=500)throw e;quality.set(c.lotId,{available:0,reason:e.message});}
    const decision=quality.get(c.lotId)!;
    c.available=Math.min(c.available,decision.available);c.qualityReason=decision.reason;
    decision.available=Math.max(0,decision.available-c.available);
  }
  const remainingLevels=new Map<string,number>();
  for(const c of candidates){
    const remaining=remainingLevels.get(c.levelId)??c.levelAvailable;
    c.available=Math.min(c.available,c.total,remaining);
    remainingLevels.set(c.levelId,Math.max(0,remaining-c.available));
  }
  return candidates;
}
