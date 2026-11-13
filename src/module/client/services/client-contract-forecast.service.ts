import {createHash,randomUUID} from 'node:crypto';
import pool from '../../../config/database';
import {HttpError} from '../../../utils/httpError';
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {enqueueEntityChanged} from '../../../shared/realtime/realtime-outbox.service';
import {repoInsertAuditLog} from '../../audit-logs/repository/audit-logs.repository';
import {readCrmClient} from '../repository/client-crm.repository';
import {readClientContract,lockContractArticles,readContractArticleOptions} from '../repository/client-contract.repository';
import * as repo from '../repository/client-contract-forecast.repository';
import type {AuditContext} from '../repository/client.repository';
import type {ClientForecastCommand,ClientForecastQuery} from '../validators/client-contract-forecast.validators';
import type {ClientForecastResult} from '../types/client-contract-forecast.types';

export async function getClientForecasts(clientId:string,contractId:string,query:ClientForecastQuery,forecastId?:string) {
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const client=await readCrmClient(tx,clientId);
    if(!client)throw new HttpError(404,'CLIENT_NOT_FOUND','Client introuvable');
    const contract=await readClientContract(tx,clientId,contractId);
    if(!contract)throw new HttpError(404,'CLIENT_CONTRACT_NOT_FOUND','Contrat introuvable pour ce client');
    const clientActive=!client.archived_at&&!client.blocked&&client.status!=='inactif';
    if(forecastId) {
      const forecast=await repo.readClientForecast(tx,contractId,forecastId);
      if(!forecast)throw new HttpError(404,'CLIENT_FORECAST_NOT_FOUND','Estimation introuvable');
      const history=await repo.readClientForecastHistory(tx,forecastId,query.page);
      const conversions=await repo.readClientForecastConversions(tx,forecastId,query.page);
      await tx.query('COMMIT');return {forecast,history,conversions};
    }
    const data=await repo.listClientForecasts(tx,contractId,query);
    await tx.query('COMMIT');return {...data,client_active:clientActive,contract_active:contract.status==='ACTIVE'};
  } catch(error){await tx.query('ROLLBACK');throw error;}
  finally{tx.release();}
}

export async function executeClientForecastCommand(clientId:string,contractId:string,command:ClientForecastCommand,key:string,audit:AuditContext) {
  const hash=createHash('sha256').update(JSON.stringify({client_id:clientId,contract_id:contractId,command})).digest('hex');
  return withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`client-forecast:${audit.user_id}:${key}`]);
    const client=await readCrmClient(tx,clientId,true);
    if(!client)throw new HttpError(404,'CLIENT_NOT_FOUND','Client introuvable');
    const replay=await repo.readClientForecastReplay(tx,audit.user_id,key);
    if(replay) {
      if(replay.request_hash!==hash)throw new HttpError(409,'CLIENT_FORECAST_KEY_CONFLICT','Cette tentative correspond à une autre estimation');
      return {result:replay.result_payload,replayed:true};
    }
    if(client.archived_at||client.blocked||client.status==='inactif')throw new HttpError(409,'CLIENT_FORECAST_CLIENT_INACTIVE','Le client est inactif ou bloqué');
    const contract=await readClientContract(tx,clientId,contractId,true);
    if(!contract)throw new HttpError(404,'CLIENT_CONTRACT_NOT_FOUND','Contrat introuvable pour ce client');
    if(contract.version!==command.expected_contract_version)throw new HttpError(409,'CLIENT_FORECAST_CONTRACT_CHANGED','Le contrat a changé. Actualisez la fiche.');
    if(contract.status!=='ACTIVE')throw new HttpError(409,'CLIENT_FORECAST_CONTRACT_INACTIVE','Le contrat doit être actif');
    const before=await repo.lockClientForecast(tx,contractId,command);
    if((before?.version??null)!==command.expected_version)throw new HttpError(409,'CLIENT_FORECAST_VERSION_CONFLICT','L’estimation a changé. Actualisez avant de l’enregistrer.');
    if(command.action==='CANCEL'&&(!before||before.status==='CANCELLED'))throw new HttpError(409,'CLIENT_FORECAST_NOT_ACTIVE','Cette estimation n’est plus active');
    const id=before?.id??randomUUID();
    if(command.action==='SAVE') {
      if(before&&Math.round(command.quantity*1000)<Math.round(Number(before.converted_quantity)*1000))
        throw new HttpError(409,'CLIENT_FORECAST_CONVERTED_QUANTITY_RETAINED','L’estimation ne peut pas descendre sous sa quantité déjà convertie en commandes fermes',{field:'quantity'});
      const line=contract.lines.find(item=>item.id===command.contract_line_id);
      if(!line?.proposed_article)throw new HttpError(409,'CLIENT_FORECAST_ARTICLE_UNAVAILABLE','Choisissez un article validé du contrat');
      if((contract.valid_from&&command.delivery_due<contract.valid_from)||(contract.valid_until&&command.delivery_due>contract.valid_until))
        throw new HttpError(422,'CLIENT_FORECAST_DATE_OUTSIDE_CONTRACT','L’échéance doit être comprise dans la période du contrat',{field:'delivery_due'});
      await lockContractArticles(tx,[line.proposed_article.article_id]);
      const available=(await readContractArticleOptions(tx,clientId,'',[line.root_article_id])).find(item=>item.article_id===line.proposed_article!.article_id);
      if(!available||available.unit_id!==line.unit_id)throw new HttpError(409,'CLIENT_FORECAST_ARTICLE_CHANGED','L’article du contrat a changé. Actualisez.');
      await repo.saveClientForecast(tx,{id,contractId,command,actor:audit.user_id,before,article:available});
    } else await repo.cancelClientForecast(tx,contractId,id,audit.user_id);
    const forecast=await repo.readClientForecast(tx,contractId,id);
    if(!forecast)throw new Error('CLIENT_FORECAST_WRITE_NOT_VISIBLE');
    const eventId=randomUUID(),result:ClientForecastResult={event_id:eventId,forecast};
    await repo.appendClientForecastEvent(tx,{eventId,id,contractId,actor:audit.user_id,key,hash,command,contractVersion:contract.version,before,result});
    await repoInsertAuditLog({tx,user_id:audit.user_id,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,os:audit.os,browser:audit.browser,
      body:{event_type:'ACTION',action:`CLIENT_FORECAST_${command.action}`,entity_type:'client',entity_id:clientId,
        page_key:'clients.contracts.forecasts',path:audit.path,client_session_id:audit.client_session_id,
        details:{event_id:eventId,forecast_id:id,contract_id:contractId,version:forecast.version}}});
    await enqueueEntityChanged(tx,{module:'clients',entityType:'CLIENT',entityId:clientId,action:'updated',at:new Date().toISOString(),
      invalidateKeys:[`client:${clientId}`,'client-contract-forecasts']},{deduplicationKey:`client-forecast:${eventId}`});
    return {result,replayed:false};
  },{reconcileCommit:async verifier=>{
    const saved=await repo.readClientForecastReplay(verifier,audit.user_id,key);
    return !saved?'not_committed':saved.request_hash===hash?'committed':'unknown';
  }});
}
