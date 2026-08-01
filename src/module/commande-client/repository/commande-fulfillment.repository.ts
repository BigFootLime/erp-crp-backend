import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";

type Queryable = Pick<PoolClient, "query">;

type FulfillmentState = {
  has_lines: boolean;
  has_ready_delivery: boolean;
  fully_shipped: boolean;
  fully_invoiced: boolean;
};

const INVOICE_LEDGER_STATUSES = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

async function loadCommandeFulfillmentState(
  tx: Queryable,
  commandeId: number
): Promise<FulfillmentState> {
  const result = await tx.query<FulfillmentState>(
    `
      WITH shipped_by_line AS (
        SELECT
          delivery_line.commande_ligne_id,
          COALESCE(SUM(delivery_line.quantite), 0)::numeric AS quantity
        FROM public.bon_livraison_ligne delivery_line
        JOIN public.bon_livraison delivery
          ON delivery.id = delivery_line.bon_livraison_id
        WHERE delivery.commande_id = $1
          AND delivery.statut IN ('SHIPPED', 'DELIVERED')
          AND delivery_line.commande_ligne_id IS NOT NULL
        GROUP BY delivery_line.commande_ligne_id
      ),
      invoiced_by_delivery_line AS (
        SELECT
          source.source_line_id,
          COALESCE(SUM(source.quantity_consumed), 0)::numeric AS quantity
        FROM public.facture_source_allocations source
        JOIN public.facture invoice ON invoice.id = source.facture_id
        WHERE source.source_type = 'DELIVERY_LINE'
          AND source.allocation_status = 'CONSUMED'
          AND invoice.statut = ANY($2::text[])
        GROUP BY source.source_line_id
      )
      SELECT
        EXISTS(
          SELECT 1
          FROM public.commande_ligne line
          WHERE line.commande_id = $1
        ) AS has_lines,
        EXISTS(
          SELECT 1
          FROM public.bon_livraison delivery
          WHERE delivery.commande_id = $1
            AND delivery.statut IN ('READY', 'SHIPPED', 'DELIVERED')
        ) AS has_ready_delivery,
        NOT EXISTS(
          SELECT 1
          FROM public.commande_ligne line
          LEFT JOIN shipped_by_line shipped ON shipped.commande_ligne_id = line.id
          WHERE line.commande_id = $1
            AND COALESCE(shipped.quantity, 0) + 0.000000001 < line.quantite
        ) AS fully_shipped,
        NOT EXISTS(
          SELECT 1
          FROM public.bon_livraison_ligne delivery_line
          JOIN public.bon_livraison delivery
            ON delivery.id = delivery_line.bon_livraison_id
          LEFT JOIN invoiced_by_delivery_line invoiced
            ON invoiced.source_line_id = delivery_line.id::text
          WHERE delivery.commande_id = $1
            AND delivery.statut IN ('SHIPPED', 'DELIVERED')
            AND COALESCE(invoiced.quantity, 0) + 0.000000001 < delivery_line.quantite
        ) AS fully_invoiced
    `,
    [commandeId, [...INVOICE_LEDGER_STATUSES]]
  );

  const state = result.rows[0] ?? {
    has_lines: false,
    has_ready_delivery: false,
    fully_shipped: false,
    fully_invoiced: false,
  };
  return {
    ...state,
    fully_shipped: state.has_lines && state.fully_shipped,
    fully_invoiced: state.has_lines && state.fully_shipped && state.fully_invoiced,
  };
}

export async function assertCommandeHasActiveOf(tx: Queryable, commandeId: number): Promise<void> {
  const linkedOf = await tx.query<{ exists: boolean }>(
    `
      SELECT EXISTS(
        SELECT 1
        FROM public.ordres_fabrication
        WHERE commande_id = $1
          AND statut::text <> 'ANNULE'
      ) AS exists
    `,
    [commandeId]
  );
  if (linkedOf.rows[0]?.exists !== true) {
    throw new HttpError(
      409,
      "PLANNING_REQUIRES_OF",
      "Aucun OF actif n'est lié à cette commande. Relancez le contrôle OLD/NEW et la génération avant de valider le planning."
    );
  }
}

