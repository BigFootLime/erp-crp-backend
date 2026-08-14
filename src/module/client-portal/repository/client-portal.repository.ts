import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type {
  ClientPortalAuditActor,
  ClientPortalDocumentState,
  ClientPortalIdentity,
  ClientPortalRequestMeta,
} from "../types/client-portal.types";

type Db = Pick<PoolClient, "query">;
type JsonObject = Record<string, unknown>;

export type PortalAccountRow = Readonly<{
  id: string;
  client_id: string;
  company_name: string;
  email: string;
  email_normalized: string;
  display_name: string;
  password_hash: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  session_epoch: number;
  activated_at: string | null;
  last_login_at: string | null;
  created_at: string;
}>;

export type PortalDocumentRow = Readonly<{
  id: string;
  client_id: string;
  version_id: string;
  document_id: string;
  code: string;
  title: string;
  version_number: number;
  version_status: string;
  current_version_id: string | null;
  document_archived_at: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key?: string;
  scan_status: string | null;
  quarantine_status: string | null;
  scanned_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  acknowledgement_required: boolean;
  acknowledged_at: string | null;
  published_at: string;
}>;

async function withTransaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function pgCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

export async function repoInsertPortalAudit(
  db: Db,
  input: {
    actor: ClientPortalAuditActor;
    action: string;
    entityType: string;
    entityId: string;
    clientId: string | null;
    meta: ClientPortalRequestMeta;
    details?: JsonObject;
  }
): Promise<void> {
  const erpActorId = input.actor.kind === "ERP_USER" ? input.actor.id : null;
  const portalAccountId = input.actor.kind === "PORTAL_ACCOUNT" ? input.actor.id : null;
  await db.query(
    `INSERT INTO public.client_portal_audit_events (
       erp_actor_id, portal_account_id, action, entity_type, entity_id,
       client_id, request_id, ip_hash, user_agent_family, details
     ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      erpActorId,
      portalAccountId,
      input.action,
      input.entityType,
      input.entityId,
      input.clientId,
      input.meta.requestId,
      input.meta.ipHash,
      input.meta.userAgentFamily,
      JSON.stringify(input.details ?? {}),
    ]
  );
}

async function readReceipt(
  tx: Db,
  actorId: number,
  action: string,
  idempotencyKey: string,
  requestHash: string
): Promise<JsonObject | null> {
  const result = await tx.query<{ request_sha256: string; result: JsonObject }>(
    `SELECT request_sha256, result
       FROM public.client_portal_command_receipts
      WHERE erp_actor_id=$1 AND action=$2 AND idempotency_key=$3::uuid
      FOR SHARE`,
    [actorId, action, idempotencyKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_sha256 !== requestHash) {
    throw new HttpError(
      409,
      "CLIENT_PORTAL_IDEMPOTENCY_CONFLICT",
      "Cette clé d'idempotence a déjà été utilisée avec une autre demande."
    );
  }
  return row.result;
}

async function insertReceipt(
  tx: Db,
  actorId: number,
  action: string,
  idempotencyKey: string,
  requestHash: string,
  result: JsonObject
): Promise<void> {
  await tx.query(
    `INSERT INTO public.client_portal_command_receipts (
       erp_actor_id, action, idempotency_key, request_sha256, result
     ) VALUES ($1,$2,$3::uuid,$4,$5::jsonb)`,
    [actorId, action, idempotencyKey, requestHash, JSON.stringify(result)]
  );
}

export async function repoListPortalAccounts(clientId?: string) {
  const values: unknown[] = [];
  const where = clientId ? `WHERE account.client_id=$${values.push(clientId)}` : "";
  const result = await pool.query(
    `SELECT account.id::text AS id, account.client_id, client.company_name,
            account.email, account.display_name, account.status,
            account.activated_at::text AS activated_at,
            account.last_login_at::text AS last_login_at,
            account.created_at::text AS created_at,
            account.updated_at::text AS updated_at
       FROM public.client_portal_accounts account
       JOIN public.clients client ON client.client_id=account.client_id
       ${where}
      ORDER BY account.created_at DESC
      LIMIT 250`,
    values
  );
  return result.rows;
}

export async function repoCreatePortalAccount(input: {
  actorId: number;
  idempotencyKey: string;
  requestHash: string;
  clientId: string;
  email: string;
  emailNormalized: string;
  displayName: string;
  passwordHash: string;
  meta: ClientPortalRequestMeta;
}): Promise<{ account: JsonObject; replayed: boolean }> {
  try {
    return await withTransaction(async (tx) => {
      const replay = await readReceipt(tx, input.actorId, "CREATE_ACCOUNT", input.idempotencyKey, input.requestHash);
      if (replay) {
        const replayedAccount = await tx.query<JsonObject>(
          `SELECT account.id::text AS id, account.client_id, client.company_name,
                  account.email, account.display_name, account.status,
                  account.created_at::text AS created_at
             FROM public.client_portal_accounts account
             JOIN public.clients client ON client.client_id=account.client_id
            WHERE account.id=$1::uuid`,
          [String(replay.id)]
        );
        if (!replayedAccount.rows[0]) {
          throw new HttpError(409, "CLIENT_PORTAL_IDEMPOTENCY_ORPHAN", "Le reçu existe mais le compte est introuvable.");
        }
        return { account: replayedAccount.rows[0], replayed: true };
      }

      const client = await tx.query<{ client_id: string; company_name: string }>(
        `SELECT client_id, company_name FROM public.clients WHERE client_id=$1 FOR SHARE`,
        [input.clientId]
      );
      if (!client.rows[0]) {
        throw new HttpError(404, "CLIENT_PORTAL_CLIENT_NOT_FOUND", "Client introuvable.");
      }

      const created = await tx.query<{
        id: string;
        client_id: string;
        email: string;
        display_name: string;
        status: string;
        created_at: string;
      }>(
        `INSERT INTO public.client_portal_accounts (
           client_id, email, email_normalized, display_name, password_hash,
           status, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,'INVITED',$6,$6)
         RETURNING id::text AS id, client_id, email, display_name, status, created_at::text AS created_at`,
        [input.clientId, input.email, input.emailNormalized, input.displayName, input.passwordHash, input.actorId]
      );
      const createdAccount = created.rows[0];
      if (!createdAccount) throw new Error("Portal account insert returned no row");
      const account: JsonObject = { ...createdAccount, company_name: client.rows[0].company_name };
      await repoInsertPortalAudit(tx, {
        actor: { kind: "ERP_USER", id: input.actorId },
        action: "CLIENT_PORTAL_ACCOUNT_CREATED",
        entityType: "client_portal_account",
        entityId: String(account.id),
        clientId: input.clientId,
        meta: input.meta,
        details: { status: "INVITED" },
      });
      await insertReceipt(tx, input.actorId, "CREATE_ACCOUNT", input.idempotencyKey, input.requestHash, {
        id: account.id,
        client_id: account.client_id,
        status: account.status,
        created_at: account.created_at,
      });
      return { account, replayed: false };
    });
  } catch (error) {
    if (pgCode(error) === "23505") {
      throw new HttpError(409, "CLIENT_PORTAL_ACCOUNT_EXISTS", "Un compte portail actif existe déjà pour cet email.");
    }
    throw error;
  }
}

export async function repoCreatePortalInvitation(input: {
  actorId: number;
  accountId: string;
  tokenId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  idempotencyKey: string;
  requestHash: string;
  meta: ClientPortalRequestMeta;
}): Promise<{ token: JsonObject; replayed: boolean }> {
  return withTransaction(async (tx) => {
    const replay = await readReceipt(tx, input.actorId, "CREATE_INVITATION", input.idempotencyKey, input.requestHash);
    if (replay) {
      const replayAccount = await tx.query<{ email: string; display_name: string }>(
        `SELECT email, display_name FROM public.client_portal_accounts WHERE id=$1::uuid`,
        [String(replay.account_id)]
      );
      if (!replayAccount.rows[0]) {
        throw new HttpError(409, "CLIENT_PORTAL_IDEMPOTENCY_ORPHAN", "Le reçu existe mais le compte est introuvable.");
      }
      return { token: { ...replay, ...replayAccount.rows[0] }, replayed: true };
    }

    const accountResult = await tx.query<PortalAccountRow>(
      `SELECT account.id::text AS id, account.client_id, client.company_name,
              account.email, account.email_normalized, account.display_name,
              account.password_hash, account.status, account.session_epoch,
              account.activated_at::text AS activated_at,
              account.last_login_at::text AS last_login_at,
              account.created_at::text AS created_at
         FROM public.client_portal_accounts account
         JOIN public.clients client ON client.client_id=account.client_id
        WHERE account.id=$1::uuid
        FOR UPDATE OF account`,
      [input.accountId]
    );
    const account = accountResult.rows[0];
    if (!account) throw new HttpError(404, "CLIENT_PORTAL_ACCOUNT_NOT_FOUND", "Compte portail introuvable.");
    if (account.status !== "INVITED") {
      throw new HttpError(409, "CLIENT_PORTAL_INVITATION_STATE", "Ce compte n'est pas en attente d'activation.");
    }

    await tx.query(
      `UPDATE public.client_portal_tokens
          SET revoked_at=now()
        WHERE account_id=$1::uuid AND purpose='INVITATION'
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [account.id]
    );
    const inserted = await tx.query<JsonObject>(
      `INSERT INTO public.client_portal_tokens (
         id, account_id, purpose, token_hash, expires_at, created_by, created_at
       ) VALUES ($1::uuid,$2::uuid,'INVITATION',$3,$4::timestamptz,$5,$6::timestamptz)
       RETURNING id::text AS token_id, account_id::text AS account_id,
                 created_at::text AS created_at, expires_at::text AS expires_at`,
      [input.tokenId, account.id, input.tokenHash, input.expiresAt, input.actorId, input.createdAt]
    );
    const receiptToken = {
      ...inserted.rows[0],
      client_id: account.client_id,
    };
    const token = { ...receiptToken, email: account.email, display_name: account.display_name };
    await repoInsertPortalAudit(tx, {
      actor: { kind: "ERP_USER", id: input.actorId },
      action: "CLIENT_PORTAL_ACCOUNT_INVITED",
      entityType: "client_portal_account",
      entityId: account.id,
      clientId: account.client_id,
      meta: input.meta,
      details: { expires_at: input.expiresAt },
    });
    await insertReceipt(tx, input.actorId, "CREATE_INVITATION", input.idempotencyKey, input.requestHash, receiptToken);
    return { token, replayed: false };
  });
}

