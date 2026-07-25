import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  paymentStatusFromAllocation,
  type PaymentStatus,
} from "../domain/finance-policy";
import { formatDecimal, moneyToCents } from "../domain/decimal-money";
import type { PaymentCommandResult } from "../types/workflow.types";
import type {
  AllocatePaymentBodyDTO,
  RegisterPaymentBodyDTO,
} from "../validators/workflow.validators";
import {
  acquireFinanceIdempotency,
  type FinanceActorContext,
  insertFinanceEvent,
  insertFinanceOutbox,
  insertGlobalFinanceAudit,
  newCorrelationId,
  nextLegacyId,
  saveFinanceReceipt,
} from "./workflow.repository.shared";

type LockedPayment = {
  id: number;
  uuid: string;
  code: string;
  client_id: string;
  montant: string;
  currency: string;
  status: PaymentStatus;
  row_version: number;
};

type AllocationInput = RegisterPaymentBodyDTO["allocations"][number];

async function lockPayment(client: PoolClient, paymentId: number): Promise<LockedPayment | null> {
  const result = await client.query<LockedPayment>(
    `
      SELECT
        id, uuid::text AS uuid, code, client_id,
        montant::numeric(18,2)::text AS montant,
        currency, status, row_version
      FROM public.paiement
      WHERE id = $1
      FOR UPDATE
    `,
    [paymentId]
  );
  return result.rows[0] ?? null;
}

async function allocatedPaymentCents(client: PoolClient, paymentId: number): Promise<bigint> {
  const result = await client.query<{ amount: string }>(
    `
      SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2)::text AS amount
      FROM public.paiement_allocations
      WHERE paiement_id = $1
    `,
    [paymentId]
  );
  return moneyToCents(result.rows[0]?.amount ?? "0.00", "Montant alloué");
}

type ResolvedAllocation = {
  targetType: "FACTURE" | "ECHEANCE";
  targetId: string;
  factureId: number;
  dueDateId: string | null;
  amount: string;
};

