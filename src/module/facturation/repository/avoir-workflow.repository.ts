import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  assertAvoirTransition,
  assertSeparationOfDuties,
  financePreviewHash,
  type AvoirWorkflowStatus,
} from "../domain/finance-policy";
import {
  computeExactDocumentTotals,
  computeExactLineTotals,
  parseDecimal,
} from "../domain/decimal-money";
import type {
  AvoirPreview,
  AvoirPreviewLine,
  FinanceCommandResult,
} from "../types/workflow.types";
import type {
  AvoirPreviewBodyDTO,
  CreateAvoirDraftBodyDTO,
  ValidationDecisionBodyDTO,
  WorkflowConfirmationBodyDTO,
} from "../validators/workflow.validators";
import {
  acquireFinanceIdempotency,
  allocateLegalNumber,
  type FinanceActorContext,
  insertFinanceEvent,
  insertFinanceOutbox,
  insertGlobalFinanceAudit,
  newCorrelationId,
  nextLegacyId,
  saveFinanceReceipt,
} from "./workflow.repository.shared";

type AvoirSourceRow = {
  facture_id: string;
  facture_number: string;
  facture_status: string;
  client_id: string;
  currency: string;
  client_snapshot: Record<string, unknown>;
  issuer_snapshot: Record<string, unknown>;
  legal_entity_code: string;
  facture_line_id: string;
  designation: string;
  code_piece: string | null;
  quantity_invoiced: string;
  quantity_already_credited: string;
  unit: string | null;
  unit_price_ex_tax: string;
  discount_percent: string;
  tax_rate_percent: string;
};

export type AvoirDocumentSnapshot = {
  document_type: "AVOIR";
  uuid: string;
  draft_reference: string;
  legal_number: string;
  issue_date: string;
  facture_id: number;
  facture_number: string;
  currency: string;
  client_snapshot: Record<string, unknown>;
  issuer_snapshot: Record<string, unknown>;
  reason_code: string;
  reason: string;
  lines: AvoirPreviewLine[];
  totals: AvoirPreview["totals"];
};

export type AvoirDocumentArtifact = {
  documentId: string;
  fileName: string;
  checksumSha256: string;
  fileSizeBytes: number;
  cleanup: () => Promise<void>;
};

export type AvoirDocumentWriter = (
  snapshot: AvoirDocumentSnapshot
) => Promise<AvoirDocumentArtifact>;

async function loadAvoirSources(
  factureId: number,
  client?: PoolClient,
  lock = false
): Promise<AvoirSourceRow[]> {
  const queryer = client ?? pool;
  if (lock && client) {
    await client.query(
      `SELECT id FROM public.facture_ligne WHERE facture_id = $1 ORDER BY id FOR UPDATE`,
      [factureId]
    );
  }
  const result = await queryer.query<AvoirSourceRow>(
    `
      SELECT
        f.id::text AS facture_id,
        f.numero AS facture_number,
        f.statut AS facture_status,
        f.client_id,
        COALESCE(f.currency, 'EUR') AS currency,
        COALESCE(f.client_snapshot, '{}'::jsonb) AS client_snapshot,
        COALESCE(f.issuer_snapshot, '{}'::jsonb) AS issuer_snapshot,
        COALESCE(f.legal_entity_code, '') AS legal_entity_code,
        fl.id::text AS facture_line_id,
        fl.designation,
        fl.code_piece,
        fl.quantite::numeric(18,3)::text AS quantity_invoiced,
        COALESCE(credited.quantity, 0)::numeric(18,3)::text AS quantity_already_credited,
        fl.unite AS unit,
        fl.prix_unitaire_ht::numeric(18,4)::text AS unit_price_ex_tax,
        COALESCE(fl.remise_ligne, 0)::numeric(9,4)::text AS discount_percent,
        COALESCE(fl.taux_tva, 0)::numeric(9,4)::text AS tax_rate_percent
      FROM public.facture f
      JOIN public.facture_ligne fl ON fl.facture_id = f.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(source.quantity_credited), 0) AS quantity
        FROM public.avoir_source_allocations source
        WHERE source.facture_line_id = fl.id
          AND source.allocation_status = 'CONSUMED'
      ) credited ON TRUE
      WHERE f.id = $1
      ORDER BY fl.ordre, fl.id
    `,
    [factureId]
  );
  return result.rows;
}

