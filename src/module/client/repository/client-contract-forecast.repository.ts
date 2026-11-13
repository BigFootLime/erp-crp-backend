import type {PoolClient} from 'pg';
import type {ClientContractForecast,ClientForecastResult} from '../types/client-contract-forecast.types';
import type {ClientForecastCommand,ClientForecastQuery} from '../validators/client-contract-forecast.validators';
import type {ClientContractArticle} from '../types/client-contract.types';
type Queryer=Pick<PoolClient,'query'>;
const FIELDS=`f.id::text,f.contract_id::text,f.contract_line_id::text,f.root_article_id::text,f.unit_id::text,
  f.article_snapshot,to_char(f.month,'YYYY-MM') AS month,f.quantity::text,f.delivery_due::text,f.estimate_date::text,
  f.status,f.version,f.created_at::text,f.updated_at::text,f.updated_by,actor.username AS actor_label,
  coverage.converted_quantity::text,coverage.remaining_quantity::text`;
export const CLIENT_FORECAST_LIST_SQL=`WITH source AS MATERIALIZED (
  SELECT ${FIELDS} FROM public.client_contract_forecasts f JOIN public.users actor ON actor.id=f.updated_by
  JOIN public.v_client_contract_forecast_coverage coverage ON coverage.forecast_id=f.id
  WHERE f.contract_id=$1::uuid AND f.month>=$2::date AND f.month<($2::date+make_interval(months=>$3::int))::date
),page AS (SELECT * FROM source ORDER BY month,article_snapshot->>'code',id LIMIT 25 OFFSET $4)
SELECT (SELECT count(*)::int FROM source) AS total,
  COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY month,article_snapshot->>'code',id) FROM page),'[]'::jsonb) AS items`;
