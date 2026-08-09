import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { bumpRealtimeSessionEpoch } from "../../../shared/realtime/realtime-control-plane";
import {
  type RealtimeCommitReconciliation,
  withRealtimeOutboxTransaction,
} from "../../../shared/realtime/realtime-outbox-transaction";
import { HttpError } from "../../../utils/httpError";

type ActivationMutation = {
  invitationId: string;
  userId: number;
  tokenHash: string;
  acceptedAt: string;
  passwordHash: string;
  replayed: boolean;
  noOp?: boolean;
};

async function reconcileActivation(
  verifier: PoolClient,
  mutation: ActivationMutation,
): Promise<RealtimeCommitReconciliation> {
  if (mutation.noOp) return "committed";
  const { rows } = await verifier.query<{
    token_hash: string;
    accepted_at: string | null;
    status: string | null;
    password_hash: string;
  }>(
    `
      SELECT
        invitation.token_hash,
        invitation.accepted_at::text AS accepted_at,
        users.status,
        users.password AS password_hash
      FROM public.admin_account_invitations invitation
      JOIN public.users users ON users.id = invitation.user_id
      WHERE invitation.id = $1::uuid
        AND invitation.user_id = $2
    `,
    [mutation.invitationId, mutation.userId],
  );
  const row = rows[0];
  if (!row || row.token_hash !== mutation.tokenHash) return "unknown";
  if (
    row.accepted_at === mutation.acceptedAt
    && row.status === "Active"
    && row.password_hash === mutation.passwordHash
  ) return "committed";
  if (row.accepted_at === null && row.status === "Inactive") return "not_committed";
  return "unknown";
}

export async function repoActivateAccountInvitation(input: {
  invitationId: string;
  userId: number;
  tokenHash: string;
  passwordHash: string;
  meta: {
    ip: string | null;
    user_agent: string | null;
    device_type: string | null;
    os: string | null;
    browser: string | null;
  };
}): Promise<{ userId: number; replayed: boolean }> {
  const acceptedAt = new Date().toISOString();
  const client = await pool.connect();
  const mutation = await withRealtimeOutboxTransaction(client, async (tx) => {
    const { rows } = await tx.query<{
      invitation_id: string;
      user_id: number;
      created_by: number;
      token_hash: string;
      expires_at: string;
      accepted_at: string | null;
      revoked_at: string | null;
      status: string | null;
    }>(
      `
        SELECT
          invitation.id::text AS invitation_id,
          invitation.user_id::int AS user_id,
          invitation.created_by::int AS created_by,
          invitation.token_hash,
          invitation.expires_at::text AS expires_at,
          invitation.accepted_at::text AS accepted_at,
          invitation.revoked_at::text AS revoked_at,
          users.status
        FROM public.admin_account_invitations invitation
        JOIN public.users users ON users.id = invitation.user_id
        WHERE invitation.id = $1::uuid
          AND invitation.user_id = $2
        FOR UPDATE OF invitation, users
      `,
      [input.invitationId, input.userId],
    );
    const invitation = rows[0];
    if (!invitation || invitation.token_hash !== input.tokenHash || invitation.revoked_at) {
      throw new HttpError(400, "INVITATION_INVALID", "Invitation invalide ou expirée.");
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw new HttpError(400, "INVITATION_EXPIRED", "Invitation expirée. Demandez un nouveau lien.");
    }
    if (invitation.accepted_at) {
      if (invitation.status !== "Active") {
        throw new HttpError(
          409,
          "INVITATION_ACCOUNT_STATE_CONFLICT",
          "L'invitation a déjà été utilisée mais le compte n'est pas actif.",
        );
      }
      return {
        invitationId: invitation.invitation_id,
        userId: invitation.user_id,
        tokenHash: input.tokenHash,
        acceptedAt: invitation.accepted_at,
        passwordHash: input.passwordHash,
        replayed: true,
        noOp: true,
      } satisfies ActivationMutation;
    }
    if (invitation.status !== "Inactive") {
      throw new HttpError(
        409,
        "ACCOUNT_NOT_ACTIVATABLE",
        "Ce compte ne peut pas être activé avec cette invitation.",
      );
    }

    await tx.query(
      `UPDATE public.users SET password = $1, status = 'Active' WHERE id = $2`,
      [input.passwordHash, invitation.user_id],
    );
    const consumed = await tx.query(
      `
        UPDATE public.admin_account_invitations
        SET accepted_at = $2::timestamptz
        WHERE id = $1::uuid
          AND accepted_at IS NULL
          AND revoked_at IS NULL
      `,
      [invitation.invitation_id, acceptedAt],
    );
    if ((consumed.rowCount ?? 0) !== 1) {
      throw new HttpError(409, "INVITATION_ALREADY_USED", "Cette invitation a déjà été utilisée.");
    }
    await bumpRealtimeSessionEpoch(tx, invitation.user_id);
    await repoInsertAuditLog({
      user_id: invitation.user_id,
      body: {
        event_type: "ACTION",
        action: "ADMIN_USER_ACTIVATED",
        page_key: "auth",
        entity_type: "user",
        entity_id: String(invitation.user_id),
        path: "/api/v1/auth/activate",
        details: {
          actor_type: "invited-user",
          invitation_id: invitation.invitation_id,
          invited_by: invitation.created_by,
        },
      },
      ...input.meta,
      tx,
    });
    return {
      invitationId: invitation.invitation_id,
      userId: invitation.user_id,
      tokenHash: input.tokenHash,
      acceptedAt,
      passwordHash: input.passwordHash,
      replayed: false,
    } satisfies ActivationMutation;
  }, { reconcileCommit: reconcileActivation });

  return { userId: mutation.userId, replayed: mutation.replayed };
}
