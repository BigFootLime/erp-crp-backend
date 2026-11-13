import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { readCrmClient } from "../../client/repository/client-crm.repository";

const projection = `SELECT o.contract_id::text, o.number::text, o.opened_at, o.opened_version,
    o.reference_at_open, c.client_id, c.reference, c.title, c.status, cl.company_name
  FROM public.client_open_orders o
  JOIN public.client_contracts c ON c.id=o.contract_id
  JOIN public.clients cl ON cl.client_id=c.client_id`;

export async function listOpenOrders(clientId: string | null, page: number) {
  const { rows } = await pool.query(
    `${projection}
    WHERE ($1::text IS NULL OR c.client_id=$1)
    ORDER BY o.number DESC LIMIT 26 OFFSET $2`,
    [clientId, (page - 1) * 25],
  );
  return { items: rows.slice(0, 25), has_more: rows.length > 25 };
}

// The contract supplies forecasts, firm calls and stock preparation. Opening its envelope
// writes no sales lines or workflow checkpoints that another module could turn into an OF.
export async function openContractOrder(
  clientId: string,
  contractId: string,
  version: number,
  actor: number,
) {
  const connection = await pool.connect();
  return withRealtimeOutboxTransaction(connection, async (tx) => {
    const client = await readCrmClient(tx, clientId, true);
    const contract = (
      await tx.query<{
        status: string;
        version: number;
        reference: string;
        in_period: boolean;
      }>(
        `SELECT reference,status,version,(valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE) AS in_period
       FROM public.client_contracts WHERE id=$1 AND client_id=$2 FOR UPDATE`,
        [contractId, clientId],
      )
    ).rows[0];
    if (!contract || !client)
      throw new HttpError(
        404,
        "OPEN_CONTRACT_NOT_FOUND",
        "Contrat introuvable pour ce client.",
      );
    const read = async () =>
      (
        await tx.query(`${projection} WHERE c.id=$1 AND c.client_id=$2`, [
          contractId,
          clientId,
        ])
      ).rows[0];
    const existing = await read();
    if (existing) return { order: existing, created: false };
    if (
      client.blocked ||
      client.archived_at ||
      client.status === "inactif" ||
      contract.status !== "ACTIVE" ||
      !contract.in_period
    )
      throw new HttpError(
        409,
        "OPEN_CONTRACT_INACTIVE",
        "Choisissez un client et un contrat actifs à la date du jour.",
      );
    if (contract.version !== version)
      throw new HttpError(
        409,
        "OPEN_CONTRACT_STALE",
        "Le contrat a changé. Rechargez sa définition.",
      );
    await tx.query(
      `INSERT INTO public.client_open_orders(contract_id,opened_version,reference_at_open,opened_by)
      VALUES($1,$2,$3,$4)`,
      [contractId, version, contract.reference, actor],
    );
    await enqueueEntityChanged(
      tx,
      {
        module: "clients",
        entityType: "CLIENT",
        entityId: clientId,
        action: "updated",
        at: new Date().toISOString(),
        invalidateKeys: ["client:" + clientId, "client-open-orders"],
      },
      { deduplicationKey: "open-order:" + contractId },
    );
    return { order: await read(), created: true };
  });
}
