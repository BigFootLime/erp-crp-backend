import type {PoolClient} from "pg";
import {HttpError} from "../../../utils/httpError";

type MaterialExecution={id:string;source_type:string|null;source_id:string|null;lot_id:string|null;trigger_type:string|null;correlation_id:string|null};
export async function applyMaterialLotDecision(tx:PoolClient,input:{execution:MaterialExecution;decision:"FULL"|"PARTIAL"|"HOLD"|"REJECT";released:number;unit:string;actorId:number;decisionId:string}){
  const e=input.execution;
  if(e.source_type!=="LOT"||e.source_id!==e.lot_id||!e.lot_id||!["RECEPTION","RECHECK"].includes(e.trigger_type??""))return null;
  const lot=(await tx.query<{lot_status:string}>("SELECT lot_status FROM public.lots WHERE id=$1::uuid FOR UPDATE",[e.lot_id])).rows[0];
  if(!lot)throw new HttpError(409,"QUALITY_LOT_NOT_FOUND","Lot introuvable.");
  const latest=(await tx.query<{id:string}>(`SELECT id::text FROM public.quality_control WHERE lot_id=$1::uuid OR(source_type='LOT' AND source_id=$1::text)
    ORDER BY control_date DESC,id DESC LIMIT 1`,[e.lot_id])).rows[0];
  if(latest?.id!==e.id)throw new HttpError(409,"QUALITY_CONTROL_SUPERSEDED","Un contrôle plus récent existe pour ce lot. Ouvrez-le avant de décider de sa disponibilité.");
  const status=input.decision==="REJECT"?"BLOQUE":input.released>0?"LIBERE":"QUARANTAINE";
  const note=input.released>0?`Qualité : ${input.released} ${input.unit} libéré(s). Seule cette quantité est utilisable. Décision ${input.decisionId}.`:`Qualité : ${status==="BLOQUE"?"lot refusé":"lot en attente de disposition"}. Décision ${input.decisionId}.`;
  await tx.query("UPDATE public.lots SET lot_status=$2,lot_status_note=$3,updated_at=now(),updated_by=$4 WHERE id=$1::uuid",[e.lot_id,status,note,input.actorId]);
  await tx.query(`INSERT INTO public.stock_lot_event_log(lot_id,event_type,old_values,new_values,actor_user_id,correlation_id)
    VALUES($1::uuid,'QUALITY_MATERIAL_DECIDED',$2::jsonb,$3::jsonb,$4,$5::uuid)`,[e.lot_id,JSON.stringify({lot_status:lot.lot_status}),JSON.stringify({lot_status:status,quality_control_id:e.id,release_decision_id:input.decisionId,released_quantity:input.released,unit:input.unit}),input.actorId,e.correlation_id]);
  return {lot_id:e.lot_id,before:lot.lot_status,after:status,released_quantity:input.released};
}
