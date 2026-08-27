import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { AuditContext } from "../../client/repository/client.repository";

export type ElectronicInvoiceDirectoryResourceType = "CLIENT" | "FOURNISSEUR";

export type ElectronicInvoiceDirectoryVerificationResult = {
  resource_type: ElectronicInvoiceDirectoryResourceType;
  resource_id: string;
  siren: string;
  electronic_address: {
    scheme: string;
    value: string;
    directory_entry_id: string;
    verified_at: string;
  };
  idempotent_replay: boolean;
};

type DbQueryer = Pick<PoolClient, "query">;

function resourceSql(resourceType: ElectronicInvoiceDirectoryResourceType) {
  return resourceType === "CLIENT"
    ? {
        table: "public.clients",
        idColumn: "client_id",
        notFoundCode: "CLIENT_NOT_FOUND",
        entityType: "client",
      }
    : {
        table: "public.fournisseurs",
        idColumn: "id",
        notFoundCode: "FOURNISSEUR_NOT_FOUND",
        entityType: "FOURNISSEUR",
      };
}

function requestHash(value: Record<string, string>): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function findReplay(
  db: DbQueryer,
  idempotencyKey: string,
  expectedHash: string
): Promise<ElectronicInvoiceDirectoryVerificationResult | null> {
  const existing = await db.query<{ request_hash: string; result: ElectronicInvoiceDirectoryVerificationResult }>(
    `SELECT request_hash, result
       FROM public.einvoice_directory_verification_commands
      WHERE idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.request_hash !== expectedHash) {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Cette clé d'idempotence a déjà été utilisée avec une autre vérification d'annuaire."
    );
  }
  return { ...row.result, idempotent_replay: true };
}

export async function readDirectoryVerificationResource(
  resourceType: ElectronicInvoiceDirectoryResourceType,
  resourceId: string
): Promise<{ siren: string; updated_at: string }> {
  const target = resourceSql(resourceType);
  const current = await pool.query<{ siren: string | null; updated_at: string }>(
    `SELECT siren, updated_at::text AS updated_at
       FROM ${target.table}
      WHERE ${target.idColumn}::text = $1
      LIMIT 1`,
    [resourceId]
  );
  const row = current.rows[0];
  if (!row) throw new HttpError(404, target.notFoundCode, "Référentiel introuvable.");
  if (!row.siren || !/^\d{9}$/.test(row.siren)) {
    throw new HttpError(422, "EINVOICE_SIREN_REQUIRED", "Un SIREN à 9 chiffres doit être qualifié avant la vérification dans l'annuaire.");
  }
  return { siren: row.siren, updated_at: row.updated_at };
}

export async function findDirectoryVerificationReplay(params: {
  resourceType: ElectronicInvoiceDirectoryResourceType;
  resourceId: string;
  siren: string;
  identifier: string;
  expectedUpdatedAt: string;
  idempotencyKey: string;
}): Promise<ElectronicInvoiceDirectoryVerificationResult | null> {
  return findReplay(pool, params.idempotencyKey, requestHash({
    resource_type: params.resourceType,
    resource_id: params.resourceId,
    siren: params.siren,
    identifier: params.identifier,
    expected_updated_at: params.expectedUpdatedAt,
  }));
}

export async function persistDirectoryVerification(params: {
  resourceType: ElectronicInvoiceDirectoryResourceType;
  resourceId: string;
  siren: string;
  identifier: string;
  expectedUpdatedAt: string;
  idempotencyKey: string;
  audit: AuditContext;
}): Promise<ElectronicInvoiceDirectoryVerificationResult> {
  const target = resourceSql(params.resourceType);
  const hash = requestHash({
    resource_type: params.resourceType,
    resource_id: params.resourceId,
    siren: params.siren,
    identifier: params.identifier,
    expected_updated_at: params.expectedUpdatedAt,
  });
  const separator = params.identifier.indexOf(":");
  const scheme = params.identifier.slice(0, separator).toUpperCase();
  const value = params.identifier.slice(separator + 1);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await findReplay(client, params.idempotencyKey, hash);
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }
    const locked = await client.query<{ siren: string | null; updated_at: string }>(
      `SELECT siren, updated_at::text AS updated_at
         FROM ${target.table}
        WHERE ${target.idColumn}::text = $1
        FOR UPDATE`,
      [params.resourceId]
    );
    const current = locked.rows[0];
    if (!current) throw new HttpError(404, target.notFoundCode, "Référentiel introuvable.");
    if (current.siren !== params.siren) {
      throw new HttpError(409, "EINVOICE_SIREN_CHANGED", "Le SIREN a changé pendant la consultation de l'annuaire.");
    }
    if (new Date(current.updated_at).getTime() !== new Date(params.expectedUpdatedAt).getTime()) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le référentiel a été modifié ; rechargez-le avant de vérifier l'adresse.");
    }
    const updated = await client.query<{ verified_at: string }>(
      `UPDATE ${target.table}
          SET electronic_address_scheme = $2,
              electronic_address_value = $3,
              electronic_address_directory_entry_id = $4,
              electronic_address_verified_at = clock_timestamp(),
              updated_at = clock_timestamp(),
              updated_by = $5
        WHERE ${target.idColumn}::text = $1
      RETURNING electronic_address_verified_at::text AS verified_at`,
      [params.resourceId, scheme, value, params.identifier, params.audit.user_id]
    );
    const verifiedAt = updated.rows[0]?.verified_at;
    if (!verifiedAt) throw new Error("EINVOICE_DIRECTORY_VERIFICATION_WRITE_FAILED");
    const result: ElectronicInvoiceDirectoryVerificationResult = {
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      siren: params.siren,
      electronic_address: {
        scheme,
        value,
        directory_entry_id: params.identifier,
        verified_at: verifiedAt,
      },
      idempotent_replay: false,
    };
    await client.query(
      `INSERT INTO public.einvoice_directory_verification_commands
         (idempotency_key, resource_type, resource_id, request_hash, result, actor_user_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [params.idempotencyKey, params.resourceType, params.resourceId, hash, JSON.stringify(result), params.audit.user_id]
    );
    await repoInsertAuditLog({
      user_id: params.audit.user_id,
      ip: params.audit.ip,
      user_agent: params.audit.user_agent,
      device_type: params.audit.device_type,
      os: params.audit.os,
      browser: params.audit.browser,
      tx: client,
      body: {
        event_type: "ACTION",
        action: "EINVOICE_DIRECTORY_ADDRESS_VERIFIED",
        entity_type: target.entityType,
        entity_id: params.resourceId,
        path: params.audit.path,
        page_key: params.audit.page_key,
        client_session_id: params.audit.client_session_id,
        details: { siren: params.siren, scheme, directory_entry_id: params.identifier },
      },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "23505") {
      const replay = await findReplay(pool, params.idempotencyKey, hash);
      if (replay) return replay;
    }
    throw error;
  } finally {
    client.release();
  }
}
