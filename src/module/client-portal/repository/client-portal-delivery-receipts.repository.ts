import pool from "../../../config/database";
import crypto from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import type {
  ClientPortalIdentity,
  ClientPortalRequestMeta,
} from "../types/client-portal.types";
import { repoInsertPortalAudit } from "./client-portal.repository";

export async function repoCreatePortalDeliveryReceipt(input: {
  identity: ClientPortalIdentity;
  deliveryId: string;
  idempotencyKey: string;
  deliveredAt: string;
  receivedByName: string | null;
  note: string | null;
  lines: Array<{
    delivery_line_id: string;
    delivery_allocation_id?: string;
    quantity_received: number;
  }>;
  meta: ClientPortalRequestMeta;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          deliveryId: input.deliveryId,
          deliveredAt: input.deliveredAt,
          lines: input.lines,
          receivedByName: input.receivedByName,
          note: input.note,
        }),
      )
      .digest("hex");
    const existing = await tx.query<{
      id: string;
      bon_livraison_id: string;
      delivered_at: string;
      request_hash: string;
    }>(
      `SELECT id::text,bon_livraison_id::text,delivered_at::text,request_hash FROM public.client_portal_delivery_receipts WHERE account_id=$1::uuid AND idempotency_key=$2::uuid FOR UPDATE`,
      [input.identity.accountId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash)
        throw new HttpError(
          409,
          "CLIENT_PORTAL_IDEMPOTENCY_CONFLICT",
          "Cette clé a déjà été utilisée avec une autre demande.",
        );
      const { request_hash, ...receipt } = existing.rows[0];
      await tx.query("COMMIT");
      return { receipt, replayed: true };
    }
    const delivery = await tx.query<{ id: string }>(
      `SELECT bl.id::text FROM public.bon_livraison bl
       WHERE bl.id=$1::uuid AND bl.client_id=$2 AND bl.statut IN ('SHIPPED','DELIVERED')
         AND EXISTS(SELECT 1 FROM public.client_portal_delivery_site_bindings binding WHERE binding.account_id=$3::uuid AND binding.delivery_address_id=bl.adresse_livraison_id)
       FOR SHARE`,
      [input.deliveryId, input.identity.clientId, input.identity.accountId],
    );
    if (!delivery.rows[0])
      throw new HttpError(
        404,
        "CLIENT_PORTAL_DELIVERY_NOT_FOUND",
        "Bon de livraison introuvable.",
      );
    const inserted = await tx.query<{
      id: string;
      bon_livraison_id: string;
      delivered_at: string;
    }>(
      `INSERT INTO public.client_portal_delivery_receipts(bon_livraison_id,account_id,idempotency_key,delivered_at,received_by_name,note,request_id)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5,$6,$7,$8) RETURNING id::text,bon_livraison_id::text,delivered_at::text`,
      [
        input.deliveryId,
        input.identity.accountId,
        input.idempotencyKey,
        input.deliveredAt,
        input.receivedByName,
        input.note,
        input.meta.requestId,
        requestHash,
      ],
    );
    const receipt = inserted.rows[0];
    if (!receipt) throw new Error("PORTAL_DELIVERY_RECEIPT_INSERT_FAILED");
    for (const line of input.lines) {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`,
        [line.delivery_line_id],
      );
      const permitted = await tx.query<{ quantity: string; received: string }>(
        `SELECT line.quantite::text AS quantity,COALESCE((SELECT sum(rline.quantity_received) FROM public.client_portal_delivery_receipt_lines rline JOIN public.client_portal_delivery_receipts r ON r.id=rline.receipt_id WHERE r.bon_livraison_id=line.bon_livraison_id AND rline.bon_livraison_ligne_id=line.id),0)::text AS received
           FROM public.bon_livraison_ligne line WHERE line.id=$1::uuid AND line.bon_livraison_id=$2::uuid FOR UPDATE`,
        [line.delivery_line_id, input.deliveryId],
      );
      const current = permitted.rows[0];
      if (
        !current ||
        Number(current.received) + line.quantity_received >
          Number(current.quantity) + 1e-9
      )
        throw new HttpError(
          409,
          "CLIENT_PORTAL_RECEIPT_QUANTITY_EXCEEDED",
          "La quantité reçue dépasse la quantité expédiée.",
        );
      await tx.query(
        `INSERT INTO public.client_portal_delivery_receipt_lines(receipt_id,bon_livraison_ligne_id,quantity_received) VALUES($1::uuid,$2::uuid,$3)`,
        [receipt.id, line.delivery_line_id, line.quantity_received],
      );
      if (line.delivery_allocation_id) {
        const allocation = await tx.query(
          `SELECT 1 FROM public.bon_livraison_ligne_allocations WHERE id=$1::uuid AND bon_livraison_ligne_id=$2::uuid FOR SHARE`,
          [line.delivery_allocation_id, line.delivery_line_id],
        );
        if (!allocation.rowCount)
          throw new HttpError(
            409,
            "CLIENT_PORTAL_RECEIPT_ALLOCATION_INVALID",
            "L'affectation indiquée n'appartient pas à cette ligne de livraison.",
          );
        await tx.query(
          `INSERT INTO public.client_portal_delivery_receipt_allocations(receipt_id,bon_livraison_ligne_allocation_id,quantity_received) VALUES($1::uuid,$2::uuid,$3)`,
          [receipt.id, line.delivery_allocation_id, line.quantity_received],
        );
      }
    }
    await repoInsertPortalAudit(tx, {
      actor: { kind: "PORTAL_ACCOUNT", id: input.identity.accountId },
      action: "CLIENT_PORTAL_DELIVERY_RECEIPT_CONFIRMED",
      entityType: "bon_livraison",
      entityId: input.deliveryId,
      clientId: input.identity.clientId,
      meta: input.meta,
      details: { receipt_id: receipt.id, line_count: input.lines.length },
    });
    await tx.query("COMMIT");
    return { receipt, replayed: false };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
