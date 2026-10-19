import path from "node:path";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { retiredAccountPredicate } from "../domain/account-retirement";
import { ensureImagesSubdir, getImagesRootPath } from "../../../utils/imageStorage";
import { promoteSecureUpload } from "../../../shared/uploads/secure-upload";
import { withUploadTransaction } from "../../../shared/uploads/upload-transaction";
import { promoteOperationalImage } from "../../operational-media/services/operational-media-promotion.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { MfaAuditMeta } from "../services/mfa.service";

export type AvatarReference = { asset_id: string; status: "AVAILABLE" };
// Current image + exactly one business binding. Neither a path nor the filename
// is ever projected into a session or an HTTP response.
export const avatarProjectionSql = `(SELECT a.id::text FROM public.operational_media_assets a
  JOIN public.operational_media_bindings b ON b.asset_id=a.id
  WHERE a.storage_key=u.profile_picture AND a.status='ACTIVE' AND a.scan_status='CLEAN'
    AND a.mime_type IN ('image/png','image/jpeg','image/webp','image/gif')
    AND a.sha256 IS NOT NULL AND a.size_bytes IS NOT NULL
    AND b.owner_type='user' AND b.owner_id=u.id::text AND b.module_key='chat'
    AND (SELECT count(*) FROM public.operational_media_bindings other WHERE other.asset_id=a.id)=1)`;

export async function readUserAvatar(userId: number, q: Pick<PoolClient,"query"> = pool) {
  const { rows } = await q.query<{ avatar_key: string|null; profile_picture_asset_id: string|null }>(
    `SELECT u.avatar_key, ${avatarProjectionSql} AS profile_picture_asset_id FROM public.users u WHERE u.id=$1`, [userId]);
  const row=rows[0];
  return row ? {avatar_key:row.avatar_key,profile_picture_asset:row.profile_picture_asset_id ? {asset_id:row.profile_picture_asset_id,status:"AVAILABLE" as const}:null} : null;
}

export async function uploadUserAvatar(input: {userId:number;actorId:number;key:string;file:Express.Multer.File;meta:MfaAuditMeta}) {
  const digest=input.file.uploadSecurity?.sha256;
  if(input.file.uploadSecurity?.scanStatus!=="clean" || !digest) throw new HttpError(503,"OPERATIONAL_MEDIA_NOT_READY","L’image doit être vérifiée avant son enregistrement.");
  const client=await pool.connect();
  return withUploadTransaction({client,files:[input.file],context:"auth.user.avatar",work:async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`user-avatar:${input.key}`]);
    const prior=await tx.query<{actor_id:number;user_id:number;sha256:string;asset_id:string}>(
      "SELECT actor_id,user_id,sha256,asset_id::text FROM public.user_avatar_commands WHERE idempotency_key=$1::uuid",[input.key]);
    if(prior.rows[0]) {
      const row=prior.rows[0];
      if(row.actor_id!==input.actorId || row.user_id!==input.userId || row.sha256!==digest) throw new HttpError(409,"AVATAR_KEY_REUSED","Cette demande concerne une autre image.");
      const current=await readUserAvatar(input.userId,tx);
      if(current?.profile_picture_asset?.asset_id!==row.asset_id) throw new HttpError(409,"AVATAR_REPLACED","Une autre image a été enregistrée depuis. Rechargez le profil.");
      return {profile_picture_asset:current.profile_picture_asset,replayed:true};
    }
    const target=await tx.query(`SELECT id FROM public.users WHERE id=$1 AND ${retiredAccountPredicate("users")} FOR UPDATE`,[input.userId]);
    if(!target.rows[0]) throw new HttpError(404,"USER_NOT_FOUND","Utilisateur introuvable.");
    const durable=await promoteSecureUpload(input.file,ensureImagesSubdir("avatars"));
    const key=path.relative(getImagesRootPath(),durable).split(path.sep).join("/");
    // The existing users trigger registers the new key and detaches the previous
    // binding. Old bytes are left to the established retention process.
    await tx.query("UPDATE public.users SET profile_picture=$2 WHERE id=$1",[input.userId,key]);
    const promoted=await promoteOperationalImage({tx,storedPath:key,file:input.file});
    if(!promoted.activated) throw new HttpError(503,"OPERATIONAL_MEDIA_NOT_READY","L’image sécurisée n’a pas pu être activée.");
    await tx.query("INSERT INTO public.user_avatar_commands(idempotency_key,actor_id,user_id,sha256,asset_id) VALUES($1::uuid,$2,$3,$4,$5::uuid)",[input.key,input.actorId,input.userId,digest,promoted.asset_id]);
    await repoInsertAuditLog({user_id:input.actorId,body:{event_type:"ACTION",action:"AUTH_USER_AVATAR_UPDATED",page_key:"auth",entity_type:"user",entity_id:String(input.userId),path:input.meta.path,details:{asset_id:promoted.asset_id}},...input.meta,tx:tx as PoolClient});
    return {profile_picture_asset:{asset_id:promoted.asset_id,status:"AVAILABLE" as const},replayed:false};
  },reconcile:async result=>{
    const row=(await pool.query<{asset_id:string}>("SELECT asset_id::text FROM public.user_avatar_commands WHERE idempotency_key=$1::uuid AND actor_id=$2 AND user_id=$3 AND sha256=$4",[input.key,input.actorId,input.userId,digest])).rows[0];
    return !row ? "not-committed" : row.asset_id===result.profile_picture_asset.asset_id ? "committed" : "uncertain";
  }});
}
