import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { centralCanonicalJson } from "../domain/central-canonical-json";
import type { AuditContext } from "./planning.repository";

export async function withPlanningCommand<T>(audit: AuditContext,key: string,name: string,input: unknown,work: (tx:PoolClient)=>Promise<T>):Promise<T> {
  if (key.length<8 || key.length>160) throw new HttpError(400,"IDEMPOTENCY_KEY_REQUIRED","Une clé d'idempotence de 8 à 160 caractères est nécessaire.");
  const fingerprint=createHash("sha256").update(centralCanonicalJson(input)).digest("hex");
  return withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["planning-command:"+audit.user_id+":"+name+":"+key]);
    const replay=await tx.query<{fingerprint:string;response:T}>(
      "SELECT fingerprint,response FROM public.planning_command_idempotency WHERE actor_id=$1 AND command=$2 AND key=$3",
      [audit.user_id,name,key]);
    if(replay.rows[0]) {
      if(replay.rows[0].fingerprint!==fingerprint) throw new HttpError(409,"IDEMPOTENCY_KEY_REUSED","Cette clé correspond à une autre action.");
      return replay.rows[0].response;
    }
    const response=await work(tx);
    await tx.query("INSERT INTO public.planning_command_idempotency(actor_id,command,key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)",
      [audit.user_id,name,key,fingerprint,JSON.stringify(response)]);
    return response;
  },{reconcileCommit:async verifier=>{
    const r=await verifier.query("SELECT 1 FROM public.planning_command_idempotency WHERE actor_id=$1 AND command=$2 AND key=$3 AND fingerprint=$4",
      [audit.user_id,name,key,fingerprint]);
    return r.rowCount ? "committed" : "not_committed";
  }});
}

