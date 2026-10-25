import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { connectedTestInfo } from "../../../config/managed-database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { HttpError } from "../../../utils/httpError";

export const CATALOGUE_TEST_MAINTENANCE_USERNAME = "CERP_TEST_CATALOGUE_IMPORT";

/**
 * A disabled service identity solely provides the mandatory provenance FK for
 * the test-only catalogue maintenance command. It is not a JWT principal and
 * cannot be used to log in.
 */
export async function ensureCatalogueTestMaintenanceActor(): Promise<{ id: number; username: string; created: boolean }> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const identity = await connectedTestInfo(tx as Pick<PoolClient, "query">);
    if (identity?.database !== "cerp_test") {
      throw new HttpError(403, "CATALOGUE_IMPORT_TEST_DATABASE_REQUIRED", "Lâ€™import catalogue est rÃ©servÃ© Ã  cerp_test.");
    }

    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["catalogue-test-maintenance-actor"]);
    const existing = await tx.query<{ id: number; username: string }>(
      "SELECT id, username FROM public.users WHERE username = $1 LIMIT 1",
      [CATALOGUE_TEST_MAINTENANCE_USERNAME]
    );
    if (existing.rows[0]) return { ...existing.rows[0], created: false };

    // This password is intentionally random and discarded. The account remains
    // inactive, so it cannot create a session or impersonate a human operator.
    const password = await bcrypt.hash(crypto.randomBytes(48).toString("base64url"), 12);
    const inserted = await tx.query<{ id: number; username: string }>(
      `INSERT INTO public.users
        (username, password, name, surname, email, role, status, is_superadmin, mfa_reenrollment_required, avatar_key, country)
       VALUES ($1, $2, 'SYSTEME', 'IMPORT CATALOGUE TEST', $3, 'Employee', 'Inactive', false, true, 'robot', 'France')
       RETURNING id, username`,
      [CATALOGUE_TEST_MAINTENANCE_USERNAME, password, "cerp-test-catalogue-import@invalid.local"]
    );
    const actor = inserted.rows[0];
    await repoInsertAuditLog({
      user_id: actor.id,
      body: {
        event_type: "ACTION",
        action: "AUTH_TEST_MAINTENANCE_ACTOR_CREATED",
        page_key: "outillage",
        entity_type: "user",
        entity_id: String(actor.id),
        path: "maintenance/catalogue-import",
        details: { test_only: true, disabled: true, purpose: "catalogue provenance confirmation" },
      },
      ip: null,
      user_agent: "catalogue-import-cli",
      device_type: "server",
      os: "server",
      browser: "none",
      tx,
    });
    return { ...actor, created: true };
  });
}
