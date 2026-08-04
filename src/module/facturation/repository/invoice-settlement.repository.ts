import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import {
  invoiceSettlementStatusFromBalance,
  isInvoiceIssuedForSettlement,
} from "../domain/finance-policy";
import { formatDecimal, moneyToCents } from "../domain/decimal-money";
import {
  insertFinanceEvent,
  insertGlobalFinanceAudit,
  type FinanceActorContext,
} from "./workflow.repository.shared";

type InvoiceSettlementHeaderRow = {
  id: number;
  uuid: string | null;
  client_id: string;
  currency: string;
  statut: string;
  document_status: string | null;
  settlement_status: string | null;
  total_ttc: string;
};

type InvoiceSettlementEvidenceRow = {
  allocated_payment_ttc: string;
  legacy_direct_payment_ttc: string;
  consumed_credit_ttc: string;
  legacy_direct_credit_ttc: string;
};

export type LockedInvoiceSettlement = {
  id: number;
  uuid: string | null;
  clientId: string;
  currency: string;
  status: string;
  documentStatus: string | null;
  settlementStatus: string | null;
  totalCents: bigint;
  settledCents: bigint;
  settledAmount: string;
};

/**
 * Source de vérité du solde #469.
 *
 * Les allocations #227 sont prioritaires. Le lien direct historique n'est pris en
 * compte que lorsqu'aucune allocation n'existe pour la pièce concernée, ce qui
 * conserve l'évidence pré-#227 sans jamais la compter deux fois.
 */
export async function lockInvoiceSettlement(
  client: Pick<PoolClient, "query">,
  factureId: number
): Promise<LockedInvoiceSettlement | null> {
  // Le verrou est volontairement une requête dédiée. Sous READ COMMITTED, si
  // elle attend un autre writer, la requête d'agrégats suivante obtient un
  // nouveau snapshot après l'acquisition du verrou.
  const headerResult = await client.query<InvoiceSettlementHeaderRow>(
    `
      SELECT
        f.id,
        f.uuid::text AS uuid,
        f.client_id,
        COALESCE(f.currency, 'EUR') AS currency,
        f.statut,
        f.document_status,
        f.settlement_status,
        f.total_ttc::numeric(18,2)::text AS total_ttc
      FROM public.facture f
      WHERE f.id = $1
      FOR UPDATE
    `,
    [factureId]
  );
  const header = headerResult.rows[0];
  if (!header) return null;

  const evidenceResult = await client.query<InvoiceSettlementEvidenceRow>(
    `
      SELECT
        COALESCE((
          SELECT SUM(pa.amount_ttc)
          FROM public.paiement_allocations pa
          JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id
          WHERE pa.facture_id = f.id
            AND allocated_payment.status NOT IN ('REJECTED','REVERSED')
            AND allocated_payment.workflow_status <> 'REVERSED'
            AND allocated_payment.reversal_of_id IS NULL
        ), 0)::numeric(18,2)::text AS allocated_payment_ttc,
        COALESCE((
          SELECT SUM(p.montant)
          FROM public.paiement p
          WHERE p.facture_id = f.id
            AND p.status NOT IN ('REJECTED','REVERSED')
            AND p.workflow_status <> 'REVERSED'
            AND p.reversal_of_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.paiement_allocations existing_payment_allocation
              WHERE existing_payment_allocation.paiement_id = p.id
            )
        ), 0)::numeric(18,2)::text AS legacy_direct_payment_ttc,
        COALESCE((
          SELECT SUM(asa.amount_ttc)
          FROM public.avoir_source_allocations asa
          WHERE asa.facture_id = f.id
            AND asa.allocation_status = 'CONSUMED'
        ), 0)::numeric(18,2)::text AS consumed_credit_ttc,
        COALESCE((
          SELECT SUM(a.total_ttc)
          FROM public.avoir a
          WHERE a.facture_id = f.id
            AND a.statut IN ('ISSUED','emis','emise','envoyee')
            AND NOT EXISTS (
              SELECT 1
              FROM public.avoir_source_allocations existing_credit_allocation
              WHERE existing_credit_allocation.avoir_id = a.id
            )
        ), 0)::numeric(18,2)::text AS legacy_direct_credit_ttc
      FROM public.facture f
      WHERE f.id = $1
    `,
    [factureId]
  );
  const evidence = evidenceResult.rows[0];
  if (!evidence) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
  const settledCents =
    moneyToCents(evidence.allocated_payment_ttc, "Paiements alloués") +
    moneyToCents(evidence.legacy_direct_payment_ttc, "Paiements historiques") +
    moneyToCents(evidence.consumed_credit_ttc, "Avoirs consommés") +
    moneyToCents(evidence.legacy_direct_credit_ttc, "Avoirs historiques");
  return {
    id: header.id,
    uuid: header.uuid,
    clientId: header.client_id,
    currency: header.currency,
    status: header.statut,
    documentStatus: header.document_status,
    settlementStatus: header.settlement_status,
    totalCents: moneyToCents(header.total_ttc, "Total facture"),
    settledCents,
    settledAmount: formatDecimal(settledCents, 2),
  };
}

