import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertPortalAudit } from "./client-portal.repository";
import type { ClientPortalRequestMeta } from "../types/client-portal.types";

export async function changeDemandSite(input: {
  accountId: string;
  site: string;
  revoke: boolean;
  actorId: number;
  meta: ClientPortalRequestMeta;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const account = (
      await tx.query<{ client_id: string }>(
        "SELECT client_id FROM public.client_portal_accounts WHERE id=$1 FOR UPDATE",
        [input.accountId],
      )
    ).rows[0];
    if (!account)
      throw new HttpError(
        404,
        "CLIENT_PORTAL_ACCOUNT_NOT_FOUND",
        "Compte portail introuvable.",
      );
    const changed = input.revoke
      ? await tx.query(
          "DELETE FROM public.client_portal_demand_sites WHERE portal_account_id=$1 AND external_site=$2",
          [input.accountId, input.site],
        )
      : await tx.query(
          "INSERT INTO public.client_portal_demand_sites(portal_account_id,external_site,created_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [input.accountId, input.site, input.actorId],
        );
    if (changed.rowCount)
      await repoInsertPortalAudit(tx, {
        actor: { kind: "ERP_USER", id: input.actorId },
        action: input.revoke
          ? "CLIENT_PORTAL_DEMAND_SITE_REVOKED"
          : "CLIENT_PORTAL_DEMAND_SITE_GRANTED",
        entityType: "client_portal_accounts",
        entityId: input.accountId,
        clientId: account.client_id,
        meta: input.meta,
        details: { external_site: input.site },
      });
    await tx.query("COMMIT");
    return {
      account_id: input.accountId,
      external_site: input.site,
      allowed: !input.revoke,
      changed: !!changed.rowCount,
    };
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}
