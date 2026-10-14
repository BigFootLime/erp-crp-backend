import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { bumpRealtimeAuthorizationEpoch, bumpRealtimeSessionEpoch } from "../../../shared/realtime/realtime-control-plane";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { TestRegistration } from "../validators/test-registration.validator";
import type { MfaAuditMeta } from "../services/mfa.service";
import { createEmployeeWorkProfile } from './work-profile.repository';

export async function registrationEnabled(q: Pick<PoolClient, "query"> = pool) {
  if (process.env.CERP_TEST_REGISTRATION_ENABLED !== "true") return false;
  const { rows } = await q.query<{ database: string }>("SELECT current_database() AS database");
  return rows[0]?.database === "cerp_test";
}
export async function registerTestAccount(input: TestRegistration, passwordHash: string, key: string, requestHash: string, meta: MfaAuditMeta) {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async tx => {
    // The connected pool, never an HTTP header or a URL, decides the privilege boundary.
    if (!await registrationEnabled(tx)) throw new HttpError(403, "TEST_REGISTRATION_DISABLED", "La création de compte est fermée sur cet environnement.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`test-registration:${key}`]);
    const existing = await tx.query<{ user_id: number; request_hash: string }>("SELECT user_id, request_hash FROM public.test_account_registrations WHERE idempotency_key=$1::uuid", [key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new HttpError(409, "REGISTRATION_KEY_REUSED", "Cette demande concerne d’autres informations. Recommencez la création.");
      return { userId: existing.rows[0].user_id, replayed: true, key, requestHash };
    }
    const { rows } = await tx.query<{ id: number }>(`INSERT INTO public.users
      (username,password,name,surname,email,role,status,is_superadmin,mfa_reenrollment_required,avatar_key,country)
      VALUES ($1,$2,$3,$4,$5,'Administrateur Systeme et Reseau','Active',true,true,$6,'France') RETURNING id`,
    [input.username,passwordHash,input.name,input.surname,input.email,input.avatar_key]);
    const userId = rows[0].id;
    await tx.query("INSERT INTO public.user_role_assignments(user_id,role_key) VALUES ($1,'Administrateur Systeme et Reseau') ON CONFLICT DO NOTHING", [userId]);
    await createEmployeeWorkProfile(tx,userId,input,`TEST-${userId}`);
    await tx.query("INSERT INTO public.test_account_registrations(idempotency_key,request_hash,user_id) VALUES($1::uuid,$2,$3)", [key,requestHash,userId]);
    await bumpRealtimeSessionEpoch(tx,userId);
    await bumpRealtimeAuthorizationEpoch(tx);
    await repoInsertAuditLog({user_id:userId,body:{event_type:"ACTION",action:"AUTH_TEST_ACCOUNT_CREATED",page_key:"auth",entity_type:"user",entity_id:String(userId),path:meta.path,
      details:{test_only:true,role:"superAdmin",hr_contract_created:true}},ip:meta.ip,user_agent:meta.user_agent,device_type:meta.device_type,os:meta.os,browser:meta.browser,tx});
    return { userId, replayed:false, key, requestHash };
  }, {reconcileCommit:async (verifier, mutation) => {
    const { rows }=await verifier.query<{user_id:number;request_hash:string}>("SELECT user_id,request_hash FROM public.test_account_registrations WHERE idempotency_key=$1::uuid",[mutation.key]);
    return !rows[0] ? "not_committed" : rows[0].user_id === mutation.userId && rows[0].request_hash === mutation.requestHash ? "committed" : "unknown";
  }});
}