export function assertInvoiceIssued(invoice: LockedInvoiceSettlement): void {
  if (
    !isInvoiceIssuedForSettlement({
      documentStatus: invoice.documentStatus,
      legacyStatus: invoice.status,
    })
  ) {
    throw new HttpError(
      409,
      "PAYMENT_FACTURE_NOT_ISSUED",
      "Un règlement ne peut être affecté qu'à une facture émise."
    );
  }
}

export function assertInvoiceCreditWithinBalance(
  invoice: LockedInvoiceSettlement,
  creditCents: bigint
): void {
  if (invoice.settledCents + creditCents > invoice.totalCents) {
    throw new HttpError(
      409,
      "AVOIR_INVOICE_BALANCE_EXCEEDED",
      "L'avoir dépasse le solde encore réglable de la facture."
    );
  }
}

export async function refreshInvoiceSettlementStates(params: {
  client: PoolClient;
  factureIds: readonly number[];
  actor: FinanceActorContext;
  correlationId: string;
  idempotencyKey: string;
}): Promise<void> {
  const factureIds = [...new Set(params.factureIds)].sort((left, right) => left - right);
  let correlationConfigured = false;

  for (const factureId of factureIds) {
    const invoice = await lockInvoiceSettlement(params.client, factureId);
    if (!invoice) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
    assertInvoiceIssued(invoice);
    const settlementStatus = invoiceSettlementStatusFromBalance({
      totalCents: invoice.totalCents,
      settledCents: invoice.settledCents,
    });
    const projectedStatus = settlementStatus === "UNPAID" ? "ISSUED" : settlementStatus;
    if (
      invoice.status === projectedStatus &&
      invoice.documentStatus === "ISSUED" &&
      invoice.settlementStatus === settlementStatus
    ) {
      continue;
    }

    if (!correlationConfigured) {
      await params.client.query(
        `SELECT set_config('cerp.finance_settlement_correlation_id', $1, true)`,
        [params.correlationId]
      );
      correlationConfigured = true;
    }
    await params.client.query(
      `
        UPDATE public.facture
        SET statut = $2,
            document_status = 'ISSUED',
            settlement_status = $3,
            row_version = row_version + 1,
            correlation_id = $4::uuid,
            updated_at = now()
        WHERE id = $1
      `,
      [factureId, projectedStatus, settlementStatus, params.correlationId]
    );
    const aggregateId = invoice.uuid ?? String(factureId);
    await insertFinanceEvent({
      client: params.client,
      aggregateType: "FACTURE",
      aggregateId,
      eventType: "FACTURE_SETTLEMENT_DERIVED",
      oldValues: {
        status: invoice.status,
        settlement_status: invoice.settlementStatus,
      },
      newValues: {
        status: projectedStatus,
        settlement_status: settlementStatus,
        settled_amount: invoice.settledAmount,
        total_amount: formatDecimal(invoice.totalCents, 2),
      },
      actor: params.actor,
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey,
      ruleCode: "FINANCE-SETTLEMENT-469",
    });
    await insertGlobalFinanceAudit({
      client: params.client,
      actor: params.actor,
      action: "facturation.facture_settlement_derived",
      entityType: "facture",
      entityId: aggregateId,
      details: {
        from: invoice.settlementStatus,
        to: settlementStatus,
        settled_amount: invoice.settledAmount,
        total_amount: formatDecimal(invoice.totalCents, 2),
        correlation_id: params.correlationId,
      },
    });
  }
}
