import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {readClientForecast} from '../../client/repository/client-contract-forecast.repository';
import type {ClientContractForecast} from '../../client/types/client-contract-forecast.types';
import type {CreateCommandeInput} from '../types/commande-client.types';
type Queryer=Pick<PoolClient,'query'>;
export type PreparedForecastAllocation={forecast:ClientContractForecast;quantity:number;lineIndex:number};
const scaled=(value:number)=>Math.round(value*1000);
export async function prepareForecastAllocations(tx:Queryer,input:CreateCommandeInput,contractId:string):Promise<PreparedForecastAllocation[]> {
  const selections=input.lignes.flatMap((line,lineIndex)=>(line.client_forecast_allocations??[]).map(item=>({...item,lineIndex})));
  if(!selections.length)return [];
  const ids=selections.map(item=>item.forecast_id);
  if(selections.length>360||new Set(ids).size!==ids.length)throw new HttpError(422,'CLIENT_FORECAST_DUPLICATE','Choisissez chaque estimation une seule fois');
  await tx.query(`SELECT id FROM public.client_contract_forecasts WHERE contract_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,[contractId,ids]);
  const results:PreparedForecastAllocation[]=[];
  for(const item of selections) {
    const forecast=await readClientForecast(tx,contractId,item.forecast_id),line=input.lignes[item.lineIndex];
    if(!forecast||forecast.contract_line_id!==line.client_contract_line_id||forecast.article_snapshot.unit.toLowerCase()!==line.unite?.toLowerCase())
      throw new HttpError(422,'CLIENT_FORECAST_CALL_SCOPE','Cette estimation ne correspond pas à l’article du contrat');
    if(forecast.version!==item.expected_version||forecast.version>=2147483646)
      throw new HttpError(409,'CLIENT_FORECAST_CALL_CHANGED','L’estimation a changé. Actualisez avant de préparer l’appel.');
    if(forecast.status!=='ACTIVE'||scaled(item.quantity)>scaled(Number(forecast.remaining_quantity)))
      throw new HttpError(409,'CLIENT_FORECAST_CALL_REMAINDER','La quantité à convertir dépasse le reste de cette estimation');
    results.push({forecast,quantity:item.quantity,lineIndex:item.lineIndex});
  }
  input.lignes.forEach((line,index)=>{
    if(results.filter(item=>item.lineIndex===index).reduce((sum,item)=>sum+scaled(item.quantity),0)>scaled(line.quantite))
      throw new HttpError(422,'CLIENT_FORECAST_CALL_QUANTITY','La conversion ne peut pas dépasser la quantité de la ligne ferme',{field:`lignes.${index}.quantite`});
  });
  return results;
}
export async function recordForecastAllocations(tx:Queryer,allocations:PreparedForecastAllocation[],callLineId:string,lineIndex:number,actor:number) {
  for(const item of allocations.filter(value=>value.lineIndex===lineIndex)) {
    const f=item.forecast;
    await tx.query(`INSERT INTO public.client_forecast_call_allocations(id,forecast_id,call_line_id,contract_id,contract_line_id,
      unit_id,quantity,forecast_version_before,forecast_snapshot,actor_user_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb,$10)`,
    [randomUUID(),f.id,callLineId,f.contract_id,f.contract_line_id,f.unit_id,item.quantity,f.version,JSON.stringify(f),actor]);
  }
}
export async function assertForecastFirmQuantities(tx:Queryer,commandeId:string,input:CreateCommandeInput) {
  if(input.lignes.some(line=>line.client_forecast_allocations?.length))
    throw new HttpError(409,'CLIENT_FORECAST_CONVERSION_RETAINED','Les conversions enregistrées sont conservées. Préparez un nouvel appel pour convertir une autre estimation.');
  const rows=(await tx.query<{id:string;converted_quantity:string}>(`SELECT cl.commande_ligne_id::text AS id,sum(a.quantity)::text AS converted_quantity
    FROM public.client_forecast_call_allocations a JOIN public.client_contract_call_lines cl ON cl.id=a.call_line_id
    JOIN public.client_contract_calls call ON call.id=cl.call_id WHERE call.commande_id=$1::bigint GROUP BY cl.commande_ligne_id`,[commandeId])).rows;
  for(const row of rows) {
    const line=input.lignes.find(item=>String(item.id)===row.id);
    if(!line||scaled(line.quantite)<scaled(Number(row.converted_quantity)))
      throw new HttpError(409,'CLIENT_FORECAST_FIRM_QUANTITY_RETAINED','Cette commande contient une conversion de prévision. Sa quantité ne peut pas descendre sous la quantité convertie.');
  }
}