async function resolveAndValidateAllocations(params: {
  client: PoolClient;
  clientId: string;
  currency: string;
  paymentId: number;
  paymentAvailableCents: bigint;
  allocations: readonly AllocationInput[];
}): Promise<ResolvedAllocation[]> {
  const uniqueTargets = new Set<string>();
  const resolved: ResolvedAllocation[] = [];
  let requestedCents = 0n;

  const sorted = [...params.allocations].sort((left, right) =>
    `${left.target_type}:${left.target_id}`.localeCompare(
      `${right.target_type}:${right.target_id}`
    )
  );

  for (const allocation of sorted) {
    const targetKey = `${allocation.target_type}:${allocation.target_id}`;
    if (uniqueTargets.has(targetKey)) {
      throw new HttpError(
        422,
        "PAYMENT_ALLOCATION_DUPLICATED",
        "Une cible ne peut être allouée qu'une fois par commande."
      );
    }
    uniqueTargets.add(targetKey);
    const amountCents = moneyToCents(allocation.amount, "Montant alloué");
    if (amountCents <= 0n) {
      throw new HttpError(422, "PAYMENT_ALLOCATION_INVALID", "Le montant doit être positif.");
    }
    requestedCents += amountCents;

    let factureId: number;
    let dueDateId: string | null = null;
    let dueAvailableCents: bigint | null = null;
    if (allocation.target_type === "ECHEANCE") {
      const due = await params.client.query<{
        id: string;
        facture_id: number;
        amount_due: string;
        amount_allocated: string;
        status: string;
      }>(
        `
          SELECT
            id::text AS id, facture_id,
            amount_due::numeric(18,2)::text AS amount_due,
            amount_allocated::numeric(18,2)::text AS amount_allocated,
            status
          FROM public.facture_echeance
          WHERE id = $1::uuid
          FOR UPDATE
        `,
        [allocation.target_id]
      );
      const row = due.rows[0];
      if (!row) {
        throw new HttpError(404, "PAYMENT_DUE_DATE_NOT_FOUND", "Échéance introuvable.");
      }
      factureId = row.facture_id;
      dueDateId = row.id;
      dueAvailableCents =
        moneyToCents(row.amount_due, "Échéance") -
        moneyToCents(row.amount_allocated, "Échéance allouée");
      if (row.status === "CANCELLED" || amountCents > dueAvailableCents) {
        throw new HttpError(
          409,
          "PAYMENT_DUE_DATE_EXCEEDED",
          "L'allocation dépasse le solde de l'échéance."
        );
      }
    } else {
      if (!/^\d+$/.test(allocation.target_id)) {
        throw new HttpError(422, "PAYMENT_FACTURE_ID_INVALID", "Identifiant facture invalide.");
      }
      factureId = Number.parseInt(allocation.target_id, 10);
    }

    const facture = await params.client.query<{
      client_id: string;
      currency: string;
      statut: string;
      total_ttc: string;
      settled_ttc: string;
    }>(
      `
        SELECT
          f.client_id,
          COALESCE(f.currency, 'EUR') AS currency,
          f.statut,
          f.total_ttc::numeric(18,2)::text AS total_ttc,
          (
            COALESCE((
              SELECT SUM(pa.amount_ttc)
              FROM public.paiement_allocations pa
              WHERE pa.facture_id = f.id
            ), 0)
            +
            COALESCE((
              SELECT SUM(asa.amount_ttc)
              FROM public.avoir_source_allocations asa
              WHERE asa.facture_id = f.id
                AND asa.allocation_status = 'CONSUMED'
            ), 0)
          )::numeric(18,2)::text AS settled_ttc
        FROM public.facture f
        WHERE f.id = $1
        FOR UPDATE
      `,
      [factureId]
    );
    const invoice = facture.rows[0];
    if (!invoice) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
    if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(invoice.statut)) {
      throw new HttpError(
        409,
        "PAYMENT_FACTURE_NOT_ISSUED",
        "Un paiement ne peut être alloué qu'à une facture émise."
      );
    }
    if (invoice.client_id !== params.clientId) {
      throw new HttpError(
        422,
        "PAYMENT_CLIENT_MISMATCH",
        "Le paiement et la facture doivent appartenir au même client."
      );
    }
    if (invoice.currency !== params.currency) {
      throw new HttpError(
        422,
        "PAYMENT_CURRENCY_MISMATCH",
        "Le paiement et la facture doivent avoir la même devise."
      );
    }
    const invoiceAvailableCents =
      moneyToCents(invoice.total_ttc, "Total facture") -
      moneyToCents(invoice.settled_ttc, "Total réglé");
    if (amountCents > invoiceAvailableCents) {
      throw new HttpError(
        409,
        "PAYMENT_INVOICE_BALANCE_EXCEEDED",
        "L'allocation dépasse le solde de la facture."
      );
    }
    resolved.push({
      targetType: allocation.target_type,
      targetId: allocation.target_id,
      factureId,
      dueDateId,
      amount: allocation.amount,
    });
  }

  if (requestedCents > params.paymentAvailableCents) {
    throw new HttpError(
      409,
      "PAYMENT_AMOUNT_EXCEEDED",
      "Les allocations dépassent le montant disponible du paiement."
    );
  }
  return resolved;
}

async function insertAllocations(params: {
  client: PoolClient;
  paymentId: number;
  actor: FinanceActorContext;
  correlationId: string;
  allocations: readonly ResolvedAllocation[];
}): Promise<void> {
  for (const allocation of params.allocations) {
    await params.client.query(
      `
        INSERT INTO public.paiement_allocations (
          paiement_id, facture_id, facture_due_date_id,
          amount_ttc, created_by, correlation_id
        )
        VALUES ($1,$2,$3::uuid,$4,$5,$6::uuid)
      `,
      [
        params.paymentId,
        allocation.factureId,
        allocation.dueDateId,
        allocation.amount,
        params.actor.userId,
        params.correlationId,
      ]
    );
    if (allocation.dueDateId) {
      await params.client.query(
        `
          UPDATE public.facture_echeance
          SET amount_allocated = amount_allocated + $2,
              status = CASE
                WHEN amount_allocated + $2 >= amount_due THEN 'PAID'
                WHEN amount_allocated + $2 > 0 THEN 'PARTIALLY_PAID'
                ELSE status
              END
          WHERE id = $1::uuid
        `,
        [allocation.dueDateId, allocation.amount]
      );
    }
  }
}