async function buildAvoirPreview(
  input: AvoirPreviewBodyDTO,
  client?: PoolClient,
  lock = false
): Promise<AvoirPreview> {
  const rows = await loadAvoirSources(input.facture_id, client, lock);
  if (rows.length === 0) {
    throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture ou lignes de facture introuvables.");
  }
  const header = rows[0]!;
  if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(header.facture_status)) {
    throw new HttpError(
      409,
      "AVOIR_FACTURE_NOT_ISSUED",
      "Un avoir ne peut corriger qu'une facture émise."
    );
  }

  const byId = new Map(rows.map((row) => [Number.parseInt(row.facture_line_id, 10), row]));
  const seen = new Set<number>();
  const lines: AvoirPreviewLine[] = [];

  for (const selection of input.lines) {
    if (seen.has(selection.facture_line_id)) {
      throw new HttpError(
        422,
        "AVOIR_LINE_DUPLICATED",
        "Une ligne de facture ne peut être sélectionnée qu'une fois."
      );
    }
    seen.add(selection.facture_line_id);
    const row = byId.get(selection.facture_line_id);
    if (!row) {
      throw new HttpError(
        422,
        "AVOIR_LINE_NOT_IN_FACTURE",
        "La ligne sélectionnée n'appartient pas à la facture."
      );
    }
    const invoiced = parseDecimal(row.quantity_invoiced, 3, "Quantité facturée");
    const credited = parseDecimal(row.quantity_already_credited, 3, "Quantité déjà créditée");
    const selected = parseDecimal(selection.quantity, 3, "Quantité créditée");
    const remaining = invoiced - credited;
    if (selected <= 0n || selected > remaining) {
      throw new HttpError(
        409,
        "AVOIR_QUANTITY_EXCEEDS_REMAINING",
        "La quantité d'avoir dépasse la quantité encore créditable."
      );
    }
    const totals = computeExactLineTotals({
      quantity: selection.quantity,
      unitPriceExTax: row.unit_price_ex_tax,
      discountPercent: row.discount_percent,
      taxRatePercent: row.tax_rate_percent,
    });
    lines.push({
      facture_line_id: selection.facture_line_id,
      designation: row.designation,
      code_piece: row.code_piece,
      quantity_invoiced: row.quantity_invoiced,
      quantity_already_credited: row.quantity_already_credited,
      quantity_remaining: `${remaining / 1000n}.${(remaining % 1000n)
        .toString()
        .padStart(3, "0")}`,
      quantity_selected: selection.quantity,
      unit: row.unit,
      unit_price_ex_tax: row.unit_price_ex_tax,
      discount_percent: row.discount_percent,
      tax_rate_percent: row.tax_rate_percent,
      total_ex_tax: totals.totalExTax,
      tax_amount: totals.taxAmount,
      total_incl_tax: totals.totalInclTax,
    });
  }

  const totals = computeExactDocumentTotals(
    lines.map((line) => ({
      quantity: line.quantity_selected,
      unitPriceExTax: line.unit_price_ex_tax,
      discountPercent: line.discount_percent,
      taxRatePercent: line.tax_rate_percent,
    })),
    "0"
  );
  const unsigned = {
    preview_version: 1 as const,
    facture_id: input.facture_id,
    facture_number: header.facture_number,
    client_id: header.client_id,
    currency: header.currency,
    reason_code: input.reason_code,
    reason: input.reason,
    lines,
    totals: {
      subtotal_ex_tax: totals.subtotalExTax,
      global_discount_percent: totals.discountPercent,
      global_discount_amount: totals.discountAmount,
      total_ex_tax: totals.totalExTax,
      total_tax: totals.totalTax,
      total_incl_tax: totals.totalInclTax,
    },
    blockers: [],
    warnings: [],
  };
  return { ...unsigned, preview_hash: financePreviewHash(unsigned) };
}

export function repoPreviewAvoir(input: AvoirPreviewBodyDTO): Promise<AvoirPreview> {
  return buildAvoirPreview(input);
}