export async function repoActivatePortalAccount(input: {
  tokenId: string;
  accountId: string;
  tokenHash: string;
  passwordHash: string;
  meta: ClientPortalRequestMeta;
}): Promise<{ account_id: string; client_id: string; replayed: boolean }> {
  return withTransaction(async (tx) => {
    const result = await tx.query<{
      token_id: string;
      account_id: string;
      client_id: string;
      status: string;
      consumed_at: string | null;
      revoked_at: string | null;
      expires_at: string;
    }>(
      `SELECT token.id::text AS token_id, account.id::text AS account_id,
              account.client_id, account.status, token.consumed_at::text AS consumed_at,
              token.revoked_at::text AS revoked_at, token.expires_at::text AS expires_at
         FROM public.client_portal_tokens token
         JOIN public.client_portal_accounts account ON account.id=token.account_id
        WHERE token.id=$1::uuid AND account.id=$2::uuid
          AND token.purpose='INVITATION' AND token.token_hash=$3
        FOR UPDATE OF token, account`,
      [input.tokenId, input.accountId, input.tokenHash]
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw new HttpError(400, "CLIENT_PORTAL_INVITATION_INVALID", "Invitation invalide ou expirée.");
    }
    if (row.consumed_at) {
      if (row.status === "ACTIVE") return { account_id: row.account_id, client_id: row.client_id, replayed: true };
      throw new HttpError(409, "CLIENT_PORTAL_INVITATION_STATE", "Cette invitation a déjà été utilisée.");
    }
    if (row.status !== "INVITED") {
      throw new HttpError(409, "CLIENT_PORTAL_INVITATION_STATE", "Ce compte n'est plus activable.");
    }

    await tx.query(
      `UPDATE public.client_portal_accounts
          SET password_hash=$2, status='ACTIVE', activated_at=now(),
              suspended_at=NULL, revoked_at=NULL, session_epoch=session_epoch+1, updated_at=now()
        WHERE id=$1::uuid`,
      [row.account_id, input.passwordHash]
    );
    await tx.query(`UPDATE public.client_portal_tokens SET consumed_at=now() WHERE id=$1::uuid`, [row.token_id]);
    await repoInsertPortalAudit(tx, {
      actor: { kind: "PORTAL_ACCOUNT", id: row.account_id },
      action: "CLIENT_PORTAL_ACCOUNT_ACTIVATED",
      entityType: "client_portal_account",
      entityId: row.account_id,
      clientId: row.client_id,
      meta: input.meta,
    });
    return { account_id: row.account_id, client_id: row.client_id, replayed: false };
  });
}

