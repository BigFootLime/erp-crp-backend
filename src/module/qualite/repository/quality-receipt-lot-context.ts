import type {PoolClient} from "pg";
import {HttpError} from "../../../utils/httpError";
import {convertedStockQuantity,receiptUnitConversion} from "../../receptions/domain/receipt-unit-conversion";
import type {ExecutionPreviewBodyDTO} from "../validators/quality-360.validators";

/** Incoming material is inspected before stock entry, in the captured stock unit. */
export async function resolveReceiptLotContext(q:Pick<PoolClient,"query">,body:ExecutionPreviewBodyDTO,lock=false):Promise<ExecutionPreviewBodyDTO>{
  if(body.source_type!=="LOT"||body.trigger!=="RECEPTION")return body;
  if(body.source_id!==body.lot_id||!body.reception_ligne_id||!body.article_id||body.of_id||body.operation_code||body.bon_livraison_id||body.delivery_allocation_id||body.piece_version_id)
    throw new HttpError(422,"QUALITY_RECEIPT_SCOPE_INVALID","Le contrôle entrant doit désigner la ligne reçue, son lot et son article.");
  const row=(await q.query<{
    lot_id:string;article_id:string;piece_id:string|null;famille_id:string|null;fournisseur_id:string;
    status:string;unit:string|null;stock_unit:string|null;stock_conversion_coef:number|null;article_unit:string|null;qty:number;
  }>(`SELECT r.lot_id::text,r.article_id::text,a.piece_technique_id::text AS piece_id,p.famille_id::text,
      reception.fournisseur_id::text,reception.status,r.unite AS unit,r.stock_unit,r.stock_conversion_coef::float8,a.unite AS article_unit,r.qty_received::float8 AS qty
    FROM public.reception_fournisseur_lignes r JOIN public.receptions_fournisseurs reception ON reception.id=r.reception_id
    JOIN public.articles a ON a.id=r.article_id LEFT JOIN public.pieces_techniques p ON p.id=a.piece_technique_id
    WHERE r.id=$1::uuid ${lock?"FOR UPDATE OF r,reception":""}`,[body.reception_ligne_id])).rows[0];
  if(!row||row.lot_id!==body.lot_id||row.article_id!==body.article_id||(body.fournisseur_id&&body.fournisseur_id!==row.fournisseur_id)
      ||(body.piece_technique_id&&body.piece_technique_id!==row.piece_id)||(body.famille_id&&body.famille_id!==row.famille_id))
    throw new HttpError(409,"QUALITY_RECEIPT_SCOPE_CHANGED","Le lot, l’article ou le fournisseur ne correspond pas à la ligne de réception.");
  if(row.status==="CANCELLED")throw new HttpError(409,"QUALITY_RECEIPT_CANCELLED","Cette réception est annulée.");
  const conversion=row.stock_unit&&row.stock_conversion_coef
    ?{stockUnit:row.stock_unit,coefficient:row.stock_conversion_coef}
    :receiptUnitConversion({receiptUnit:row.unit,articleUnit:row.article_unit});
  if(conversion.stockUnit.trim().toUpperCase()!==row.article_unit?.trim().toUpperCase()||body.unite.trim().toUpperCase()!==conversion.stockUnit.trim().toUpperCase())
    throw new HttpError(409,"QUALITY_RECEIPT_UNIT_MISMATCH","Le contrôle doit utiliser l’unité de stock figée à réception.");
  const population=convertedStockQuantity(row.qty,conversion.coefficient);
  if(Math.abs(body.population-population)>1e-9)throw new HttpError(409,"QUALITY_RECEIPT_POPULATION_CHANGED","Le contrôle porte sur toute la ligne reçue ; la décision pourra libérer une quantité partielle.",{population,unit:conversion.stockUnit});
  if(lock)await q.query("SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE",[body.lot_id]);
  return {...body,unite:conversion.stockUnit,population,article_id:row.article_id,piece_technique_id:row.piece_id,famille_id:row.famille_id,fournisseur_id:row.fournisseur_id};
}