export async function repoListAvoirEligibleLines(factureId: number): Promise<{
  facture_id: number;
  facture_number: string;
  client_id: string;
  currency: string;
  lines: Array<{
    facture_line_id: number;
    designation: string;
    code_piece: string | null;
    unit: string | null;
    quantity_invoiced: string;
    quantity_already_credited: string;
    quantity_remaining: string;
    eligible: boolean;
  }>;
}> {
  const rows = await loadAvoirSources(factureId);
  if (rows.length === 0) {
    throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture ou lignes introuvables.");
  }
  const header = rows[0]!;
  if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(header.facture_status)) {
    throw new HttpError(409, "AVOIR_FACTURE_NOT_ISSUED", "La facture n'est pas émise.");
  }
  return {
    facture_id: factureId,
    facture_number: header.facture_number,
    client_id: header.client_id,
    currency: header.currency,
    lines: rows.map((row) => {
      const remaining =
        parseDecimal(row.quantity_invoiced, 3, "Quantité facturée") -
        parseDecimal(row.quantity_already_credited, 3, "Quantité déjà créditée");
      return {
        facture_line_id: Number.parseInt(row.facture_line_id, 10),
        designation: row.designation,
        code_piece: row.code_piece,
        unit: row.unit,
        quantity_invoiced: row.quantity_invoiced,
        quantity_already_credited: row.quantity_already_credited,
        quantity_remaining: `${remaining / 1000n}.${(remaining % 1000n).toString().padStart(3, "0")}`,
        eligible: remaining > 0n,
      };
    }),
  };
}

