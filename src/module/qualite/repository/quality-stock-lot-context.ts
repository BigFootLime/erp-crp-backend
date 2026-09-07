import type {PoolClient} from "pg";
import {HttpError} from "../../../utils/httpError";
import type {ExecutionPreviewBodyDTO} from "../validators/quality-360.validators";

/** A stock recheck gets its article and physical population from the actual lot. */
export async function resolveStockLotContext(q:Pick<PoolClient,"query">,body:ExecutionPreviewBodyDTO,lock=false):Promise<ExecutionPreviewBodyDTO>{
  if(body.source_type!=="LOT"||body.trigger!=="RECHECK")return body;
  if(body.lot_id!==body.source_id||!body.article_id||body.of_id||body.reception_ligne_id||body.bon_livraison_id||body.delivery_allocation_id||body.operation_code||body.fournisseur_id){
    throw new HttpError(422,"QUALITY_STOCK_LOT_SCOPE_INVALID","Le contrôle matière doit désigner un lot et son article, sans autre objet consommateur.");
  }
  const result=await q.query<{article_id:string;piece_technique_id:string|null;famille_id:string|null;unite:string|null;population:number}>(`
    SELECT l.article_id::text,a.piece_technique_id::text,p.famille_id::text,a.unite,
      (SELECT COALESCE(sum(GREATEST(0,b.qty_total-b.qty_depreciated)),0)::float8 FROM public.stock_batches b WHERE b.lot_id=l.id) AS population
    FROM public.lots l JOIN public.articles a ON a.id=l.article_id
    LEFT JOIN public.pieces_techniques p ON p.id=a.piece_technique_id
    WHERE l.id=$1::uuid ${lock?"FOR UPDATE OF l":""}`,[body.lot_id]);
  const lot=result.rows[0];
  if(!lot)throw new HttpError(404,"QUALITY_LOT_NOT_FOUND","Lot introuvable.");
  if(lot.article_id!==body.article_id||(body.piece_technique_id&&body.piece_technique_id!==lot.piece_technique_id)||(body.famille_id&&body.famille_id!==lot.famille_id)||body.piece_version_id){
    throw new HttpError(409,"QUALITY_STOCK_LOT_ARTICLE_MISMATCH","Le contexte technique ne correspond pas à l’article du lot.");
  }
  if(!lot.unite||lot.unite.trim().toUpperCase()!==body.unite.trim().toUpperCase())throw new HttpError(409,"QUALITY_STOCK_LOT_UNIT_MISMATCH","L’unité du contrôle ne correspond pas à l’article du lot.");
  if(body.population>lot.population+1e-9)throw new HttpError(409,"QUALITY_STOCK_LOT_QUANTITY_CHANGED","La quantité à contrôler dépasse le stock physique actuel. Actualisez le dossier matière.",{available:lot.population});
  return {...body,article_id:lot.article_id,piece_technique_id:lot.piece_technique_id,famille_id:lot.famille_id,unite:lot.unite};
}