export async function repoFindPortalAccountByEmail(emailNormalized: string): Promise<PortalAccountRow | null> {
  const result = await pool.query<PortalAccountRow>(
    `SELECT account.id::text AS id, account.client_id, client.company_name,
            account.email, account.email_normalized, account.display_name,
            account.password_hash, account.status, account.session_epoch,
            account.activated_at::text AS activated_at,
            account.last_login_at::text AS last_login_at,
            account.created_at::text AS created_at
       FROM public.client_portal_accounts account
       JOIN public.clients client ON client.client_id=account.client_id
      WHERE account.email_normalized=$1 AND account.status <> 'REVOKED'
      LIMIT 1`,
    [emailNormalized]
  );
  return result.rows[0] ?? null;
}

export async function repoGetLivePortalAccount(identity: ClientPortalIdentity) {
  const result = await pool.query<{
    id: string;
    client_id: string;
    status: string;
    session_epoch: number;
  }>(
    `SELECT id::text AS id, client_id, status, session_epoch::int AS session_epoch
       FROM public.client_portal_accounts
      WHERE id=$1::uuid AND client_id=$2`,
    [identity.accountId, identity.clientId]
  );
  return result.rows[0] ?? null;
}

export async function repoRecordPortalLogin(account: PortalAccountRow, meta: ClientPortalRequestMeta): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE public.client_portal_accounts SET last_login_at=now(), updated_at=now() WHERE id=$1::uuid`,
      [account.id]
    );
    await repoInsertPortalAudit(tx, {
      actor: { kind: "PORTAL_ACCOUNT", id: account.id },
      action: "CLIENT_PORTAL_LOGIN_SUCCEEDED",
      entityType: "client_portal_account",
      entityId: account.id,
      clientId: account.client_id,
      meta,
    });
  });
}

export async function repoCreatePortalResetToken(input: {
  accountId: string;
  tokenId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  meta: ClientPortalRequestMeta;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const account = await tx.query<{ id: string; client_id: string; status: string }>(
      `SELECT id::text AS id, client_id, status
         FROM public.client_portal_accounts
        WHERE id=$1::uuid FOR UPDATE`,
      [input.accountId]
    );
    const row = account.rows[0];
    if (!row || row.status === "REVOKED") return;
    await tx.query(
      `UPDATE public.client_portal_tokens SET revoked_at=now()
        WHERE account_id=$1::uuid AND purpose='PASSWORD_RESET'
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [row.id]
    );
    await tx.query(
      `INSERT INTO public.client_portal_tokens (
         id, account_id, purpose, token_hash, expires_at, created_at
       ) VALUES ($1::uuid,$2::uuid,'PASSWORD_RESET',$3,$4::timestamptz,$5::timestamptz)`,
      [input.tokenId, row.id, input.tokenHash, input.expiresAt, input.createdAt]
    );
    await repoInsertPortalAudit(tx, {
      actor: { kind: "PORTAL_ACCOUNT", id: row.id },
      action: "CLIENT_PORTAL_PASSWORD_RESET_REQUESTED",
      entityType: "client_portal_account",
      entityId: row.id,
      clientId: row.client_id,
      meta: input.meta,
      details: { expires_at: input.expiresAt },
    });
  });
}