function paymentResult(params: {
  payment: LockedPayment;
  allocatedCents: bigint;
  correlationId: string;
  replay: boolean;
}): PaymentCommandResult {
  const amountCents = moneyToCents(params.payment.montant, "Montant du paiement");
  return {
    id: params.payment.id,
    uuid: params.payment.uuid,
    code: params.payment.code,
    status: paymentStatusFromAllocation({
      paymentCents: amountCents,
      allocatedCents: params.allocatedCents,
    }),
    row_version: params.payment.row_version,
    amount: formatDecimal(amountCents, 2),
    allocated_amount: formatDecimal(params.allocatedCents, 2),
    available_amount: formatDecimal(amountCents - params.allocatedCents, 2),
    correlation_id: params.correlationId,
    idempotent_replay: params.replay,
  };
}

export async function repoRegisterPayment(params: {
  input: RegisterPaymentBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<PaymentCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "PAYMENT_REGISTER",
      requestPayload: params.input,
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as PaymentCommandResult), idempotent_replay: true };
    }
    const amountCents = moneyToCents(params.input.amount, "Montant du paiement");
    if (amountCents <= 0n) {
      throw new HttpError(422, "PAYMENT_AMOUNT_INVALID", "Le montant doit être positif.");
    }
    const clientExists = await client.query(
      `SELECT 1 FROM public.clients WHERE client_id = $1`,
      [params.input.client_id]
    );
    if ((clientExists.rowCount ?? 0) === 0) {
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
    }
    const id = await nextLegacyId(client, "paiement_id_seq");
    const uuid = crypto.randomUUID();
    const code = `PAY-${new Date().getUTCFullYear()}-${String(id).padStart(6, "0")}`;
    const correlationId = newCorrelationId();
    const allocations = await resolveAndValidateAllocations({
      client,
      clientId: params.input.client_id,
      currency: params.input.currency,
      paymentId: id,
      paymentAvailableCents: amountCents,
      allocations: params.input.allocations,
    });
    const firstFactureId = allocations[0]?.factureId ?? null;
    await client.query(
      `
        INSERT INTO public.paiement (
          id, uuid, code, facture_id, client_id, date_paiement,
          value_date, booking_date, montant, currency, mode, reference,
          commentaire, proof_document_id, status, workflow_status,
          row_version, received_at, received_by, created_by,
          correlation_id, idempotency_key, request_hash
        )
        VALUES (
          $1,$2::uuid,$3,$4,$5,$6::date,$6::date,$7::date,$8,$9,$10,$11,
          $12,$13::uuid,'UNALLOCATED','RECORDED',1,now(),$14,$14,
          $15::uuid,$16,$17
        )
      `,
      [
        id,
        uuid,
        code,
        firstFactureId,
        params.input.client_id,
        params.input.value_date,
        params.input.booking_date,
        params.input.amount,
        params.input.currency,
        params.input.mode,
        params.input.reference,
        params.input.comment ?? null,
        params.input.proof_document_id ?? null,
        params.actor.userId,
        correlationId,
        receipt.idempotencyKey,
        receipt.requestHash,
      ]
    );
    await insertAllocations({
      client,
      paymentId: id,
      actor: params.actor,
      correlationId,
      allocations,
    });
    const allocatedCents = allocations.reduce(
      (sum, allocation) => sum + moneyToCents(allocation.amount, "Montant alloué"),
      0n
    );
    const status = paymentStatusFromAllocation({
      paymentCents: amountCents,
      allocatedCents,
    });
    await client.query(
      `
        UPDATE public.paiement
        SET status = $2,
            workflow_status = CASE WHEN $2 = 'ALLOCATED' THEN 'ALLOCATED' ELSE 'RECORDED' END
        WHERE id = $1
      `,
      [id, status]
    );
    const payment: LockedPayment = {
      id,
      uuid,
      code,
      client_id: params.input.client_id,
      montant: params.input.amount,
      currency: params.input.currency,
      status,
      row_version: 1,
    };
    const result = paymentResult({
      payment,
      allocatedCents,
      correlationId,
      replay: false,
    });
    await insertFinanceEvent({
      client,
      aggregateType: "PAIEMENT",
      aggregateId: uuid,
      eventType: "PAYMENT_REGISTERED",
      newValues: {
        code,
        amount: params.input.amount,
        allocated_amount: result.allocated_amount,
        currency: params.input.currency,
      },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
    });
    await insertFinanceOutbox({
      client,
      eventKey: `finance.payment.registered:${uuid}`,
      aggregateType: "PAIEMENT",
      aggregateId: uuid,
      eventType: "FINANCE.PAYMENT_REGISTERED",
      payload: {
        payment_uuid: uuid,
        code,
        amount: params.input.amount,
        allocated_amount: result.allocated_amount,
        currency: params.input.currency,
        correlation_id: correlationId,
      },
      correlationId,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "facturation.payment_registered",
      entityType: "paiement",
      entityId: uuid,
      details: { code, allocation_count: allocations.length, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: "PAYMENT_REGISTER",
      aggregateType: "PAIEMENT",
      aggregateId: uuid,
      requestPayload: params.input,
      resultPayload: result,
      correlationId,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoAllocatePayment(params: {
  paymentId: number;
  input: AllocatePaymentBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<PaymentCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "PAYMENT_ALLOCATE",
      requestPayload: { payment_id: params.paymentId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as PaymentCommandResult), idempotent_replay: true };
    }
    const payment = await lockPayment(client, params.paymentId);
    if (!payment) throw new HttpError(404, "PAYMENT_NOT_FOUND", "Paiement introuvable.");
    if (["REJECTED", "REVERSED"].includes(payment.status)) {
      throw new HttpError(409, "PAYMENT_IMMUTABLE", "Ce paiement ne peut plus être alloué.");
    }
    if (payment.row_version !== params.input.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le paiement a changé.");
    }
    const amountCents = moneyToCents(payment.montant, "Montant du paiement");
    const alreadyAllocated = await allocatedPaymentCents(client, payment.id);
    const allocations = await resolveAndValidateAllocations({
      client,
      clientId: payment.client_id,
      currency: payment.currency,
      paymentId: payment.id,
      paymentAvailableCents: amountCents - alreadyAllocated,
      allocations: params.input.allocations,
    });
    const correlationId = newCorrelationId();
    await insertAllocations({
      client,
      paymentId: payment.id,
      actor: params.actor,
      correlationId,
      allocations,
    });
    const newlyAllocated = allocations.reduce(
      (sum, allocation) => sum + moneyToCents(allocation.amount, "Montant alloué"),
      0n
    );
    const allocatedCents = alreadyAllocated + newlyAllocated;
    const status = paymentStatusFromAllocation({
      paymentCents: amountCents,
      allocatedCents,
    });
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.paiement
        SET status = $2,
            workflow_status = CASE WHEN $2 = 'ALLOCATED' THEN 'ALLOCATED' ELSE 'RECORDED' END,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [payment.id, status]
    );
    const result = paymentResult({
      payment: { ...payment, status, row_version: updated.rows[0]!.row_version },
      allocatedCents,
      correlationId,
      replay: false,
    });
    await insertFinanceEvent({
      client,
      aggregateType: "PAIEMENT",
      aggregateId: payment.uuid,
      eventType: "PAYMENT_ALLOCATED",
      oldValues: { allocated_amount: formatDecimal(alreadyAllocated, 2) },
      newValues: { allocated_amount: result.allocated_amount, status },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "facturation.payment_allocated",
      entityType: "paiement",
      entityId: payment.uuid,
      details: { allocation_count: allocations.length, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: "PAYMENT_ALLOCATE",
      aggregateType: "PAIEMENT",
      aggregateId: payment.uuid,
      requestPayload: params.input,
      resultPayload: result,
      correlationId,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