export async function repoCreateAvoirDraft(params: {
  input: CreateAvoirDraftBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "AVOIR_DRAFT_CREATE",
      requestPayload: params.input,
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const { preview_hash: expectedPreviewHash, ...previewInput } = params.input;
    const preview = await buildAvoirPreview(previewInput, client, true);
    if (preview.preview_hash !== expectedPreviewHash) {
      throw new HttpError(409, "AVOIR_PREVIEW_CHANGED", "L'aperçu de l'avoir a changé.");
    }
    const sources = await loadAvoirSources(params.input.facture_id, client);
    const header = sources[0]!;
    const avoirId = await nextLegacyId(client, "avoir_id_seq");
    const uuid = crypto.randomUUID();
    const draftReference = `AV-DRAFT-${avoirId}`;
    await client.query(
      `
        INSERT INTO public.avoir (
          id, uuid, numero, draft_reference, client_id, facture_id,
          date_emission, statut, motif, reason_code,
          total_ht, total_tax, total_ttc, currency,
          preview_hash, row_version, client_snapshot, issuer_snapshot,
          legal_entity_code, created_by
        )
        VALUES (
          $1,$2::uuid,$3,$3,$4,$5,CURRENT_DATE,'DRAFT',$6,$7,
          $8,$9,$10,$11,$12,1,$13::jsonb,$14::jsonb,$15,$16
        )
      `,
      [
        avoirId,
        uuid,
        draftReference,
        preview.client_id,
        preview.facture_id,
        preview.reason,
        preview.reason_code,
        preview.totals.total_ex_tax,
        preview.totals.total_tax,
        preview.totals.total_incl_tax,
        preview.currency,
        preview.preview_hash,
        JSON.stringify(header.client_snapshot),
        JSON.stringify(header.issuer_snapshot),
        header.legal_entity_code,
        params.actor.userId,
      ]
    );
    for (let index = 0; index < preview.lines.length; index += 1) {
      const line = preview.lines[index]!;
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO public.avoir_ligne (
            avoir_id, ordre, designation, code_piece, quantite, unite,
            prix_unitaire_ht, remise_ligne, taux_tva,
            total_ht, tax_amount, total_ttc, snapshot_json
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
          RETURNING id::text AS id
        `,
        [
          avoirId,
          index + 1,
          line.designation,
          line.code_piece,
          line.quantity_selected,
          line.unit,
          line.unit_price_ex_tax,
          line.discount_percent,
          line.tax_rate_percent,
          line.total_ex_tax,
          line.tax_amount,
          line.total_incl_tax,
          JSON.stringify(line),
        ]
      );
      await client.query(
        `
          INSERT INTO public.avoir_source_allocations (
            avoir_id, avoir_line_id, facture_id, facture_line_id,
            source_type, source_line_id, quantity_selected,
            quantity_credited, amount_ttc, allocation_status, created_by
          )
          VALUES ($1,$2,$3,$4,'INVOICE_LINE',$4::text,$5,0,$6,'DRAFT',$7)
        `,
        [
          avoirId,
          Number.parseInt(inserted.rows[0]!.id, 10),
          preview.facture_id,
          line.facture_line_id,
          line.quantity_selected,
          line.total_incl_tax,
          params.actor.userId,
        ]
      );
    }
    const correlationId = newCorrelationId();
    const result: FinanceCommandResult = {
      id: avoirId,
      uuid,
      draft_reference: draftReference,
      legal_number: null,
      status: "DRAFT",
      row_version: 1,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "AVOIR",
      aggregateId: uuid,
      eventType: "AVOIR_DRAFT_CREATED",
      newValues: { facture_id: preview.facture_id, preview_hash: preview.preview_hash },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
      reason: preview.reason,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "facturation.avoir_draft_created",
      entityType: "avoir",
      entityId: uuid,
      details: { facture_id: preview.facture_id, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: "AVOIR_DRAFT_CREATE",
      aggregateType: "AVOIR",
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

type LockedAvoir = {
  id: number;
  uuid: string;
  statut: AvoirWorkflowStatus;
  row_version: number;
  preview_hash: string;
  created_by: number | null;
  approved_by: number | null;
  draft_reference: string;
  facture_id: number;
  client_snapshot: Record<string, unknown>;
  issuer_snapshot: Record<string, unknown>;
  legal_entity_code: string;
};

async function lockAvoir(client: PoolClient, id: number): Promise<LockedAvoir | null> {
  const result = await client.query<LockedAvoir>(
    `
      SELECT
        id, uuid::text AS uuid, statut, row_version, preview_hash,
        created_by, approved_by, draft_reference, facture_id,
        client_snapshot, issuer_snapshot, legal_entity_code
      FROM public.avoir
      WHERE id = $1
      FOR UPDATE
    `,
    [id]
  );
  return result.rows[0] ?? null;
}

async function savedAvoirInput(client: PoolClient, avoirId: number): Promise<AvoirPreviewBodyDTO> {
  const header = await client.query<{
    facture_id: number;
    reason_code: AvoirPreviewBodyDTO["reason_code"];
    motif: string;
  }>(
    `SELECT facture_id, reason_code, motif FROM public.avoir WHERE id = $1`,
    [avoirId]
  );
  const row = header.rows[0];
  if (!row) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir introuvable.");
  const lines = await client.query<{ facture_line_id: number; quantity: string }>(
    `
      SELECT facture_line_id, quantity_selected::text AS quantity
      FROM public.avoir_source_allocations
      WHERE avoir_id = $1
      ORDER BY avoir_line_id, id
    `,
    [avoirId]
  );
  return {
    facture_id: row.facture_id,
    reason_code: row.reason_code,
    reason: row.motif,
    lines: lines.rows,
  };
}

async function transitionAvoir(params: {
  avoirId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
  commandType: string;
  expectedStatus: AvoirWorkflowStatus;
  targetStatus: AvoirWorkflowStatus;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: params.commandType,
      requestPayload: { avoir_id: params.avoirId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const avoir = await lockAvoir(client, params.avoirId);
    if (!avoir) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir introuvable.");
    if (avoir.statut !== params.expectedStatus || avoir.row_version !== params.input.expected_version) {
      throw new HttpError(409, "AVOIR_CONCURRENT_MODIFICATION", "L'avoir a changé.");
    }
    if (avoir.preview_hash !== params.input.preview_hash) {
      throw new HttpError(409, "AVOIR_PREVIEW_CHANGED", "L'aperçu de l'avoir a changé.");
    }
    assertAvoirTransition(avoir.statut, params.targetStatus);
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.avoir
        SET statut = $2,
            validation_requested_at = now(),
            validation_requested_by = $3,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [params.avoirId, params.targetStatus, params.actor.userId]
    );
    const correlationId = newCorrelationId();
    const result: FinanceCommandResult = {
      id: avoir.id,
      uuid: avoir.uuid,
      draft_reference: avoir.draft_reference,
      legal_number: null,
      status: params.targetStatus,
      row_version: updated.rows[0]!.row_version,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
      eventType: params.commandType,
      oldValues: { status: avoir.statut },
      newValues: { status: params.targetStatus },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: params.commandType,
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
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

export function repoRequestAvoirValidation(params: {
  avoirId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<FinanceCommandResult> {
  return transitionAvoir({
    ...params,
    commandType: "AVOIR_REQUEST_VALIDATION",
    expectedStatus: "DRAFT",
    targetStatus: "PENDING_VALIDATION",
  });
}

export async function repoValidateAvoir(params: {
  avoirId: number;
  input: ValidationDecisionBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const commandType = params.input.decision === "APPROVE" ? "AVOIR_APPROVE" : "AVOIR_RETURN";
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType,
      requestPayload: { avoir_id: params.avoirId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const avoir = await lockAvoir(client, params.avoirId);
    if (!avoir) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir introuvable.");
    if (avoir.statut !== "PENDING_VALIDATION" || avoir.row_version !== params.input.expected_version) {
      throw new HttpError(409, "AVOIR_CONCURRENT_MODIFICATION", "L'avoir a changé.");
    }
    if (params.input.decision === "APPROVE") {
      assertSeparationOfDuties({
        creatorUserId: avoir.created_by,
        validatorUserId: params.actor.userId,
      });
    }
    const target: AvoirWorkflowStatus =
      params.input.decision === "APPROVE" ? "APPROVED" : "DRAFT";
    assertAvoirTransition(avoir.statut, target);
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.avoir
        SET statut = $2,
            approved_at = CASE WHEN $2 = 'APPROVED' THEN now() ELSE NULL END,
            approved_by = CASE WHEN $2 = 'APPROVED' THEN $3 ELSE NULL END,
            validation_reason = $4,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [params.avoirId, target, params.actor.userId, params.input.reason ?? null]
    );
    const correlationId = newCorrelationId();
    const result: FinanceCommandResult = {
      id: avoir.id,
      uuid: avoir.uuid,
      draft_reference: avoir.draft_reference,
      legal_number: null,
      status: target,
      row_version: updated.rows[0]!.row_version,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
      eventType: commandType,
      oldValues: { status: avoir.statut },
      newValues: { status: target },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
      reason: params.input.reason,
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType,
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
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

export async function repoIssueAvoir(params: {
  avoirId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
  writeDocument: AvoirDocumentWriter;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  let artifact: AvoirDocumentArtifact | null = null;
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "AVOIR_ISSUE",
      requestPayload: { avoir_id: params.avoirId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const avoir = await lockAvoir(client, params.avoirId);
    if (!avoir) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir introuvable.");
    if (avoir.statut !== "APPROVED" || avoir.row_version !== params.input.expected_version) {
      throw new HttpError(409, "AVOIR_NOT_APPROVED", "L'avoir doit être validé avant émission.");
    }
    const savedInput = await savedAvoirInput(client, params.avoirId);
    const preview = await buildAvoirPreview(savedInput, client, true);
    if (
      preview.preview_hash !== params.input.preview_hash ||
      preview.preview_hash !== avoir.preview_hash
    ) {
      throw new HttpError(409, "AVOIR_PREVIEW_CHANGED", "L'aperçu de l'avoir a changé.");
    }
    const policy = await client.query<{ policy_version: string; require_distinct_issuer: boolean }>(
      `
        SELECT policy_version, require_distinct_issuer
        FROM public.finance_billing_policies
        WHERE active = TRUE
          AND effective_from <= CURRENT_DATE
          AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
        ORDER BY effective_from DESC, created_at DESC
        LIMIT 1
      `
    );
    const activePolicy = policy.rows[0];
    if (!activePolicy) {
      throw new HttpError(503, "BILLING_POLICY_NOT_ACTIVE", "Politique Finance absente.");
    }
    if (
      activePolicy.require_distinct_issuer &&
      avoir.approved_by !== null &&
      avoir.approved_by === params.actor.userId
    ) {
      throw new HttpError(
        403,
        "FINANCE_ISSUER_VALIDATOR_CONFLICT",
        "La politique active impose un émetteur distinct du valideur."
      );
    }
    const issueDate = new Date().toISOString().slice(0, 10);
    const legal = await allocateLegalNumber({
      client,
      documentType: "AVOIR",
      entityCode: avoir.legal_entity_code,
      issueDate,
    });
    const snapshot: AvoirDocumentSnapshot = {
      document_type: "AVOIR",
      uuid: avoir.uuid,
      draft_reference: avoir.draft_reference,
      legal_number: legal.legalNumber,
      issue_date: issueDate,
      facture_id: preview.facture_id,
      facture_number: preview.facture_number,
      currency: preview.currency,
      client_snapshot: avoir.client_snapshot,
      issuer_snapshot: avoir.issuer_snapshot,
      reason_code: preview.reason_code,
      reason: preview.reason,
      lines: preview.lines,
      totals: preview.totals,
    };
    artifact = await params.writeDocument(snapshot);
    const correlationId = newCorrelationId();
    await client.query(
      `
        UPDATE public.avoir_source_allocations
        SET allocation_status = 'CONSUMED',
            quantity_credited = quantity_selected,
            consumed_at = now(),
            consumed_by = $2
        WHERE avoir_id = $1
          AND allocation_status = 'DRAFT'
      `,
      [params.avoirId, params.actor.userId]
    );
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.avoir
        SET numero = $2,
            legal_number = $2,
            legal_period = $3,
            legal_sequence_value = $4,
            date_emission = $5::date,
            statut = 'ISSUED',
            issued_at = now(),
            issued_by = $6,
            immutable_snapshot = $7::jsonb,
            document_checksum_sha256 = $8,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [
        params.avoirId,
        legal.legalNumber,
        legal.periodKey,
        legal.sequenceValue,
        issueDate,
        params.actor.userId,
        JSON.stringify(snapshot),
        artifact.checksumSha256,
      ]
    );
    await client.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1::uuid,$2,'PDF')`,
      [artifact.documentId, artifact.fileName]
    );
    await client.query(
      `INSERT INTO public.avoir_documents (avoir_id, document_id, type) VALUES ($1,$2::uuid,'LEGAL_PDF')`,
      [params.avoirId, artifact.documentId]
    );
    await client.query(
      `
        INSERT INTO public.finance_document_versions (
          aggregate_type, aggregate_id, document_id, version, status,
          checksum_sha256, file_size_bytes, mime_type, snapshot_json,
          created_by, correlation_id
        )
        VALUES ('AVOIR',$1,$2::uuid,1,'ISSUED',$3,$4,'application/pdf',$5::jsonb,$6,$7::uuid)
      `,
      [
        avoir.uuid,
        artifact.documentId,
        artifact.checksumSha256,
        artifact.fileSizeBytes,
        JSON.stringify(snapshot),
        params.actor.userId,
        correlationId,
      ]
    );
    const result: FinanceCommandResult = {
      id: avoir.id,
      uuid: avoir.uuid,
      draft_reference: avoir.draft_reference,
      legal_number: legal.legalNumber,
      status: "ISSUED",
      row_version: updated.rows[0]!.row_version,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
      eventType: "AVOIR_ISSUED",
      oldValues: { status: avoir.statut },
      newValues: { status: "ISSUED", legal_number: legal.legalNumber },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
      ruleCode: activePolicy.policy_version,
      reason: preview.reason,
    });
    await insertFinanceOutbox({
      client,
      eventKey: `finance.avoir.issued:${avoir.uuid}`,
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
      eventType: "FINANCE.CREDIT_NOTE_ISSUED",
      payload: {
        avoir_uuid: avoir.uuid,
        facture_id: preview.facture_id,
        legal_number: legal.legalNumber,
        total_incl_tax: preview.totals.total_incl_tax,
        currency: preview.currency,
        correlation_id: correlationId,
      },
      correlationId,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "facturation.avoir_issued",
      entityType: "avoir",
      entityId: avoir.uuid,
      details: { facture_id: preview.facture_id, legal_number: legal.legalNumber, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: "AVOIR_ISSUE",
      aggregateType: "AVOIR",
      aggregateId: avoir.uuid,
      requestPayload: params.input,
      resultPayload: result,
      correlationId,
    });
    await client.query("COMMIT");
    artifact = null;
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (artifact) await artifact.cleanup().catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