export async function repoResetPortalPassword(input: {
  tokenId: string;
  accountId: string;
  tokenHash: string;
  passwordHash: string;
  meta: ClientPortalRequestMeta;
}): Promise<{ account_id: string; client_id: string }> {
  return withTransaction(async (tx) => {
    const result = await tx.query<{
      token_id: string;
      account_id: string;
      client_id: string;
      status: string;
      consumed_at: string | null;
      revoked_at: string | null;
      expires_at: string;
    }>(
      `SELECT token.id::text AS token_id, account.id::text AS account_id,
              account.client_id, account.status, token.consumed_at::text AS consumed_at,
              token.revoked_at::text AS revoked_at, token.expires_at::text AS expires_at
         FROM public.client_portal_tokens token
         JOIN public.client_portal_accounts account ON account.id=token.account_id
        WHERE token.id=$1::uuid AND account.id=$2::uuid
          AND token.purpose='PASSWORD_RESET' AND token.token_hash=$3
        FOR UPDATE OF token, account`,
      [input.tokenId, input.accountId, input.tokenHash]
    );
    const row = result.rows[0];
    if (
      !row || row.revoked_at || row.consumed_at || row.status === "REVOKED"
      || new Date(row.expires_at).getTime() <= Date.now()
    ) {
      throw new HttpError(400, "CLIENT_PORTAL_RESET_INVALID", "Lien de réinitialisation invalide ou expiré.");
    }
    await tx.query(
      `UPDATE public.client_portal_accounts
          SET password_hash=$2, session_epoch=session_epoch+1, updated_at=now()
        WHERE id=$1::uuid`,
      [row.account_id, input.passwordHash]
    );
    await tx.query(`UPDATE public.client_portal_tokens SET consumed_at=now() WHERE id=$1::uuid`, [row.token_id]);
    await repoInsertPortalAudit(tx, {
      actor: { kind: "PORTAL_ACCOUNT", id: row.account_id },
      action: "CLIENT_PORTAL_PASSWORD_RESET_COMPLETED",
      entityType: "client_portal_account",
      entityId: row.account_id,
      clientId: row.client_id,
      meta: input.meta,
    });
    return { account_id: row.account_id, client_id: row.client_id };
  });
}

