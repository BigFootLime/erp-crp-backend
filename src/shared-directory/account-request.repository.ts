import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../utils/httpError';
import type { DirectorySession } from './model';

export type AccountRequestStatus = 'PENDING' | 'PROJECTION_PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type AccountRequestApproval = {
  expected_version: number;
  primary_role: string;
  roles: string[];
  administrative_kind: 'STANDARD' | 'BUSINESS_ADMIN';
  module_keys: string[];
};
type RequestRow = {
  id: string; status: AccountRequestStatus; version: number; name: string; surname: string; email: string;
  password_hash: string | null; avatar_key: string; username_base: string; approved_username: string | null;
  profile_id: string | null; primary_role: string | null; roles: string[] | null;
  administrative_kind: 'STANDARD' | 'BUSINESS_ADMIN' | null; module_keys: string[] | null; expires_at: string;
};
const receiptHash = (receipt: string) => createHash('sha256').update(receipt).digest('hex');
const unique = (items: string[]) => [...new Set(items)].sort();
const mutationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const USERNAME_MAX_LENGTH = 50;

async function event(tx: PoolClient, requestId: string, eventType: string, actorProfileId: string | null, details: Record<string, unknown>) {
  await tx.query("INSERT INTO public.cerp_directory_account_request_events(request_id,event_type,actor_profile_id,details) VALUES($1::uuid,$2,$3::uuid,$4::jsonb)", [requestId, eventType, actorProfileId, JSON.stringify(details)]);
}
async function locked(tx: PoolClient, id: string): Promise<RequestRow> {
  const row = (await tx.query<RequestRow>(`SELECT id::text,status,version,name,surname,email,password_hash,avatar_key,username_base,approved_username,profile_id::text,primary_role,roles,administrative_kind,module_keys,expires_at::text
    FROM public.cerp_directory_account_requests WHERE id=$1::uuid FOR UPDATE`, [id])).rows[0];
  if (!row) throw new HttpError(404, 'ACCOUNT_REQUEST_NOT_FOUND', 'Demande introuvable.');
  if (row.status === 'PENDING' && new Date(row.expires_at).getTime() <= Date.now()) {
    await tx.query("UPDATE public.cerp_directory_account_requests SET status='EXPIRED',password_hash=NULL,reviewed_at=now(),version=version+1 WHERE id=$1::uuid", [id]);
    await event(tx, id, 'EXPIRED', null, {});
    row.status = 'EXPIRED'; row.password_hash = null; row.version += 1;
  }
  return row;
}
function sameApproval(row: RequestRow, input: AccountRequestApproval) {
  return row.primary_role === input.primary_role && JSON.stringify(row.roles ?? []) === JSON.stringify(unique(input.roles))
    && row.administrative_kind === input.administrative_kind && JSON.stringify(row.module_keys ?? []) === JSON.stringify(unique(input.module_keys));
}
async function allocateUsername(tx: PoolClient, base: string) {
  // A single allocation lock covers ALIX and ALIX2 alike. It prevents a
  // prefix collision without relying on a user-controlled SQL regular expression.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('directory-account-request-username-allocation',0))");
  for (let suffix = 1; suffix < 100000; suffix += 1) {
    const postfix = suffix === 1 ? '' : String(suffix);
    const candidate = `${base.slice(0, USERNAME_MAX_LENGTH - postfix.length)}${postfix}`;
    const taken = (await tx.query('SELECT 1 FROM public.users WHERE upper(username)=upper($1) LIMIT 1', [candidate])).rows.length > 0;
    if (!taken) return candidate;
  }
  throw new HttpError(503, 'ACCOUNT_REQUEST_USERNAME_UNAVAILABLE', 'Attribution du nom utilisateur momentanément indisponible.');
}
function uniqueConstraint(error: unknown, fragment: string) {
  const database = error as { code?: unknown; constraint?: unknown };
  return database.code === '23505' && typeof database.constraint === 'string' && database.constraint.toLowerCase().includes(fragment);
}
async function replayMutation<T>(tx: PoolClient, requestId: string, operation: 'APPROVE' | 'REJECT' | 'DELETE', key: string, payloadHash: string): Promise<T | null> {
  const row = (await tx.query<{ payload_hash: string; response: T }>('SELECT payload_hash,response FROM public.cerp_directory_account_request_mutations WHERE request_id=$1::uuid AND operation=$2 AND idempotency_key=$3::uuid FOR UPDATE', [requestId, operation, key])).rows[0];
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw new HttpError(409, 'ACCOUNT_REQUEST_IDEMPOTENCY_CONFLICT', 'Cette clé d’idempotence a déjà été utilisée avec une autre décision.');
  return row.response;
}
async function saveMutation(tx: PoolClient, requestId: string, operation: 'APPROVE' | 'REJECT' | 'DELETE', key: string, payloadHash: string, response: unknown) {
  await tx.query('INSERT INTO public.cerp_directory_account_request_mutations(request_id,operation,idempotency_key,payload_hash,response) VALUES($1::uuid,$2,$3::uuid,$4,$5::jsonb)', [requestId, operation, key, payloadHash, JSON.stringify(response)]);
}

