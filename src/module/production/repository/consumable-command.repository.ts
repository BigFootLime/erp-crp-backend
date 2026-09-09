import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { coverageFingerprint } from '../domain/of-material';
import type { AuditContext } from './production.repository';
import { preparationAudit } from './production-preparation.repository';

/** All procurement writers take planning before OF, purchase, lot and stock locks.
 * The response is recorded in the same transaction as the canonical movements. */
export async function consumableCommand<T>(identity:{ofId?:number;articleId?:string},type:string,body:{idempotencyKey:string},audit:AuditContext,action:(tx:PoolClient)=>Promise<T>):Promise<T>{
  return withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    if(identity.ofId)await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE',[identity.ofId]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[body.idempotencyKey]);
    const hash=coverageFingerprint({identity,type,body});
    const replay=(await tx.query('SELECT * FROM public.consumable_commands WHERE idempotency_key=$1::uuid',[body.idempotencyKey])).rows[0];
    if(replay){
      if(replay.request_hash!==hash||replay.actor_id!==audit.user_id)throw new HttpError(409,'IDEMPOTENCY_KEY_REUSED','Cette action a déjà été utilisée avec un autre contenu ou une autre personne.');
      return replay.response as T;
    }
    if(identity.ofId){
      const of=(await tx.query<{status:string}>('SELECT statut::text AS status FROM public.ordres_fabrication WHERE id=$1',[identity.ofId])).rows[0];
      if(!of)throw new HttpError(404,'OF_NOT_FOUND','OF introuvable.');
      if(['TERMINE','CLOTURE','ANNULE'].includes(of.status))throw new HttpError(409,'CONSUMABLE_OF_CLOSED','Cet OF est terminé ou annulé. Ses engagements restent consultables.');
    }
    const response=await action(tx);
    if(identity.ofId)await preparationAudit(tx,audit,identity.ofId,`production.of.consumables.${type.toLowerCase()}`,{request:body});
    await tx.query(`INSERT INTO public.consumable_commands(idempotency_key,actor_id,of_id,article_id,command_type,request_hash,response)
      VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7::jsonb)`,[body.idempotencyKey,audit.user_id,identity.ofId??null,identity.articleId??null,type,hash,JSON.stringify(response)]);
    return response;
  });
}