export async function repoSetPortalAccountStatus(input: {
  actorId: number;
  accountId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  reason: string;
  meta: ClientPortalRequestMeta;
}) {
  return withTransaction(async (tx) => {
    const current = await tx.query<{ id: string; client_id: string; status: string; activated_at: string | null }>(
      `SELECT id::text AS id, client_id, status, activated_at::text AS activated_at
         FROM public.client_portal_accounts WHERE id=$1::uuid FOR UPDATE`,
      [input.accountId]
    );
    const row = current.rows[0];
    if (!row) throw new HttpError(404, "CLIENT_PORTAL_ACCOUNT_NOT_FOUND", "Compte portail introuvable.");
    if (row.status === "REVOKED") {
      throw new HttpError(409, "CLIENT_PORTAL_ACCOUNT_REVOKED", "Un compte révoqué ne peut pas être réactivé.");
    }
    if (input.status === "ACTIVE" && !row.activated_at) {
      throw new HttpError(409, "CLIENT_PORTAL_ACCOUNT_NOT_ACTIVATED", "Le compte doit d'abord être activé par invitation.");
    }
    const updated = await tx.query(
      `UPDATE public.client_portal_accounts
          SET status=$2,
              suspended_at=CASE WHEN $2='SUSPENDED' THEN now() ELSE NULL END,
              revoked_at=CASE WHEN $2='REVOKED' THEN now() ELSE NULL END,
              session_epoch=session_epoch+1, updated_by=$3, updated_at=now()
        WHERE id=$1::uuid
        RETURNING id::text AS id, client_id, status, session_epoch::int AS session_epoch`,
      [row.id, input.status, input.actorId]
    );
    await tx.query(
      `UPDATE public.client_portal_tokens SET revoked_at=now()
        WHERE account_id=$1::uuid AND consumed_at IS NULL AND revoked_at IS NULL`,
      [row.id]
    );
    await repoInsertPortalAudit(tx, {
      actor: { kind: "ERP_USER", id: input.actorId },
      action: `CLIENT_PORTAL_ACCOUNT_${input.status}`,
      entityType: "client_portal_account",
      entityId: row.id,
      clientId: row.client_id,
      meta: input.meta,
      details: { previous_status: row.status, reason_recorded: true },
    });
    return updated.rows[0];
  });
}

export async function repoConsumePortalAuthAttempt(input: {
  action: "LOGIN" | "ACTIVATE" | "FORGOT_PASSWORD" | "RESET_PASSWORD";
  identifierHash: string;
  ipHash: string | null;
  identifierLimit: number;
  ipLimit: number;
  windowSeconds: number;
}): Promise<string> {
  return withTransaction(async (tx) => {
    const lockKeys = [
      `client-portal-rate:${input.action}:identifier:${input.identifierHash}`,
      ...(input.ipHash ? [`client-portal-rate:${input.action}:ip:${input.ipHash}`] : []),
    ].sort();
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
         FROM unnest($1::text[]) AS lock_key
        ORDER BY lock_key`,
      [lockKeys]
    );
    const counts = await tx.query<{ identifier_count: string; ip_count: string }>(
      `SELECT
         count(*) FILTER (WHERE identifier_hash=$2)::bigint::text AS identifier_count,
         count(*) FILTER (WHERE $3::text IS NOT NULL AND ip_hash=$3)::bigint::text AS ip_count
       FROM public.client_portal_auth_attempts
       WHERE action=$1 AND occurred_at > now() - make_interval(secs => $4::int)`,
      [input.action, input.identifierHash, input.ipHash, input.windowSeconds]
    );
    const identifierCount = Number(counts.rows[0]?.identifier_count ?? 0);
    const ipCount = Number(counts.rows[0]?.ip_count ?? 0);
    if (identifierCount >= input.identifierLimit || ipCount >= input.ipLimit) {
      throw new HttpError(429, "CLIENT_PORTAL_RATE_LIMITED", "Trop de tentatives. Réessayez plus tard.");
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO public.client_portal_auth_attempts(action, identifier_hash, ip_hash, success)
       VALUES ($1,$2,$3,false) RETURNING id::bigint::text AS id`,
      [input.action, input.identifierHash, input.ipHash]
    );
    await tx.query(`DELETE FROM public.client_portal_auth_attempts WHERE occurred_at < now() - interval '2 days'`);
    return String(inserted.rows[0].id);
  });
}

export async function repoMarkPortalAuthAttemptSuccess(attemptId: string): Promise<void> {
  await pool.query(
    `UPDATE public.client_portal_auth_attempts SET success=true WHERE id=$1::bigint`,
    [attemptId]
  );
}

export async function repoGetPortalProfile(identity: ClientPortalIdentity) {
  const result = await pool.query(
    `SELECT account.id::text AS account_id, account.client_id, account.display_name,
            client.company_name, account.last_login_at::text AS last_login_at
       FROM public.client_portal_accounts account
       JOIN public.clients client ON client.client_id=account.client_id
      WHERE account.id=$1::uuid AND account.client_id=$2 AND account.status='ACTIVE'`,
    [identity.accountId, identity.clientId]
  );
  return result.rows[0] ?? null;
}