export async function submitDirectoryAccountRequest(db: Pool, input: { name: string; surname: string; email: string; password: string; avatar_key: string; username_base: string }) {
  const receipt = randomBytes(32).toString('base64url');
  const tx = await db.connect(); await tx.query('BEGIN');
  try {
    const id = randomUUID();
    await tx.query(`INSERT INTO public.cerp_directory_account_requests(id,receipt_hash,status,name,surname,email,password_hash,avatar_key,username_base)
      VALUES($1::uuid,$2,'PENDING',$3,$4,$5,$6,$7,$8)`, [id, receiptHash(receipt), input.name, input.surname, input.email, await bcrypt.hash(input.password, 12), input.avatar_key, input.username_base]);
    await event(tx, id, 'SUBMITTED', null, {});
    await tx.query('COMMIT');
    return { request_id: id, status: 'PENDING' as const, receipt };
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function statusDirectoryAccountRequest(db: Pool, receipt: string) {
  await expireDirectoryAccountRequests(db, 25);
  const row = (await db.query<Pick<RequestRow, 'status' | 'approved_username'>>(`SELECT CASE WHEN status='PENDING' AND expires_at<=now() THEN 'EXPIRED' ELSE status END AS status,approved_username
    FROM public.cerp_directory_account_requests WHERE receipt_hash=$1`, [receiptHash(receipt)])).rows[0];
  if (!row) throw new HttpError(404, 'ACCOUNT_REQUEST_NOT_FOUND', 'Demande introuvable.');
  const status = row.status === 'APPROVED' ? 'APPROVED' : row.status === 'REJECTED' ? 'REJECTED' : row.status === 'EXPIRED' ? 'EXPIRED' : 'PENDING';
  return { status, ...(status === 'APPROVED' && row.approved_username ? { username: row.approved_username } : {}) };
}
export async function expireDirectoryAccountRequests(db: Pool, limit = 100) {
  const tx = await db.connect(); await tx.query('BEGIN');
  try {
    const rows = (await tx.query<{ id: string; status: AccountRequestStatus }>(`SELECT id::text,status FROM public.cerp_directory_account_requests
      WHERE redacted_at IS NULL AND ((status='PENDING' AND expires_at<=now()) OR (status IN ('APPROVED','REJECTED','EXPIRED') AND coalesce(reviewed_at,created_at)<=now()-interval '30 days'))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])).rows;
    for (const row of rows) {
      await tx.query(`UPDATE public.cerp_directory_account_requests SET status=CASE WHEN status='PENDING' THEN 'EXPIRED' ELSE status END,password_hash=NULL,name='SUPPRIME',surname='SUPPRIME',email=('redacted-' || id::text || '@identity.cerp.invalid'),avatar_key='default',username_base='REDACTED',rejection_reason=NULL,receipt_hash=$2,reviewed_at=coalesce(reviewed_at,now()),redacted_at=now(),version=version+1 WHERE id=$1::uuid`, [row.id, receiptHash(randomBytes(32).toString('base64url'))]);
      await event(tx, row.id, row.status === 'PENDING' ? 'EXPIRED' : 'REDACTED', null, { redacted: true });
    }
    await tx.query('COMMIT'); return rows.length;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function listDirectoryAccountRequests(db: Pool, status: AccountRequestStatus, limit: number, cursor?: string) {
  const requests = (await db.query(`SELECT id::text,status,version,name,surname,email,avatar_key,created_at::text,expires_at::text,
    primary_role,roles,administrative_kind,module_keys FROM public.cerp_directory_account_requests
    WHERE status=$1 AND redacted_at IS NULL AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`, [status, cursor ?? null, limit])).rows;
  return { requests, next_cursor: requests.length === limit ? requests.at(-1)?.id ?? null : null };
}
export async function approveDirectoryAccountRequest(db: Pool, actor: DirectorySession, id: string, input: AccountRequestApproval, idempotencyKey: string) {
  const tx = await db.connect(); await tx.query('BEGIN');
  try {
    const payloadHash = mutationHash({ expected_version: input.expected_version, primary_role: input.primary_role, roles: unique(input.roles), administrative_kind: input.administrative_kind, module_keys: unique(input.module_keys) });
    // Lock the request before consulting the idempotency record: a successful
    // activation may have happened since the original PREPARED response.
    const row = await locked(tx, id);
    const replay = await replayMutation<ReturnType<typeof preparedApproval>>(tx, id, 'APPROVE', idempotencyKey, payloadHash);
    if (replay) {
      // A replay must report the current terminal state. Returning the saved
      // PROJECTION_PENDING response here would make the site apply its former
      // closed module selection again and overwrite later access decisions.
      if (row.status === 'APPROVED') { const result = preparedApproval(row); await tx.query('COMMIT'); return result; }
      await tx.query('COMMIT'); return replay;
    }
    if (row.status === 'PROJECTION_PENDING' || row.status === 'APPROVED') {
      if (!sameApproval(row, input)) throw new HttpError(409, 'ACCOUNT_REQUEST_DECISION_CONFLICT', 'La demande a déjà reçu une décision différente.');
      const result = preparedApproval(row);
      await saveMutation(tx, id, 'APPROVE', idempotencyKey, payloadHash, result); await tx.query('COMMIT'); return result;
    }
    if (row.status !== 'PENDING' || row.password_hash === null || row.version !== input.expected_version) throw new HttpError(409, 'ACCOUNT_REQUEST_VERSION_CONFLICT', 'La demande a été modifiée.');
    const roles = unique(input.roles), modules = unique(input.module_keys);
    let username = '', user: { id: number } | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      username = await allocateUsername(tx, row.username_base);
      await tx.query('SAVEPOINT directory_account_request_user_insert');
      try {
        user = (await tx.query<{ id: number }>(`INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin,mfa_reenrollment_required,mfa_required,avatar_key,country)
          VALUES($1,$2,$3,$4,$5,$6,'Active',false,$7,$7,$8,'France') RETURNING id`, [username, row.password_hash, row.name.toLocaleUpperCase('fr-FR'), row.surname.toLocaleUpperCase('fr-FR'), row.email, input.primary_role, input.administrative_kind === 'BUSINESS_ADMIN', row.avatar_key])).rows[0];
        await tx.query('RELEASE SAVEPOINT directory_account_request_user_insert');
        break;
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT directory_account_request_user_insert');
        if (uniqueConstraint(error, 'username') && attempt < 4) continue;
        if (uniqueConstraint(error, 'email')) throw new HttpError(409, 'ACCOUNT_REQUEST_EMAIL_CONFLICT', 'Cette adresse ne peut plus être approuvée.');
        throw error;
      }
    }
    if (!user) throw new HttpError(503, 'ACCOUNT_REQUEST_USERNAME_UNAVAILABLE', 'Attribution du nom utilisateur momentanément indisponible.');
    for (const role of roles) await tx.query('INSERT INTO public.user_role_assignments(user_id,role_key) VALUES($1,$2)', [user.id, role]);
    const profileId = randomUUID();
    await tx.query('INSERT INTO public.cerp_directory_profiles(profile_id,user_id,work_profile_incomplete) VALUES($1::uuid,$2,true)', [profileId, user.id]);
    await tx.query(`INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin)
      VALUES($1::uuid,$2,$3,$4::text[],'Inactive',false)`, [profileId, actor.database, input.primary_role, roles]);
    await tx.query(`UPDATE public.cerp_directory_account_requests SET status='PROJECTION_PENDING',version=version+1,password_hash=NULL,approved_username=$2,profile_id=$3::uuid,primary_role=$4,roles=$5::text[],administrative_kind=$6,module_keys=$7::text[],reviewed_by_profile_id=$8::uuid,reviewed_at=now() WHERE id=$1::uuid`, [id, username, profileId, input.primary_role, roles, input.administrative_kind, modules, actor.profile_id]);
    await event(tx, id, 'APPROVAL_PREPARED', actor.profile_id, { profile_id: profileId, administrative_kind: input.administrative_kind });
    const next = await locked(tx, id), result = preparedApproval(next);
    await saveMutation(tx, id, 'APPROVE', idempotencyKey, payloadHash, result); await tx.query('COMMIT'); return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function activateDirectoryAccountRequest(db: Pool, actor: DirectorySession, input: { id: string; expected_version: number; profile_id: string }) {
  const tx = await db.connect(); await tx.query('BEGIN');
  try {
    const row = await locked(tx, input.id);
    if (row.status === 'APPROVED') { if (row.profile_id !== input.profile_id) throw new HttpError(409, 'ACCOUNT_REQUEST_PROJECTION_CONFLICT', 'Projection incohérente.'); await tx.query('COMMIT'); return { request_id: row.id, status: 'APPROVED' as const, username: row.approved_username! }; }
    if (row.status !== 'PROJECTION_PENDING' || row.profile_id !== input.profile_id || row.version !== input.expected_version) throw new HttpError(409, 'ACCOUNT_REQUEST_PROJECTION_CONFLICT', 'La projection doit être reprise avant activation.');
    const membership = await tx.query("UPDATE public.cerp_directory_memberships SET status='Active',version=version+1 WHERE profile_id=$1::uuid AND database_id=$2 AND status='Inactive'", [row.profile_id, actor.database]);
    if (membership.rowCount !== 1) throw new HttpError(409, 'ACCOUNT_REQUEST_MEMBERSHIP_CONFLICT', 'L’adhésion ne peut pas être activée.');
    await tx.query("UPDATE public.cerp_directory_account_requests SET status='APPROVED',version=version+1 WHERE id=$1::uuid", [row.id]);
    await event(tx, row.id, 'ACTIVATED', actor.profile_id, { profile_id: row.profile_id });
    await tx.query('COMMIT'); return { request_id: row.id, status: 'APPROVED' as const, username: row.approved_username! };
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function rejectDirectoryAccountRequest(db: Pool, actor: DirectorySession, input: { id: string; expected_version: number; reason?: string; key: string }) {
  const tx = await db.connect(); await tx.query('BEGIN');
  try {
    const payloadHash = mutationHash({ expected_version: input.expected_version, reason: input.reason ?? null });
    const replay = await replayMutation<{ request_id: string; status: 'REJECTED' }>(tx, input.id, 'REJECT', input.key, payloadHash);
    if (replay) { await tx.query('COMMIT'); return replay; }
    const row = await locked(tx, input.id);
    if (row.status !== 'PENDING' || row.version !== input.expected_version) throw new HttpError(409, 'ACCOUNT_REQUEST_VERSION_CONFLICT', 'La demande a été modifiée.');
    await tx.query("UPDATE public.cerp_directory_account_requests SET status='REJECTED',version=version+1,password_hash=NULL,rejection_reason=$2,reviewed_by_profile_id=$3::uuid,reviewed_at=now() WHERE id=$1::uuid", [row.id, input.reason ?? null, actor.profile_id]);
    const result = { request_id: row.id, status: 'REJECTED' as const };
    await event(tx, row.id, 'REJECTED', actor.profile_id, {}); await saveMutation(tx, row.id, 'REJECT', input.key, payloadHash, result); await tx.query('COMMIT'); return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function deleteDirectoryAccountRequest(db: Pool, actor: DirectorySession, input: { id: string; expected_version: number; key: string }) {
  const tx = await db.connect(); await tx.query('BEGIN');
  try {
    const payloadHash = mutationHash({ expected_version: input.expected_version });
    const replay = await replayMutation<{ deleted: true }>(tx, input.id, 'DELETE', input.key, payloadHash);
    if (replay) { await tx.query('COMMIT'); return replay; }
    const row = await locked(tx, input.id);
    if (!['REJECTED', 'EXPIRED'].includes(row.status) || row.version !== input.expected_version) throw new HttpError(409, 'ACCOUNT_REQUEST_DELETE_CONFLICT', 'Seule une demande terminale peut être supprimée.');
    const redactedEmail = `deleted-${row.id}@identity.cerp.invalid`;
    await tx.query(`UPDATE public.cerp_directory_account_requests SET password_hash=NULL,name='SUPPRIME',surname='SUPPRIME',email=$2,avatar_key='default',username_base='REDACTED',rejection_reason=NULL,receipt_hash=$3,redacted_at=now(),version=version+1 WHERE id=$1::uuid`, [row.id, redactedEmail, receiptHash(randomBytes(32).toString('base64url'))]);
    const result = { deleted: true as const };
    await event(tx, row.id, 'REDACTED', actor.profile_id, { redacted: true }); await saveMutation(tx, row.id, 'DELETE', input.key, payloadHash, result);
    await tx.query('COMMIT'); return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

function preparedApproval(row: RequestRow) {
  return { request_id: row.id, status: row.status, version: row.version, profile_id: row.profile_id!, username: row.approved_username!, roles: row.roles!, module_keys: row.module_keys! };
}
