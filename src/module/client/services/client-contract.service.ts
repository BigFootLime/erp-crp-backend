import { createHash,randomUUID } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { AuditContext } from "../repository/client.repository";
import { readCrmClient } from "../repository/client-crm.repository";
import * as repo from "../repository/client-contract.repository";
import type { ClientContractCommand } from "../validators/client-contract.validators";
import type { ClientContractResult } from "../types/client-contract.types";

async function requireClient(clientId:string) {
  const client=await readCrmClient(pool,clientId);
  if(!client)throw new HttpError(404,"CLIENT_NOT_FOUND","Client introuvable");
  return client;
}
export async function getClientContracts(clientId:string,page:number) {
  const client=await requireClient(clientId);
  return {...await repo.listClientContracts(pool,clientId,page),
    client_active:!client.archived_at&&!client.blocked&&client.status!=="inactif"};
}
export async function getClientContractArticles(clientId:string,q:string) {
  await requireClient(clientId);
  return {items:await repo.readContractArticleOptions(pool,clientId,q)};
}
export async function getClientContract(clientId:string,id:string,page:number) {
  const db=await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const client=await readCrmClient(db,clientId);
    if(!client)throw new HttpError(404,"CLIENT_NOT_FOUND","Client introuvable");
    const contract=await repo.readClientContract(db,clientId,id);
    if(!contract)throw new HttpError(404,"CLIENT_CONTRACT_NOT_FOUND","Contrat introuvable pour ce client");
    const history=await repo.readContractHistory(db,clientId,id,page);
    await db.query("COMMIT");return {contract,history,
      client_active:!client.archived_at&&!client.blocked&&client.status!=="inactif"};
  } catch(error){await db.query("ROLLBACK");throw error;}
  finally {db.release();}
}
export async function executeClientContractCommand(clientId:string,command:ClientContractCommand,key:string,audit:AuditContext) {
  const hash=createHash("sha256").update(JSON.stringify({client_id:clientId,command})).digest("hex");
  try {
    return await withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`client-contract:${audit.user_id}:${key}`]);
      const client=await readCrmClient(tx,clientId,true);
      if(!client)throw new HttpError(404,"CLIENT_NOT_FOUND","Client introuvable");
      const saved=await repo.readContractReplay(tx,audit.user_id,key);
      if(saved) {
        if(saved.request_hash!==hash)throw new HttpError(409,"CLIENT_CONTRACT_IDEMPOTENCY_CONFLICT","Cette tentative correspond à une autre action");
        return {result:saved.result_payload,replayed:true};
      }
      if(client.archived_at||client.blocked||client.status==="inactif")
        throw new HttpError(409,"CLIENT_CONTRACT_CLIENT_INACTIVE","La fiche client est inactive ou bloquée");
      const id=command.action==="CREATE"?randomUUID():command.contract_id;
      const before=command.action==="CREATE"?null:await repo.readClientContract(tx,clientId,id,true);
      if(command.action!=="CREATE") {
        if(!before)throw new HttpError(404,"CLIENT_CONTRACT_NOT_FOUND","Contrat introuvable pour ce client");
        if(before.version!==command.expected_version)
          throw new HttpError(409,"CLIENT_CONTRACT_VERSION_CONFLICT","Le contrat a changé. Actualisez avant d’enregistrer.");
        if(before.status==="CLOSED")throw new HttpError(409,"CLIENT_CONTRACT_CLOSED","Le contrat est clôturé");
      }
      if(command.action==="CLOSE")await repo.closeClientContract(tx,clientId,id,audit.user_id);
      else {
        const roots=await repo.lockContractArticles(tx,command.lines.map(line=>line.article_id));
        const articles=await repo.readContractArticleOptions(tx,clientId,"",roots);
        if(command.lines.some(line=>!articles.some(article=>article.article_id===line.article_id)))
          throw new HttpError(409,"CLIENT_CONTRACT_ARTICLE_UNAVAILABLE","Choisissez les articles validés de ce client à leur indice applicable");
        if(new Set(articles.map(article=>article.root_article_id)).size!==command.lines.length)
          throw new HttpError(422,"CLIENT_CONTRACT_DUPLICATE_FAMILY","Deux lignes désignent la même famille d’article");
        await repo.writeClientContract(tx,clientId,id,audit.user_id,command,articles);
      }
      const contract=await repo.readClientContract(tx,clientId,id);
      if(!contract)throw new Error("CLIENT_CONTRACT_WRITE_NOT_VISIBLE");
      const eventId=randomUUID(),result:ClientContractResult={event_id:eventId,contract};
      await repo.appendContractEvent(tx,{id:eventId,clientId,contractId:id,actor:audit.user_id,key,hash,
        action:command.action,before,result,reason:command.action==="CREATE"?null:command.reason});
      await repoInsertAuditLog({user_id:audit.user_id,tx,ip:audit.ip,user_agent:audit.user_agent,
        device_type:audit.device_type,os:audit.os,browser:audit.browser,
        body:{event_type:"ACTION",action:`CLIENT_CONTRACT_${command.action}`,entity_type:"client",entity_id:clientId,
          page_key:audit.page_key,path:audit.path,client_session_id:audit.client_session_id,
          details:{event_id:eventId,contract_id:id,previous_version:before?.version??null,version:contract.version}}});
      await enqueueEntityChanged(tx,{module:"clients",entityType:"CLIENT",entityId:clientId,action:"updated",
        at:new Date().toISOString(),invalidateKeys:["clients",`client:${clientId}`,"client-contracts"]},
        {deduplicationKey:`client-contract:${eventId}`});
      return {result,replayed:false};
    },{reconcileCommit:async verifier=>{
      const saved=await repo.readContractReplay(verifier,audit.user_id,key);
      return !saved?"not_committed":saved.request_hash===hash?"committed":"unknown";
    }});
  } catch(error) {
    if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="23505"
      &&"constraint" in error&&error.constraint==="client_contract_reference_idx")
      throw new HttpError(409,"CLIENT_CONTRACT_REFERENCE_EXISTS","Cette référence de contrat existe déjà pour le client");
    throw error;
  }
}
