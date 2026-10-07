import type { PoolClient } from "pg";
export async function isAccountRecoveryEnabled(tx: PoolClient): Promise<boolean> {
    const result = await tx.query<{ enabled: boolean }>(`SELECT value_text='true' AS enabled
      FROM public.erp_settings WHERE key='security.account_recovery_enabled' FOR SHARE`);
    return result.rows[0]?.enabled === true;
}
export type RecoveryRow = {
    id: string;
    user_id: number;
    actor_user_id: number;
    request_hash: string;
    reset_id: string;
    token_hash: string;
    created_at: Date;
    expires_at: Date;
    superseded_at: Date | null;
    completed_at: Date | null;
    reset_usable: boolean;
};
export async function lockRecoveryAccounts(tx: PoolClient, actorId: number, userId: number, key: string) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`account-recovery:${actorId}:${key}`]);
    await tx.query(`SELECT id FROM public.users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`, [[actorId, userId]]);
    // A separate statement observes changes committed while waiting for the user
    // locks, including factor revocation and the durable session epoch.
    return (await tx.query<{
        id: number;
        status: string;
        is_superadmin: boolean;
        session_epoch: number;
        factor_id: string | null;
        factor_version: number | null;
    }>(`SELECT u.id,u.status,u.is_superadmin,COALESCE(e.session_epoch,0)::int AS session_epoch,
             f.id::text AS factor_id,f.version AS factor_version
        FROM public.users u LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id
        LEFT JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.state='ACTIVE'
       WHERE u.id=ANY($1::int[])`, [[actorId, userId]])).rows;
}
export async function findRecoveryReplay(tx: PoolClient, actorId: number, key: string) {
    return (await tx.query<RecoveryRow>(`SELECT r.*,EXISTS(SELECT 1 FROM public.password_resets p WHERE p.id=r.reset_id
        AND p.token_hash=r.token_hash AND NOT p.used AND p.expires_at>now()) AS reset_usable
       FROM public.admin_account_recoveries r WHERE r.actor_user_id=$1 AND r.idempotency_key=$2::uuid FOR UPDATE OF r`, [actorId, key])).rows[0] ?? null;
}
export async function invalidateAccountRecoveryCredentials(tx: PoolClient, userId: number, actorId: number) {
    await tx.query(`UPDATE public.admin_account_recoveries SET superseded_at=now() WHERE user_id=$1 AND superseded_at IS NULL AND completed_at IS NULL`, [userId]);
    await tx.query(`UPDATE public.password_resets SET used=true WHERE user_id=$1 AND NOT used`, [userId]);
    await tx.query(`UPDATE public.password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    const factors = await tx.query(`UPDATE public.user_mfa_factors SET state='REVOKED',revoked_at=now(),updated_at=now()
    WHERE user_id=$1 AND state IN ('ACTIVE','PENDING') RETURNING id`, [userId]);
    await tx.query(`UPDATE public.user_mfa_recovery_codes SET used_at=now() WHERE used_at IS NULL
    AND factor_id IN (SELECT id FROM public.user_mfa_factors WHERE user_id=$1)`, [userId]);
    await tx.query(`UPDATE public.auth_mfa_challenges SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    await tx.query(`UPDATE public.users SET mfa_reenrollment_required=true WHERE id=$1`, [userId]);
    // Account locks are held before any credential or station lock. Revoked
    // credentials stay in the history; recovery never stops a running pointage.
    const pins = await tx.query(`UPDATE public.cerp_terminal_pins SET revoked_at=now()
    WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
    const badges = await tx.query(`UPDATE public.operator_badge_credentials
    SET active=false,revoked_at=now(),revoked_by=$2,revoke_reason='ADMIN_ACCOUNT_RECOVERY'
    WHERE user_id=$1 AND active AND revoked_at IS NULL`, [userId, actorId]);
    const sessions = await tx.query(`UPDATE public.operator_device_sessions
    SET state='REVOKED',closed_at=now(),close_reason='ADMIN_ACCOUNT_RECOVERY'
    WHERE user_id=$1 AND state IN ('ACTIVE','LOCKED')`, [userId]);
    await tx.query(`INSERT INTO public.cerp_terminal_audit(terminal_id,actor_id,event,detail)
    VALUES(NULL,$2,'ACCOUNT_RECOVERY_CREDENTIALS_REVOKED',jsonb_build_object(
      'subject_user_id',$1::int,'pins',$3::int,'badges',$4::int,'station_sessions',$5::int))`, [userId, actorId, pins.rowCount ?? 0, badges.rowCount ?? 0, sessions.rowCount ?? 0]);
    return { factors: factors.rowCount ?? 0, pins: pins.rowCount ?? 0,
        badges: badges.rowCount ?? 0, stationSessions: sessions.rowCount ?? 0 };
}
export async function insertAccountRecovery(tx: PoolClient, row: {
    id: string;
    user_id: number;
    actor_user_id: number;
    idempotency_key: string;
    request_hash: string;
    reason: string;
    reset_id: string;
    token_hash: string;
    created_at: Date;
    expires_at: Date;
}): Promise<RecoveryRow> {
    const result = await tx.query<RecoveryRow>(`INSERT INTO public.admin_account_recoveries(id,user_id,actor_user_id,idempotency_key,request_hash,reason,reset_id,token_hash,created_at,expires_at)
     VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7::uuid,$8,$9,$10) RETURNING *,true AS reset_usable`, [row.id, row.user_id, row.actor_user_id, row.idempotency_key, row.request_hash, row.reason, row.reset_id, row.token_hash, row.created_at, row.expires_at]);
    return result.rows[0]!;
}
export async function findRecoveryCommitHash(tx: PoolClient, id: string): Promise<string | null> {
    const result = await tx.query<{
        request_hash: string;
    }>(`SELECT request_hash FROM public.admin_account_recoveries WHERE id=$1::uuid`, [id]);
    return result.rows[0]?.request_hash ?? null;
}