export async function assertCommandeHasPreparedDelivery(
  tx: Queryable,
  commandeId: number
): Promise<void> {
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.has_ready_delivery) {
    throw new HttpError(
      409,
      "DELIVERY_PREPARATION_REQUIRED",
      "Aucun bon de livraison prêt n'est lié à cette commande. Préparez le BL et ses réservations avant ce changement de statut."
    );
  }
}

export async function assertCommandeFullyShipped(
  tx: Queryable,
  commandeId: number
): Promise<void> {
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.fully_shipped) {
    throw new HttpError(
      409,
      "DELIVERY_NOT_COMPLETE",
      "La commande ne peut pas être déclarée livrée : toutes les quantités doivent d'abord sortir du stock via un BL expédié."
    );
  }
}

export async function assertCommandeFullyInvoiced(
  tx: Queryable,
  commandeId: number
): Promise<void> {
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.fully_invoiced) {
    throw new HttpError(
      409,
      "INVOICE_NOT_COMPLETE",
      "La commande ne peut pas être déclarée facturée : toutes les lignes expédiées doivent être couvertes par une facture émise."
    );
  }
}

async function insertAutomaticHistory(params: {
  tx: Queryable;
  commande_id: number;
  user_id: number;
  old_status: string;
  new_status: "LIVRE" | "FACTURE";
  comment: string;
}): Promise<void> {
  if (params.old_status === params.new_status) return;
  await params.tx.query(
    `
      INSERT INTO public.commande_historique (
        commande_id, user_id, ancien_statut, nouveau_statut, commentaire
      ) VALUES ($1,$2,$3,$4,$5)
    `,
    [
      params.commande_id,
      params.user_id,
      params.old_status,
      params.new_status,
      params.comment,
    ]
  );
}

export async function syncCommandeAfterShipment(
  tx: Queryable,
  commandeId: number,
  userId: number
): Promise<{ advanced: boolean; status: string | null }> {
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.fully_shipped) return { advanced: false, status: null };

  const header = await tx.query<{ statut: string; order_type: string | null }>(
    `
      SELECT statut, order_type
      FROM public.commande_client
      WHERE id = $1
      FOR UPDATE
    `,
    [commandeId]
  );
  const current = header.rows[0] ?? null;
  if (!current) return { advanced: false, status: null };
  if (["FACTURE", "ARCHIVE"].includes(current.statut)) {
    return { advanced: false, status: current.statut };
  }
  if (!["PRET_LIVRAISON", "LIVRE"].includes(current.statut)) {
    throw new HttpError(
      409,
      "COMMAND_NOT_READY_FOR_DELIVERY",
      "L'expédition complète est bloquée tant que le workflow commande n'a pas atteint Prêt pour livraison."
    );
  }

  await tx.query(
    `
      UPDATE public.commande_client
      SET statut = 'LIVRE', updated_at = now()
      WHERE id = $1
    `,
    [commandeId]
  );
  await insertAutomaticHistory({
    tx,
    commande_id: commandeId,
    user_id: userId,
    old_status: current.statut,
    new_status: "LIVRE",
    comment: "Statut synchronisé automatiquement après sortie de stock complète et expédition du BL",
  });

  const internalOrder = String(current.order_type ?? "").toUpperCase() === "INTERNE";
  await tx.query(
    `
      UPDATE public.commande_client_workflow_checkpoint
      SET
        status = CASE
          WHEN checkpoint_code = 'delivery' THEN 'done'
          WHEN checkpoint_code = 'invoicing' THEN $2
          WHEN checkpoint_code = 'archive' AND $2 = 'skipped' THEN 'active'
          ELSE status
        END,
        completed_at = CASE
          WHEN checkpoint_code = 'delivery' THEN COALESCE(completed_at, now())
          WHEN checkpoint_code = 'invoicing' AND $2 = 'skipped' THEN COALESCE(completed_at, now())
          ELSE completed_at
        END,
        completed_by = CASE
          WHEN checkpoint_code = 'delivery' THEN COALESCE(completed_by, $3)
          WHEN checkpoint_code = 'invoicing' AND $2 = 'skipped' THEN COALESCE(completed_by, $3)
          ELSE completed_by
        END,
        metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
        updated_at = now()
      WHERE commande_id = $1
        AND checkpoint_code IN ('delivery', 'invoicing', 'archive')
    `,
    [
      commandeId,
      internalOrder ? "skipped" : "active",
      userId,
      JSON.stringify({ synchronized_from: "delivery_shipped" }),
    ]
  );
  return { advanced: true, status: "LIVRE" };
}