export async function listClientForecasts(db:Queryer,id:string,query:ClientForecastQuery) {
  const month=query.start_month??(await db.query<{month:string}>(`SELECT to_char(now() AT TIME ZONE 'Europe/Paris','YYYY-MM') AS month`)).rows[0].month;
  const data=(await db.query<{total:number;items:ClientContractForecast[]}>(CLIENT_FORECAST_LIST_SQL,
    [id,month+'-01',query.months,(query.page-1)*25])).rows[0];
  return {...data,start_month:month,months:query.months,page:query.page,page_size:25};
}
export async function readClientForecast(db:Queryer,contractId:string,id:string) {
  return (await db.query<ClientContractForecast>(`SELECT ${FIELDS} FROM public.client_contract_forecasts f
    JOIN public.users actor ON actor.id=f.updated_by JOIN public.v_client_contract_forecast_coverage coverage ON coverage.forecast_id=f.id
    WHERE f.contract_id=$1::uuid AND f.id=$2::uuid`,[contractId,id])).rows[0]??null;
}
export async function lockClientForecast(db:Queryer,contractId:string,command:ClientForecastCommand) {
  const row=(await db.query<{id:string}>(command.action==='SAVE'
    ?`SELECT id::text FROM public.client_contract_forecasts WHERE contract_id=$1::uuid AND contract_line_id=$2::uuid AND month=$3::date FOR UPDATE`
    :`SELECT id::text FROM public.client_contract_forecasts WHERE contract_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
  command.action==='SAVE'?[contractId,command.contract_line_id,command.month+'-01']:[contractId,command.forecast_id])).rows[0];
  return row?readClientForecast(db,contractId,row.id):null;
}
export async function readClientForecastReplay(db:Queryer,actor:number,key:string) {
  return (await db.query<{request_hash:string;result_payload:ClientForecastResult}>(`SELECT request_hash,result_payload
    FROM public.client_contract_forecast_events WHERE actor_user_id=$1 AND idempotency_key=$2::uuid`,[actor,key])).rows[0]??null;
}
export async function readClientForecastHistory(db:Queryer,id:string,page:number) {
  const items=(await db.query(`SELECT e.id::text,e.action,e.reason,e.contract_version,e.created_at::text,actor.username AS actor_label,
    e.previous_snapshot,e.result_payload FROM public.client_contract_forecast_events e
    JOIN public.users actor ON actor.id=e.actor_user_id WHERE e.forecast_id=$1::uuid ORDER BY e.created_at DESC,e.id DESC
    LIMIT 25 OFFSET $2`,[id,(page-1)*25])).rows;
  const total=(await db.query<{total:number}>(`SELECT count(*)::int AS total FROM public.client_contract_forecast_events WHERE forecast_id=$1::uuid`,[id])).rows[0].total;
  return {items,total,page,page_size:25};
}
export async function readClientForecastConversions(db:Queryer,id:string,page:number) {
  const items=(await db.query(`SELECT a.id::text,a.quantity::text,a.forecast_version_before,a.created_at::text,
    actor.username AS actor_label,call.commande_id::text,commande.numero,call.customer_reference,
    cl.commande_ligne_id::text,cl.initial_due_date::text,line.delai_client AS current_due_date,line.quantite::text AS current_qty
    FROM public.client_forecast_call_allocations a JOIN public.users actor ON actor.id=a.actor_user_id
    JOIN public.client_contract_call_lines cl ON cl.id=a.call_line_id JOIN public.client_contract_calls call ON call.id=cl.call_id
    JOIN public.commande_client commande ON commande.id=call.commande_id JOIN public.commande_ligne line ON line.id=cl.commande_ligne_id
    WHERE a.forecast_id=$1::uuid ORDER BY a.created_at DESC,a.id DESC LIMIT 25 OFFSET $2`,[id,(page-1)*25])).rows;
  const total=(await db.query<{total:number}>(`SELECT count(*)::int AS total FROM public.client_forecast_call_allocations WHERE forecast_id=$1::uuid`,[id])).rows[0].total;
  return {items,total,page,page_size:25};
}
export async function saveClientForecast(db:Queryer,input:{id:string;contractId:string;command:Extract<ClientForecastCommand,{action:'SAVE'}>;
  actor:number;before:ClientContractForecast|null;article:ClientContractArticle}) {
  const {id,contractId,command,actor,before,article}=input;
  if(before)await db.query(`UPDATE public.client_contract_forecasts SET quantity=$3,delivery_due=$4::date,estimate_date=$5::date,
    status='ACTIVE',version=version+1,updated_by=$6,updated_at=now() WHERE id=$1::uuid AND contract_id=$2::uuid`,
  [id,contractId,command.quantity,command.delivery_due,command.estimate_date,actor]);
  else await db.query(`INSERT INTO public.client_contract_forecasts(id,contract_id,contract_line_id,root_article_id,unit_id,
    article_snapshot,month,quantity,delivery_due,estimate_date,created_by,updated_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::jsonb,$7::date,$8,$9::date,$10::date,$11,$11)`,
  [id,contractId,command.contract_line_id,article.root_article_id,article.unit_id,JSON.stringify(article),command.month+'-01',command.quantity,command.delivery_due,command.estimate_date,actor]);
}
export async function cancelClientForecast(db:Queryer,contractId:string,id:string,actor:number) {
  await db.query(`UPDATE public.client_contract_forecasts SET status='CANCELLED',version=version+1,updated_by=$3,updated_at=now()
    WHERE id=$1::uuid AND contract_id=$2::uuid`,[id,contractId,actor]);
}
export async function appendClientForecastEvent(db:Queryer,input:{eventId:string;id:string;contractId:string;actor:number;key:string;hash:string;
  command:ClientForecastCommand;contractVersion:number;before:ClientContractForecast|null;result:ClientForecastResult}) {
  const {eventId,id,contractId,actor,key,hash,command,contractVersion,before,result}=input;
  await db.query(`INSERT INTO public.client_contract_forecast_events(id,forecast_id,contract_id,actor_user_id,idempotency_key,
    request_hash,action,reason,contract_version,previous_snapshot,result_payload)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
  [eventId,id,contractId,actor,key,hash,command.action,command.reason,contractVersion,before?JSON.stringify(before):null,JSON.stringify(result)]);
}