async function listProjection(viewName: string, identity: ClientPortalIdentity, page: number, pageSize: number) {
  const allowedViews = new Set([
    "client_portal_orders_v",
    "client_portal_deliveries_v",
    "client_portal_invoices_v",
  ]);
  if (!allowedViews.has(viewName)) throw new Error("Unknown portal projection");
  const offset = (page - 1) * pageSize;
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.${viewName} WHERE client_id=$1`,
    [identity.clientId]
  );
  const data = await pool.query(
    `SELECT * FROM public.${viewName}
      WHERE client_id=$1
      ORDER BY updated_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [identity.clientId, pageSize, offset]
  );
  return { items: data.rows.map(({ client_id: _clientId, ...row }) => row), total: count.rows[0]?.total ?? 0 };
}

export const repoListPortalOrders = (identity: ClientPortalIdentity, page: number, pageSize: number) =>
  listProjection("client_portal_orders_v", identity, page, pageSize);

export const repoListPortalDeliveries = (identity: ClientPortalIdentity, page: number, pageSize: number) =>
  listProjection("client_portal_deliveries_v", identity, page, pageSize);

export const repoListPortalInvoices = (identity: ClientPortalIdentity, page: number, pageSize: number) =>
  listProjection("client_portal_invoices_v", identity, page, pageSize);

const PORTAL_DOCUMENT_SELECT = `
  publication.id::text AS id,
  publication.client_id,
  publication.version_id::text AS version_id,
  version.document_id::text AS document_id,
  document.code,
  COALESCE(publication.title_override, document.title) AS title,
  version.version_number::int AS version_number,
  version.status::text AS version_status,
  document.current_version_id::text AS current_version_id,
  document.archived_at::text AS document_archived_at,
  version.original_name,
  blob.mime_type,
  blob.size_bytes::bigint::text AS size_bytes,
  blob.sha256,
  session.scan_status,
  session.quarantine_status,
  session.scanned_at::text AS scanned_at,
  publication.expires_at::text AS expires_at,
  publication.revoked_at::text AS revoked_at,
  publication.acknowledgement_required,
  acknowledgement.acknowledged_at::text AS acknowledged_at,
  publication.created_at::text AS published_at
`;

function mapPortalDocument(row: Record<string, unknown>): PortalDocumentRow {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    version_id: String(row.version_id),
    document_id: String(row.document_id),
    code: String(row.code),
    title: String(row.title),
    version_number: Number(row.version_number),
    version_status: String(row.version_status),
    current_version_id: row.current_version_id == null ? null : String(row.current_version_id),
    document_archived_at: row.document_archived_at == null ? null : String(row.document_archived_at),
    original_name: String(row.original_name),
    mime_type: String(row.mime_type),
    size_bytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    ...(row.storage_key == null ? {} : { storage_key: String(row.storage_key) }),
    scan_status: row.scan_status == null ? null : String(row.scan_status),
    quarantine_status: row.quarantine_status == null ? null : String(row.quarantine_status),
    scanned_at: row.scanned_at == null ? null : String(row.scanned_at),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    revoked_at: row.revoked_at == null ? null : String(row.revoked_at),
    acknowledgement_required: Boolean(row.acknowledgement_required),
    acknowledged_at: row.acknowledged_at == null ? null : String(row.acknowledged_at),
    published_at: String(row.published_at),
  };
}

export async function repoListPortalDocuments(identity: ClientPortalIdentity): Promise<PortalDocumentRow[]> {
  const result = await pool.query(
    `SELECT ${PORTAL_DOCUMENT_SELECT}
       FROM public.client_portal_publications publication
       JOIN public.ged_document_versions version ON version.id=publication.version_id
       JOIN public.ged_documents document ON document.id=version.document_id
       JOIN public.ged_blobs blob ON blob.id=version.blob_id
       LEFT JOIN public.ged_upload_sessions session ON session.id=version.upload_session_id
       LEFT JOIN public.client_portal_acknowledgements acknowledgement
         ON acknowledgement.publication_id=publication.id AND acknowledgement.account_id=$1::uuid
      WHERE publication.client_id=$2
      ORDER BY publication.created_at DESC`,
    [identity.accountId, identity.clientId]
  );
  return result.rows.map(mapPortalDocument);
}

export async function repoGetPortalDocumentDownload(
  identity: ClientPortalIdentity,
  publicationId: string
): Promise<PortalDocumentRow | null> {
  const result = await pool.query(
    `SELECT ${PORTAL_DOCUMENT_SELECT}, blob.storage_key
       FROM public.client_portal_publications publication
       JOIN public.ged_document_versions version ON version.id=publication.version_id
       JOIN public.ged_documents document ON document.id=version.document_id
       JOIN public.ged_blobs blob ON blob.id=version.blob_id
       LEFT JOIN public.ged_upload_sessions session ON session.id=version.upload_session_id
       LEFT JOIN public.client_portal_acknowledgements acknowledgement
         ON acknowledgement.publication_id=publication.id AND acknowledgement.account_id=$1::uuid
      WHERE publication.id=$2::uuid AND publication.client_id=$3`,
    [identity.accountId, publicationId, identity.clientId]
  );
  return result.rows[0] ? mapPortalDocument(result.rows[0]) : null;
}