export async function syncCommandeAfterInvoiceIssue(
  tx: Queryable,
  commandeId: number,
  userId: number
): Promise<{ advanced: boolean; status: string | null }> {
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.fully_invoiced) return { advanced: false, status: null };

  const header = await tx.query<{ statut: string }>(
    `SELECT statut FROM public.commande_client WHERE id = $1 FOR UPDATE`,
    [commandeId]
  );
  const current = header.rows[0] ?? null;
  if (!current) return { advanced: false, status: null };
  if (current.statut === "ARCHIVE") return { advanced: false, status: current.statut };
  if (!["LIVRE", "FACTURE"].includes(current.statut)) {
    throw new HttpError(
      409,
      "COMMAND_NOT_READY_FOR_INVOICE",
      "L'émission finale est bloquée tant que la commande n'est pas entièrement livrée."
    );
  }

  await tx.query(
    `UPDATE public.commande_client SET statut = 'FACTURE', updated_at = now() WHERE id = $1`,
    [commandeId]
  );
  await insertAutomaticHistory({
    tx,
    commande_id: commandeId,
    user_id: userId,
    old_status: current.statut,
    new_status: "FACTURE",
    comment: "Statut synchronisé automatiquement après émission complète de la facture",
  });
  await tx.query(
    `
      UPDATE public.commande_client_workflow_checkpoint
      SET
        status = CASE
          WHEN checkpoint_code = 'invoicing' THEN 'done'
          WHEN checkpoint_code = 'archive' THEN 'active'
          ELSE status
        END,
        completed_at = CASE
          WHEN checkpoint_code = 'invoicing' THEN COALESCE(completed_at, now())
          WHEN checkpoint_code = 'archive' THEN NULL
          ELSE completed_at
        END,
        completed_by = CASE
          WHEN checkpoint_code = 'invoicing' THEN COALESCE(completed_by, $2)
          WHEN checkpoint_code = 'archive' THEN NULL
          ELSE completed_by
        END,
        metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
        updated_at = now()
      WHERE commande_id = $1
        AND checkpoint_code IN ('invoicing', 'archive')
    `,
    [commandeId, userId, JSON.stringify({ synchronized_from: "invoice_issued" })]
  );
  return { advanced: true, status: "FACTURE" };
}

export async function listIssuedInvoiceCommandeIds(
  tx: Queryable,
  factureId: number
): Promise<number[]> {
  const result = await tx.query<{ commande_id: number }>(
    `
      SELECT DISTINCT delivery.commande_id::int AS commande_id
      FROM public.facture_source_allocations source
      JOIN public.bon_livraison_ligne delivery_line
        ON source.source_type = 'DELIVERY_LINE'
       AND source.source_line_id = delivery_line.id::text
      JOIN public.bon_livraison delivery
        ON delivery.id = delivery_line.bon_livraison_id
      WHERE source.facture_id = $1
        AND source.allocation_status = 'CONSUMED'
        AND delivery.commande_id IS NOT NULL
      ORDER BY delivery.commande_id
    `,
    [factureId]
  );
  return result.rows.map((row) => Number(row.commande_id)).filter(Number.isInteger);
}