export async function repoAcknowledgePortalDocument(input: {
  identity: ClientPortalIdentity;
  publicationId: string;
  state: ClientPortalDocumentState;
  meta: ClientPortalRequestMeta;
}) {
  return withTransaction(async (tx) => {
    const publication = await tx.query<{ id: string; client_id: string; acknowledgement_required: boolean }>(
      `SELECT id::text AS id, client_id, acknowledgement_required
         FROM public.client_portal_publications
        WHERE id=$1::uuid AND client_id=$2
        FOR SHARE`,
      [input.publicationId, input.identity.clientId]
    );
    const row = publication.rows[0];
    if (!row) throw new HttpError(404, "CLIENT_PORTAL_DOCUMENT_NOT_FOUND", "Document introuvable.");
    if (!row.acknowledgement_required) {
      throw new HttpError(409, "CLIENT_PORTAL_ACK_NOT_REQUIRED", "Aucun accusé de lecture n'est requis.");
    }
    if (input.state !== "AVAILABLE") {
      throw new HttpError(409, "CLIENT_PORTAL_DOCUMENT_UNAVAILABLE", "Ce document ne peut pas être accusé dans son état actuel.");
    }
    const inserted = await tx.query<{ acknowledged_at: string }>(
      `INSERT INTO public.client_portal_acknowledgements(publication_id, account_id, request_id)
       VALUES ($1::uuid,$2::uuid,$3)
       ON CONFLICT (publication_id, account_id) DO NOTHING
       RETURNING acknowledged_at::text AS acknowledged_at`,
      [row.id, input.identity.accountId, input.meta.requestId]
    );
    const existing = inserted.rows[0] ?? (await tx.query<{ acknowledged_at: string }>(
      `SELECT acknowledged_at::text AS acknowledged_at
         FROM public.client_portal_acknowledgements
        WHERE publication_id=$1::uuid AND account_id=$2::uuid`,
      [row.id, input.identity.accountId]
    )).rows[0];
    if (inserted.rows[0]) {
      await repoInsertPortalAudit(tx, {
        actor: { kind: "PORTAL_ACCOUNT", id: input.identity.accountId },
        action: "CLIENT_PORTAL_DOCUMENT_ACKNOWLEDGED",
        entityType: "client_portal_publication",
        entityId: row.id,
        clientId: input.identity.clientId,
        meta: input.meta,
      });
    }
    return { acknowledged_at: existing.acknowledged_at, replayed: !inserted.rows[0] };
  });
}

export async function repoCreatePortalPublication(input: {
  actorId: number;
  idempotencyKey: string;
  requestHash: string;
  clientId: string;
  versionId: string;
  title: string | null;
  expiresAt: string | null;
  acknowledgementRequired: boolean;
  meta: ClientPortalRequestMeta;
}) {
  try {
    return await withTransaction(async (tx) => {
      const replay = await readReceipt(tx, input.actorId, "PUBLISH_DOCUMENT", input.idempotencyKey, input.requestHash);
      if (replay) return { publication: replay, replayed: true };

      const eligible = await tx.query<{ version_id: string; document_id: string }>(
        `SELECT version.id::text AS version_id, version.document_id::text AS document_id
           FROM public.ged_document_versions version
           JOIN public.ged_documents document ON document.id=version.document_id
           JOIN public.ged_upload_sessions session ON session.id=version.upload_session_id
          WHERE version.id=$1::uuid
            AND version.status='APPLICABLE'
            AND document.current_version_id=version.id
            AND document.archived_at IS NULL
            AND session.scan_status='clean'
            AND session.quarantine_status='released'
            AND EXISTS (
              SELECT 1
                FROM public.ged_document_links link
               WHERE link.document_id=document.id
                 AND (
                   (link.entity_type='CLIENT' AND link.entity_id=$2)
                   OR (link.entity_type='COMMANDE_CLIENT' AND EXISTS (
                     SELECT 1 FROM public.commande_client cc
                      WHERE cc.id::text=link.entity_id AND cc.client_id=$2
                   ))
                   OR (link.entity_type='FACTURE' AND EXISTS (
                     SELECT 1 FROM public.facture facture
                      WHERE facture.id::text=link.entity_id AND facture.client_id=$2
                   ))
                   OR (link.entity_type IN ('BON_LIVRAISON','LIVRAISON') AND EXISTS (
                     SELECT 1 FROM public.bon_livraison bl
                      WHERE bl.id::text=link.entity_id AND bl.client_id=$2
                   ))
                 )
            )
          FOR SHARE OF version, document, session`,
        [input.versionId, input.clientId]
      );
      if (!eligible.rows[0]) {
        throw new HttpError(
          409,
          "CLIENT_PORTAL_DOCUMENT_NOT_ELIGIBLE",
          "La version doit être courante, applicable, saine et liée à ce client."
        );
      }
      const inserted = await tx.query<JsonObject>(
        `INSERT INTO public.client_portal_publications (
           client_id, version_id, title_override, acknowledgement_required,
           expires_at, published_by
         ) VALUES ($1,$2::uuid,$3,$4,$5::timestamptz,$6)
         RETURNING id::text AS id, client_id, version_id::text AS version_id,
                   acknowledgement_required, expires_at::text AS expires_at,
                   created_at::text AS published_at`,
        [input.clientId, input.versionId, input.title, input.acknowledgementRequired, input.expiresAt, input.actorId]
      );
      const publication = inserted.rows[0];
      await repoInsertPortalAudit(tx, {
        actor: { kind: "ERP_USER", id: input.actorId },
        action: "CLIENT_PORTAL_DOCUMENT_PUBLISHED",
        entityType: "client_portal_publication",
        entityId: String(publication.id),
        clientId: input.clientId,
        meta: input.meta,
        details: {
          version_id: input.versionId,
          acknowledgement_required: input.acknowledgementRequired,
          expires_at: input.expiresAt,
        },
      });
      await insertReceipt(tx, input.actorId, "PUBLISH_DOCUMENT", input.idempotencyKey, input.requestHash, publication);
      return { publication, replayed: false };
    });
  } catch (error) {
    if (pgCode(error) === "23505") {
      throw new HttpError(409, "CLIENT_PORTAL_PUBLICATION_EXISTS", "Cette version est déjà publiée pour ce client.");
    }
    throw error;
  }
}

export async function repoRevokePortalPublication(input: {
  actorId: number;
  publicationId: string;
  reason: string;
  meta: ClientPortalRequestMeta;
}) {
  return withTransaction(async (tx) => {
    const result = await tx.query<{ id: string; client_id: string; revoked_at: string }>(
      `UPDATE public.client_portal_publications
          SET revoked_at=COALESCE(revoked_at, now()),
              revoked_by=COALESCE(revoked_by, $2),
              revoked_reason=COALESCE(revoked_reason, $3)
        WHERE id=$1::uuid
        RETURNING id::text AS id, client_id, revoked_at::text AS revoked_at`,
      [input.publicationId, input.actorId, input.reason]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "CLIENT_PORTAL_PUBLICATION_NOT_FOUND", "Publication introuvable.");
    await repoInsertPortalAudit(tx, {
      actor: { kind: "ERP_USER", id: input.actorId },
      action: "CLIENT_PORTAL_DOCUMENT_REVOKED",
      entityType: "client_portal_publication",
      entityId: row.id,
      clientId: row.client_id,
      meta: input.meta,
      details: { reason_recorded: true },
    });
    return row;
  });
}

export async function repoListPortalPublications(clientId?: string) {
  const values: unknown[] = [];
  const where = clientId ? `WHERE publication.client_id=$${values.push(clientId)}` : "";
  const result = await pool.query(
    `SELECT publication.id::text AS id, publication.client_id,
            publication.version_id::text AS version_id, document.code,
            COALESCE(publication.title_override, document.title) AS title,
            publication.acknowledgement_required,
            publication.expires_at::text AS expires_at,
            publication.revoked_at::text AS revoked_at,
            publication.created_at::text AS published_at
       FROM public.client_portal_publications publication
       JOIN public.ged_document_versions version ON version.id=publication.version_id
       JOIN public.ged_documents document ON document.id=version.document_id
       ${where}
      ORDER BY publication.created_at DESC
      LIMIT 250`,
    values
  );
  return result.rows;
}

export async function repoRecordPortalDocumentDownload(input: {
  identity: ClientPortalIdentity;
  publicationId: string;
  outcome: "SUCCEEDED" | "INTEGRITY_FAILURE";
  meta: ClientPortalRequestMeta;
}): Promise<void> {
  await repoInsertPortalAudit(pool, {
    actor: { kind: "PORTAL_ACCOUNT", id: input.identity.accountId },
    action: input.outcome === "SUCCEEDED"
      ? "CLIENT_PORTAL_DOCUMENT_DOWNLOADED"
      : "CLIENT_PORTAL_DOCUMENT_INTEGRITY_FAILURE",
    entityType: "client_portal_publication",
    entityId: input.publicationId,
    clientId: input.identity.clientId,
    meta: input.meta,
  });
}
