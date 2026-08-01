import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  listIssuedInvoiceCommandeIds,
  syncCommandeAfterInvoiceIssue,
} from "../../commande-client/repository/commande-fulfillment.repository";
import {
  assertFactureTransition,
  assertSeparationOfDuties,
  financePreviewHash,
  type FactureWorkflowStatus,
} from "../domain/finance-policy";
import {
  computeExactDocumentTotals,
  computeExactLineTotals,
  moneyToCents,
  parseDecimal,
} from "../domain/decimal-money";
import type {
  EligibleDeliverySource,
  FacturePreview,
  FacturePreviewLine,
  FinanceBlocker,
  FinanceCommandResult,
} from "../types/workflow.types";
import type {
  CreateFactureDraftBodyDTO,
  EligibleSourcesQueryDTO,
  FacturePreviewBodyDTO,
  ValidationDecisionBodyDTO,
  WorkflowConfirmationBodyDTO,
} from "../validators/workflow.validators";
import {
  acquireFinanceIdempotency,
  allocateLegalNumber,
  type DbQueryer,
  type FinanceActorContext,
  insertFinanceEvent,
  insertFinanceOutbox,
  insertGlobalFinanceAudit,
  issuerSnapshotAt,
  newCorrelationId,
  nextLegacyId,
  requireFinanceIssuerSnapshotAt,
  saveFinanceReceipt,
} from "./workflow.repository.shared";

type BillingPolicyRow = {
  policy_version: string;
  legal_entity_code: string;
  eligible_delivery_statuses: string[];
  require_distinct_issuer: boolean;
  active: boolean;
};

type DeliverySourceRow = {
  source_id: string;
  source_line_id: string;
  delivery_number: string;
  delivery_status: "SHIPPED" | "DELIVERED";
  client_id: string;
  client_name: string;
  client_blocked: boolean;
  commande_id: string | null;
  affaire_id: string | null;
  commande_line_id: string | null;
  designation: string;
  code_piece: string | null;
  unit: string | null;
  quantity_source: string;
  quantity_already_invoiced: string;
  quantity_already_credited: string;
  unit_price_ex_tax: string | null;
  discount_percent: string | null;
  tax_rate_percent: string | null;
  pricing_version: string | null;
};

export type FinanceDocumentSnapshot = {
  document_type: "FACTURE";
  uuid: string;
  draft_reference: string;
  legal_number: string;
  issue_date: string;
  due_dates: Array<{ due_date: string; label: string; amount: string }>;
  currency: string;
  client_snapshot: Record<string, unknown>;
  issuer_snapshot: Record<string, unknown>;
  lines: FacturePreviewLine[];
  totals: FacturePreview["totals"];
  internal_comment: string | null;
  customer_text: string | null;
};

export type FinanceDocumentArtifact = {
  documentId: string;
  fileName: string;
  checksumSha256: string;
  fileSizeBytes: number;
  cleanup: () => Promise<void>;
};

export type FinanceDocumentWriter = (
  snapshot: FinanceDocumentSnapshot
) => Promise<FinanceDocumentArtifact>;

async function loadActiveBillingPolicy(queryer: DbQueryer): Promise<BillingPolicyRow | null> {
  const result = await queryer.query<BillingPolicyRow>(
    `
      SELECT
        policy_version,
        legal_entity_code,
        eligible_delivery_statuses,
        require_distinct_issuer,
        active
      FROM public.finance_billing_policies
      WHERE active = TRUE
        AND effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1
    `
  );
  return result.rows[0] ?? null;
}

function listWhere(filters: EligibleSourcesQueryDTO): { sql: string; values: unknown[] } {
  const where = [`bl.statut IN ('SHIPPED','DELIVERED')`];
  const values: unknown[] = [];
  const push = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filters.client_id) where.push(`bl.client_id = ${push(filters.client_id)}`);
  if (filters.commande_id) where.push(`bl.commande_id = ${push(filters.commande_id)}::bigint`);
  if (filters.affaire_id) where.push(`bl.affaire_id = ${push(filters.affaire_id)}::bigint`);
  if (filters.q) {
    const parameter = push(`%${filters.q}%`);
    where.push(`(
      bl.numero ILIKE ${parameter}
      OR c.company_name ILIKE ${parameter}
      OR bll.designation ILIKE ${parameter}
      OR COALESCE(bll.code_piece, '') ILIKE ${parameter}
    )`);
  }
  return { sql: `WHERE ${where.join(" AND ")}`, values };
}

const DELIVERY_SOURCE_SELECT = `
  SELECT
    bl.id::text AS source_id,
    bll.id::text AS source_line_id,
    bl.numero AS delivery_number,
    bl.statut AS delivery_status,
    bl.client_id,
    c.company_name AS client_name,
    COALESCE(c.blocked, FALSE) AS client_blocked,
    bl.commande_id::text AS commande_id,
    bl.affaire_id::text AS affaire_id,
    bll.commande_ligne_id::text AS commande_line_id,
    bll.designation,
    bll.code_piece,
    bll.unite AS unit,
    bll.quantite::text AS quantity_source,
    COALESCE(invoiced.quantity, 0)::numeric(18,3)::text AS quantity_already_invoiced,
    COALESCE(credited.quantity, 0)::numeric(18,3)::text AS quantity_already_credited,
    cl.prix_unitaire_ht::numeric(18,4)::text AS unit_price_ex_tax,
    COALESCE(cl.remise_ligne, 0)::numeric(9,4)::text AS discount_percent,
    COALESCE(cl.taux_tva, 0)::numeric(9,4)::text AS tax_rate_percent,
    CASE
      WHEN cl.id IS NULL THEN NULL
      ELSE concat('COMMANDE_LINE:', cl.id::text, ':', COALESCE(cl.updated_at::text, 'unknown'))
    END AS pricing_version
  FROM public.bon_livraison_ligne bll
  JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
  JOIN public.clients c ON c.client_id = bl.client_id
  LEFT JOIN public.commande_ligne cl ON cl.id = bll.commande_ligne_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(source.quantity_consumed), 0) AS quantity
    FROM public.facture_source_allocations source
    WHERE source.source_type = 'DELIVERY_LINE'
      AND source.source_line_id = bll.id::text
      AND source.allocation_status = 'CONSUMED'
  ) invoiced ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(source.quantity_credited), 0) AS quantity
    FROM public.avoir_source_allocations source
    WHERE source.source_type = 'DELIVERY_LINE'
      AND source.source_line_id = bll.id::text
      AND source.allocation_status = 'CONSUMED'
  ) credited ON TRUE
`;

function sourceBlockers(
  row: DeliverySourceRow,
  policy: BillingPolicyRow | null
): FinanceBlocker[] {
  const blockers: FinanceBlocker[] = [];
  if (!policy) {
    blockers.push({
      code: "BILLING_POLICY_NOT_ACTIVE",
      message: "Aucune politique de facturation Finance validée n'est active.",
      source_line_id: row.source_line_id,
    });
  } else if (!policy.eligible_delivery_statuses.includes(row.delivery_status)) {
    blockers.push({
      code: "DELIVERY_STATUS_NOT_ELIGIBLE",
      message: `Le statut ${row.delivery_status} n'est pas autorisé par la politique ${policy.policy_version}.`,
      source_line_id: row.source_line_id,
    });
  }
  if (row.client_blocked) {
    blockers.push({
      code: "CLIENT_BLOCKED",
      message: "Le client est bloqué.",
      source_line_id: row.source_line_id,
    });
  }
  if (!row.commande_line_id || row.unit_price_ex_tax === null) {
    blockers.push({
      code: "PRICING_SOURCE_MISSING",
      message: "La ligne de commande et son prix contractuel sont requis.",
      source_line_id: row.source_line_id,
    });
  }
  const source = parseDecimal(row.quantity_source, 3, "Quantité source");
  const invoiced = parseDecimal(row.quantity_already_invoiced, 3, "Quantité facturée");
  if (source - invoiced <= 0n) {
    blockers.push({
      code: "SOURCE_FULLY_INVOICED",
      message: "La ligne de livraison est déjà intégralement facturée.",
      source_line_id: row.source_line_id,
    });
  }
  return blockers;
}

function mapEligibleSource(
  row: DeliverySourceRow,
  policy: BillingPolicyRow | null
): EligibleDeliverySource {
  const remaining =
    parseDecimal(row.quantity_source, 3, "Quantité source") -
    parseDecimal(row.quantity_already_invoiced, 3, "Quantité facturée");
  return {
    source_type: "DELIVERY_LINE",
    source_id: row.source_id,
    source_line_id: row.source_line_id,
    delivery_number: row.delivery_number,
    delivery_status: row.delivery_status,
    client_id: row.client_id,
    client_name: row.client_name,
    commande_id: row.commande_id ? Number.parseInt(row.commande_id, 10) : null,
    affaire_id: row.affaire_id ? Number.parseInt(row.affaire_id, 10) : null,
    commande_line_id: row.commande_line_id ? Number.parseInt(row.commande_line_id, 10) : null,
    designation: row.designation,
    code_piece: row.code_piece,
    unit: row.unit,
    quantity_source: row.quantity_source,
    quantity_already_invoiced: row.quantity_already_invoiced,
    quantity_already_credited: row.quantity_already_credited,
    quantity_remaining: remaining > 0n ? `${remaining / 1000n}.${(remaining % 1000n).toString().padStart(3, "0")}` : "0.000",
    unit_price_ex_tax: row.unit_price_ex_tax,
    discount_percent: row.discount_percent,
    tax_rate_percent: row.tax_rate_percent,
    pricing_version: row.pricing_version,
    rule_code: policy ? `DELIVERY_${row.delivery_status}:${policy.policy_version}` : "POLICY_REQUIRED",
    blockers: sourceBlockers(row, policy),
  };
}

export async function repoListEligibleFactureSources(
  filters: EligibleSourcesQueryDTO
): Promise<{ items: EligibleDeliverySource[]; total: number; policy_active: boolean }> {
  const policy = await loadActiveBillingPolicy(pool);
  const { sql, values } = listWhere(filters);
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const count = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.bon_livraison_ligne bll
      JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
      JOIN public.clients c ON c.client_id = bl.client_id
      ${sql}
    `,
    values
  );
  const result = await pool.query<DeliverySourceRow>(
    `
      ${DELIVERY_SOURCE_SELECT}
      ${sql}
      ORDER BY bl.date_expedition DESC NULLS LAST, bl.numero DESC, bll.ordre, bll.id
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, (page - 1) * pageSize]
  );
  return {
    items: result.rows.map((row) => mapEligibleSource(row, policy)),
    total: count.rows[0]?.total ?? 0,
    policy_active: Boolean(policy),
  };
}

async function loadSelectedDeliverySources(
  queryer: DbQueryer,
  sourceLineIds: string[],
  lock: boolean
): Promise<DeliverySourceRow[]> {
  if (!sourceLineIds.length) return [];
  const result = await queryer.query<DeliverySourceRow>(
    `
      ${DELIVERY_SOURCE_SELECT}
      WHERE bll.id = ANY($1::uuid[])
        AND bl.statut IN ('SHIPPED','DELIVERED')
      ORDER BY bll.id
      ${lock ? "FOR UPDATE OF bll" : ""}
    `,
    [sourceLineIds]
  );
  return result.rows;
}

function assertDueDates(preview: FacturePreview): void {
  if (preview.due_dates.some((due) => !due.amount)) return;
  const dueTotal = preview.due_dates.reduce(
    (sum, due) => sum + moneyToCents(due.amount, "Montant d'échéance"),
    0n
  );
  const invoiceTotal = moneyToCents(preview.totals.total_incl_tax, "Total TTC");
  if (dueTotal !== invoiceTotal) {
    preview.blockers.push({
      code: "DUE_DATES_TOTAL_MISMATCH",
      message: "La somme des échéances doit être exactement égale au total TTC.",
    });
  }
}

async function buildFacturePreview(
  queryer: DbQueryer,
  input: FacturePreviewBodyDTO,
  lock: boolean
): Promise<{ preview: FacturePreview; policy: BillingPolicyRow | null; sources: DeliverySourceRow[] }> {
  const unsupported = input.sources.filter((source) => source.source_type !== "DELIVERY_LINE");
  const sourceLineIds = input.sources
    .filter((source) => source.source_type === "DELIVERY_LINE")
    .map((source) => source.source_line_id);
  if (new Set(sourceLineIds).size !== sourceLineIds.length) {
    throw new HttpError(422, "DUPLICATE_SOURCE_LINE", "Une ligne source ne peut apparaître qu'une fois.");
  }
  const policy = await loadActiveBillingPolicy(queryer);
  const rows = await loadSelectedDeliverySources(queryer, sourceLineIds, lock);
  const byId = new Map(rows.map((row) => [row.source_line_id, row]));
  const blockers: FinanceBlocker[] = unsupported.map((source) => ({
    code: "SOURCE_TYPE_NOT_ENABLED",
    message: `${source.source_type} reste désactivé jusqu'à validation Finance de sa règle contractuelle.`,
    source_line_id: source.source_line_id,
  }));
  const lines: FacturePreviewLine[] = [];

  for (const selection of input.sources) {
    if (selection.source_type !== "DELIVERY_LINE") continue;
    const row = byId.get(selection.source_line_id);
    if (!row || row.source_id !== selection.source_id) {
      blockers.push({
        code: "SOURCE_NOT_FOUND",
        message: "La source facturable n'existe plus ou ne correspond pas au BL.",
        source_line_id: selection.source_line_id,
      });
      continue;
    }
    blockers.push(...sourceBlockers(row, policy));
    if (row.client_id !== input.client_id) {
      blockers.push({
        code: "SOURCE_CLIENT_MISMATCH",
        message: "Toutes les sources doivent appartenir au client facturé.",
        source_line_id: row.source_line_id,
      });
    }
    const selectedQuantity = parseDecimal(selection.quantity, 3, "Quantité sélectionnée");
    const sourceQuantity = parseDecimal(row.quantity_source, 3, "Quantité source");
    const invoicedQuantity = parseDecimal(row.quantity_already_invoiced, 3, "Quantité facturée");
    if (selectedQuantity > sourceQuantity - invoicedQuantity) {
      blockers.push({
        code: "SOURCE_QUANTITY_EXCEEDED",
        message: "La quantité sélectionnée dépasse le reliquat facturable.",
        source_line_id: row.source_line_id,
      });
    }
    if (!row.unit_price_ex_tax || row.discount_percent === null || row.tax_rate_percent === null) continue;
    const exact = computeExactLineTotals({
      quantity: selection.quantity,
      unitPriceExTax: row.unit_price_ex_tax,
      discountPercent: row.discount_percent,
      taxRatePercent: row.tax_rate_percent,
    });
    lines.push({
      source_type: "DELIVERY_LINE",
      source_id: row.source_id,
      source_line_id: row.source_line_id,
      designation: row.designation,
      code_piece: row.code_piece,
      quantity: selection.quantity,
      unit: row.unit,
      unit_price_ex_tax: row.unit_price_ex_tax,
      discount_percent: row.discount_percent,
      tax_rate_percent: row.tax_rate_percent,
      total_ex_tax: exact.totalExTax,
      tax_amount: exact.taxAmount,
      total_incl_tax: exact.totalInclTax,
      pricing_version: row.pricing_version,
      rule_code: policy ? `DELIVERY_${row.delivery_status}:${policy.policy_version}` : "POLICY_REQUIRED",
    });
  }

  const totals = computeExactDocumentTotals(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPriceExTax: line.unit_price_ex_tax,
      discountPercent: line.discount_percent,
      taxRatePercent: line.tax_rate_percent,
    })),
    input.global_discount_percent
  );
  const dueDates = input.due_dates.map((due) => ({
    ...due,
    amount:
      due.amount ??
      (input.due_dates.length === 1 ? totals.totalInclTax : ""),
  }));
  if (dueDates.some((due) => !due.amount)) {
    blockers.push({
      code: "DUE_DATE_AMOUNT_REQUIRED",
      message: "Chaque montant est requis lorsqu'un échéancier comporte plusieurs échéances.",
    });
  }
  const previewWithoutHash: Omit<FacturePreview, "preview_hash"> = {
    preview_version: 1,
    client_id: input.client_id,
    currency: input.currency,
    lines,
    totals: {
      subtotal_ex_tax: totals.subtotalExTax,
      global_discount_percent: totals.discountPercent,
      global_discount_amount: totals.discountAmount,
      total_ex_tax: totals.totalExTax,
      total_tax: totals.totalTax,
      total_incl_tax: totals.totalInclTax,
    },
    due_dates: dueDates,
    blockers,
    warnings: [
      {
        code: "FINANCE_LEGAL_VALIDATION_REQUIRED",
        message:
          "La fiscalité, les mentions, la séquence et l'archivage restent soumis à validation Finance/Juridique avant production.",
      },
    ],
  };
  const preview: FacturePreview = {
    ...previewWithoutHash,
    preview_hash: financePreviewHash(previewWithoutHash),
  };
  assertDueDates(preview);
  if (preview.blockers.length) {
    preview.preview_hash = financePreviewHash({
      ...previewWithoutHash,
      blockers: preview.blockers,
    });
  }
  return { preview, policy, sources: rows };
}

export async function repoPreviewFacture(input: FacturePreviewBodyDTO): Promise<FacturePreview> {
  return (await buildFacturePreview(pool, input, false)).preview;
}

async function clientSnapshot(queryer: DbQueryer, clientId: string): Promise<Record<string, unknown>> {
  const result = await queryer.query<Record<string, unknown>>(
    `
      SELECT jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'siret', c.siret,
        'vat_number', c.vat_number,
        'billing_address', jsonb_build_object(
          'name', af.name,
          'street', af.street,
          'house_number', af.house_number,
          'address_complement', af.address_complement,
          'postal_code', af.postal_code,
          'city', af.city,
          'country', af.country
        )
      ) AS snapshot
      FROM public.clients c
      LEFT JOIN public.adresse_facturation af ON af.bill_address_id = c.bill_address_id
      WHERE c.client_id = $1
    `,
    [clientId]
  );
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
  }
  return snapshot as Record<string, unknown>;
}

/**
 * Instantane de l'entite emettrice, mentions legales **en vigueur a la date donnee**.
 *
 * L'ancienne version ne figeait que `biller_id` et `biller_name`. Le document sortant ne
 * pouvait donc porter ni SIRET, ni RCS, ni numero de TVA, ni capital, ni taux de penalite —
 * toutes mentions obligatoires. `fn_finance_issuer_snapshot` resout l'identite complete et
 * la version de mentions applicable a `at`, et le resultat est fige tel quel : c'est lui qui
 * fera foi si la facture est contestee dans cinq ans.
 *
 * `at` est la date **d'emission**, pas la date du jour. Les deux different des qu'un
 * brouillon est emis un autre jour que celui ou il a ete cree.
 */
async function issuerSnapshot(
  queryer: DbQueryer,
  entityCode: string,
  at: string
): Promise<Record<string, unknown>> {
  const snapshot = await issuerSnapshotAt(queryer, entityCode, at);
  if (!snapshot) {
    throw new HttpError(
      503,
      "FINANCE_ISSUER_NOT_CONFIGURED",
      "L'entité émettrice de la politique Finance est introuvable."
    );
  }
  return snapshot;
}

function ensurePreviewUsable(preview: FacturePreview, expectedHash: string): void {
  if (preview.preview_hash !== expectedHash) {
    throw new HttpError(
      409,
      "FACTURE_PREVIEW_CHANGED",
      "Les sources, tarifs, taxes ou échéances ont changé depuis l'aperçu.",
      { preview }
    );
  }
  if (preview.blockers.length) {
    throw new HttpError(422, "FACTURE_PREVIEW_BLOCKED", "Le brouillon est bloqué.", {
      blockers: preview.blockers,
    });
  }
}

export async function repoCreateFactureDraft(params: {
  input: CreateFactureDraftBodyDTO;
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
      commandType: "FACTURE_DRAFT_CREATE",
      requestPayload: params.input,
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const { preview_hash: expectedPreviewHash, ...previewInput } = params.input;
    const { preview, policy, sources } = await buildFacturePreview(client, previewInput, true);
    ensurePreviewUsable(preview, expectedPreviewHash);
    if (!policy) throw new HttpError(503, "BILLING_POLICY_NOT_ACTIVE", "Politique Finance absente.");

    const factureId = await nextLegacyId(client, "facture_id_seq");
    const uuidResult = await client.query<{ uuid: string }>("SELECT gen_random_uuid()::text AS uuid");
    const uuid = uuidResult.rows[0]?.uuid;
    if (!uuid) throw new Error("Failed to allocate facture uuid");
    const year = new Date().getUTCFullYear();
    const draftReference = `DFT-${year}-${String(factureId).padStart(6, "0")}`;
    const clientData = await clientSnapshot(client, params.input.client_id);
    // Brouillon : les mentions du jour. Elles seront **re-resolues a l'emission**, seul
    // moment ou la loi les fige (cf. svcIssueFacture).
    const draftDate = new Date().toISOString().slice(0, 10);
    const issuerData = await issuerSnapshot(client, policy.legal_entity_code, draftDate);
    const commandeIds = [...new Set(sources.map((row) => row.commande_id).filter(Boolean))];
    const affaireIds = [...new Set(sources.map((row) => row.affaire_id).filter(Boolean))];
    const dueDate = [...params.input.due_dates].sort((a, b) => a.due_date.localeCompare(b.due_date)).at(-1);

    await client.query(
      `
        INSERT INTO public.facture (
          id, uuid, numero, draft_reference, legal_number, client_id,
          commande_id, affaire_id, date_emission, date_echeance, statut,
          remise_globale, total_ht, total_ttc, total_tax, currency,
          commentaires, customer_text, row_version, preview_hash,
          policy_version, legal_entity_code, client_snapshot, issuer_snapshot,
          created_by
        )
        VALUES (
          $1,$2::uuid,$3,$3,NULL,$4,
          $5::bigint,$6::bigint,CURRENT_DATE,$7::date,'DRAFT',
          $8,$9,$10,$11,$12,
          $13,$14,1,$15,
          $16,$17,$18::jsonb,$19::jsonb,
          $20
        )
      `,
      [
        factureId,
        uuid,
        draftReference,
        params.input.client_id,
        commandeIds.length === 1 ? commandeIds[0] : null,
        affaireIds.length === 1 ? affaireIds[0] : null,
        dueDate?.due_date ?? null,
        preview.totals.global_discount_percent,
        preview.totals.total_ex_tax,
        preview.totals.total_incl_tax,
        preview.totals.total_tax,
        params.input.currency,
        params.input.internal_comment ?? null,
        params.input.customer_text ?? null,
        preview.preview_hash,
        policy.policy_version,
        policy.legal_entity_code,
        JSON.stringify(clientData),
        JSON.stringify(issuerData),
        params.actor.userId,
      ]
    );

    for (let index = 0; index < preview.lines.length; index += 1) {
      const line = preview.lines[index];
      const lineInsert = await client.query<{ id: string }>(
        `
          INSERT INTO public.facture_ligne (
            facture_id, ordre, designation, code_piece, quantite, unite,
            prix_unitaire_ht, remise_ligne, taux_tva, total_ht, total_ttc,
            tax_amount, snapshot_json
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
          RETURNING id::text AS id
        `,
        [
          factureId,
          index + 1,
          line.designation,
          line.code_piece,
          line.quantity,
          line.unit,
          line.unit_price_ex_tax,
          line.discount_percent,
          line.tax_rate_percent,
          line.total_ex_tax,
          line.total_incl_tax,
          line.tax_amount,
          JSON.stringify(line),
        ]
      );
      const factureLineId = lineInsert.rows[0]?.id;
      if (!factureLineId) throw new Error("Failed to insert facture line");
      await client.query(
        `
          INSERT INTO public.facture_source_allocations (
            facture_id, facture_line_id, source_type, source_id, source_line_id,
            quantity_selected, quantity_consumed, amount_ex_tax, amount_incl_tax,
            allocation_status, source_snapshot, rule_code, created_by
          )
          VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'DRAFT',$9::jsonb,$10,$11)
        `,
        [
          factureId,
          factureLineId,
          line.source_type,
          line.source_id,
          line.source_line_id,
          line.quantity,
          line.total_ex_tax,
          line.total_incl_tax,
          JSON.stringify(line),
          line.rule_code,
          params.actor.userId,
        ]
      );
    }
    for (const due of preview.due_dates) {
      await client.query(
        `
          INSERT INTO public.facture_echeance (
            facture_id, due_date, label, amount_due, status, created_by
          )
          VALUES ($1,$2::date,$3,$4,'OPEN',$5)
        `,
        [factureId, due.due_date, due.label, due.amount, params.actor.userId]
      );
    }
    const correlationId = newCorrelationId();
    const result: FinanceCommandResult = {
      id: factureId,
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
      aggregateType: "FACTURE",
      aggregateId: uuid,
      eventType: "FACTURE_DRAFT_CREATED",
      newValues: { preview_hash: preview.preview_hash, source_count: preview.lines.length },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
      ruleCode: policy.policy_version,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "facturation.facture_draft_created",
      entityType: "facture",
      entityId: uuid,
      details: { facture_id: factureId, draft_reference: draftReference, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: "FACTURE_DRAFT_CREATE",
      aggregateType: "FACTURE",
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

async function lockFacture(
  client: PoolClient,
  factureId: number
): Promise<{
  id: number;
  uuid: string;
  statut: FactureWorkflowStatus;
  row_version: number;
  preview_hash: string;
  created_by: number | null;
  approved_by: number | null;
  legal_entity_code: string;
  draft_reference: string;
  client_snapshot: Record<string, unknown>;
  issuer_snapshot: Record<string, unknown>;
  currency: string;
  commentaires: string | null;
  customer_text: string | null;
} | null> {
  const result = await client.query<{
    id: number;
    uuid: string;
    statut: FactureWorkflowStatus;
    row_version: number;
    preview_hash: string;
    created_by: number | null;
    approved_by: number | null;
    legal_entity_code: string;
    draft_reference: string;
    client_snapshot: Record<string, unknown>;
    issuer_snapshot: Record<string, unknown>;
    currency: string;
    commentaires: string | null;
    customer_text: string | null;
  }>(
    `
      SELECT
        id, uuid::text AS uuid, statut, row_version, preview_hash,
        created_by, approved_by, legal_entity_code, draft_reference,
        client_snapshot, issuer_snapshot, currency, commentaires, customer_text
      FROM public.facture
      WHERE id = $1
      FOR UPDATE
    `,
    [factureId]
  );
  return result.rows[0] ?? null;
}

async function savedPreviewInput(client: PoolClient, factureId: number): Promise<FacturePreviewBodyDTO> {
  const header = await client.query<{
    client_id: string;
    currency: string;
    remise_globale: string;
    commentaires: string | null;
    customer_text: string | null;
  }>(
    `
      SELECT client_id, currency, remise_globale::text AS remise_globale, commentaires, customer_text
      FROM public.facture
      WHERE id = $1
    `,
    [factureId]
  );
  const row = header.rows[0];
  if (!row) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
  const sources = await client.query<{
    source_type: "DELIVERY_LINE" | "MILESTONE" | "DEPOSIT";
    source_id: string;
    source_line_id: string;
    quantity: string;
  }>(
    `
      SELECT source_type, source_id, source_line_id, quantity_selected::text AS quantity
      FROM public.facture_source_allocations
      WHERE facture_id = $1
      ORDER BY facture_line_id, id
    `,
    [factureId]
  );
  const dueDates = await client.query<{ due_date: string; amount: string; label: string }>(
    `
      SELECT due_date::text AS due_date, amount_due::text AS amount, label
      FROM public.facture_echeance
      WHERE facture_id = $1
      ORDER BY due_date, id
    `,
    [factureId]
  );
  return {
    client_id: row.client_id,
    currency: row.currency,
    sources: sources.rows,
    global_discount_percent: row.remise_globale,
    due_dates: dueDates.rows,
    internal_comment: row.commentaires,
    customer_text: row.customer_text,
  };
}

export async function repoRequestFactureValidation(params: {
  factureId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<FinanceCommandResult> {
  return transitionFacture({
    ...params,
    commandType: "FACTURE_REQUEST_VALIDATION",
    expectedStatus: "DRAFT",
    targetStatus: "PENDING_VALIDATION",
  });
}

async function transitionFacture(params: {
  factureId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
  commandType: string;
  expectedStatus: FactureWorkflowStatus;
  targetStatus: FactureWorkflowStatus;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: params.commandType,
      requestPayload: { facture_id: params.factureId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const facture = await lockFacture(client, params.factureId);
    if (!facture) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
    if (facture.statut !== params.expectedStatus) {
      throw new HttpError(409, "FACTURE_STATUS_CONFLICT", "Le statut de la facture a changé.");
    }
    if (facture.row_version !== params.input.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La facture a changé.");
    }
    if (facture.preview_hash !== params.input.preview_hash) {
      throw new HttpError(409, "FACTURE_PREVIEW_CHANGED", "L'aperçu de la facture a changé.");
    }
    assertFactureTransition(facture.statut, params.targetStatus);
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.facture
        SET statut = $2,
            validation_requested_at = CASE WHEN $2 = 'PENDING_VALIDATION' THEN now() ELSE validation_requested_at END,
            validation_requested_by = CASE WHEN $2 = 'PENDING_VALIDATION' THEN $3 ELSE validation_requested_by END,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [params.factureId, params.targetStatus, params.actor.userId]
    );
    const correlationId = newCorrelationId();
    const result: FinanceCommandResult = {
      id: facture.id,
      uuid: facture.uuid,
      draft_reference: facture.draft_reference,
      legal_number: null,
      status: params.targetStatus,
      row_version: updated.rows[0]?.row_version ?? facture.row_version + 1,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
      eventType: params.commandType,
      oldValues: { status: facture.statut },
      newValues: { status: params.targetStatus },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: `facturation.${params.commandType.toLowerCase()}`,
      entityType: "facture",
      entityId: facture.uuid,
      details: { from: facture.statut, to: params.targetStatus, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: params.commandType,
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
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

export async function repoValidateFacture(params: {
  factureId: number;
  input: ValidationDecisionBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const commandType = params.input.decision === "APPROVE" ? "FACTURE_APPROVE" : "FACTURE_RETURN";
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType,
      requestPayload: { facture_id: params.factureId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const facture = await lockFacture(client, params.factureId);
    if (!facture) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
    if (facture.statut !== "PENDING_VALIDATION") {
      throw new HttpError(409, "FACTURE_STATUS_CONFLICT", "La facture n'attend pas de validation.");
    }
    if (facture.row_version !== params.input.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La facture a changé.");
    }
    if (params.input.decision === "APPROVE") {
      assertSeparationOfDuties({
        creatorUserId: facture.created_by,
        validatorUserId: params.actor.userId,
      });
    }
    const target: FactureWorkflowStatus = params.input.decision === "APPROVE" ? "APPROVED" : "DRAFT";
    assertFactureTransition(facture.statut, target);
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.facture
        SET statut = $2,
            approved_at = CASE WHEN $2 = 'APPROVED' THEN now() ELSE NULL END,
            approved_by = CASE WHEN $2 = 'APPROVED' THEN $3 ELSE NULL END,
            validation_reason = $4,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [params.factureId, target, params.actor.userId, params.input.reason ?? null]
    );
    const correlationId = newCorrelationId();
    const result: FinanceCommandResult = {
      id: facture.id,
      uuid: facture.uuid,
      draft_reference: facture.draft_reference,
      legal_number: null,
      status: target,
      row_version: updated.rows[0]?.row_version ?? facture.row_version + 1,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
      eventType: commandType,
      oldValues: { status: facture.statut },
      newValues: { status: target },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
      reason: params.input.reason,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: `facturation.${commandType.toLowerCase()}`,
      entityType: "facture",
      entityId: facture.uuid,
      details: { decision: params.input.decision, correlation_id: correlationId },
    });
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType,
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
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

export async function repoIssueFacture(params: {
  factureId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
  writeDocument: FinanceDocumentWriter;
}): Promise<FinanceCommandResult> {
  const client = await pool.connect();
  let artifact: FinanceDocumentArtifact | null = null;
  try {
    await client.query("BEGIN");
    const receipt = await acquireFinanceIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "FACTURE_ISSUE",
      requestPayload: { facture_id: params.factureId, ...params.input },
    });
    if (receipt.replay) {
      await client.query("COMMIT");
      return { ...(receipt.replay as unknown as FinanceCommandResult), idempotent_replay: true };
    }
    const facture = await lockFacture(client, params.factureId);
    if (!facture) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
    if (facture.statut !== "APPROVED") {
      throw new HttpError(409, "FACTURE_NOT_APPROVED", "La facture doit être validée avant émission.");
    }
    if (facture.row_version !== params.input.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La facture a changé.");
    }
    const previewInput = await savedPreviewInput(client, params.factureId);
    const { preview, policy } = await buildFacturePreview(client, previewInput, true);
    ensurePreviewUsable(preview, params.input.preview_hash);
    if (facture.preview_hash !== preview.preview_hash) {
      throw new HttpError(
        409,
        "FACTURE_PREVIEW_CHANGED",
        "Le brouillon doit être revalidé après le changement des sources ou tarifs."
      );
    }
    if (!policy) throw new HttpError(503, "BILLING_POLICY_NOT_ACTIVE", "Politique Finance absente.");
    if (
      policy.require_distinct_issuer &&
      facture.approved_by !== null &&
      facture.approved_by === params.actor.userId
    ) {
      throw new HttpError(
        403,
        "FINANCE_ISSUER_VALIDATOR_CONFLICT",
        "La politique active impose un émetteur distinct du valideur."
      );
    }
    assertFactureTransition(facture.statut, "ISSUED");
    const issueDate = new Date().toISOString().slice(0, 10);
    // Fail before consuming a legal sequence value: an immutable fiscal document must never
    // be issued without the complete legal version applicable on its issue date.
    const issuerAtIssue = await requireFinanceIssuerSnapshotAt(
      client,
      facture.legal_entity_code,
      issueDate
    );
    const legal = await allocateLegalNumber({
      client,
      documentType: "FACTURE",
      entityCode: facture.legal_entity_code,
      issueDate,
    });
    const dueDates = preview.due_dates.map((due) => ({
      due_date: due.due_date,
      label: due.label,
      amount: due.amount,
    }));
    // Les mentions legales sont figees **a l'emission**, pas a la creation du brouillon.
    // Un brouillon peut vivre des semaines ; si le taux de penalite ou le capital change
    // entre-temps, la facture doit porter ce qui est en vigueur le jour ou elle est emise.
    const snapshot: FinanceDocumentSnapshot = {
      document_type: "FACTURE",
      uuid: facture.uuid,
      draft_reference: facture.draft_reference,
      legal_number: legal.legalNumber,
      issue_date: issueDate,
      due_dates: dueDates,
      currency: facture.currency,
      client_snapshot: facture.client_snapshot,
      issuer_snapshot: issuerAtIssue,
      lines: preview.lines,
      totals: preview.totals,
      internal_comment: facture.commentaires,
      customer_text: facture.customer_text,
    };
    artifact = await params.writeDocument(snapshot);
    const correlationId = newCorrelationId();
    await client.query(
      `
        UPDATE public.facture_source_allocations
        SET allocation_status = 'CONSUMED',
            quantity_consumed = quantity_selected,
            consumed_at = now(),
            consumed_by = $2
        WHERE facture_id = $1
          AND allocation_status = 'DRAFT'
      `,
      [params.factureId, params.actor.userId]
    );
    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.facture
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
            issuer_snapshot = $9::jsonb,
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING row_version
      `,
      [
        params.factureId,
        legal.legalNumber,
        legal.periodKey,
        legal.sequenceValue,
        issueDate,
        params.actor.userId,
        JSON.stringify(snapshot),
        artifact.checksumSha256,
        // La ligne conserve les mentions reellement imprimees, et non celles du brouillon :
        // sans cela, `facture.issuer_snapshot` et le PDF emis diraient deux choses
        // differentes sur la meme piece.
        JSON.stringify(issuerAtIssue),
      ]
    );
    await client.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1::uuid,$2,'PDF')`,
      [artifact.documentId, artifact.fileName]
    );
    await client.query(
      `
        INSERT INTO public.facture_documents (facture_id, document_id, type)
        VALUES ($1,$2::uuid,'LEGAL_PDF')
      `,
      [params.factureId, artifact.documentId]
    );
    await client.query(
      `
        INSERT INTO public.finance_document_versions (
          aggregate_type, aggregate_id, document_id, version, status,
          checksum_sha256, file_size_bytes, mime_type, snapshot_json,
          created_by, correlation_id
        )
        VALUES ('FACTURE',$1,$2::uuid,1,'ISSUED',$3,$4,'application/pdf',$5::jsonb,$6,$7::uuid)
      `,
      [
        facture.uuid,
        artifact.documentId,
        artifact.checksumSha256,
        artifact.fileSizeBytes,
        JSON.stringify(snapshot),
        params.actor.userId,
        correlationId,
      ]
    );
    const result: FinanceCommandResult = {
      id: facture.id,
      uuid: facture.uuid,
      draft_reference: facture.draft_reference,
      legal_number: legal.legalNumber,
      status: "ISSUED",
      row_version: updated.rows[0]?.row_version ?? facture.row_version + 1,
      correlation_id: correlationId,
      idempotent_replay: false,
    };
    await insertFinanceEvent({
      client,
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
      eventType: "FACTURE_ISSUED",
      oldValues: { status: facture.statut },
      newValues: {
        status: "ISSUED",
        legal_number: legal.legalNumber,
        document_checksum_sha256: artifact.checksumSha256,
      },
      actor: params.actor,
      correlationId,
      idempotencyKey: receipt.idempotencyKey,
      ruleCode: policy.policy_version,
    });
    await insertFinanceOutbox({
      client,
      eventKey: `finance.facture.issued:${facture.uuid}`,
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
      eventType: "FINANCE.INVOICE_ISSUED",
      payload: {
        facture_uuid: facture.uuid,
        legal_number: legal.legalNumber,
        total_incl_tax: preview.totals.total_incl_tax,
        currency: facture.currency,
        correlation_id: correlationId,
      },
      correlationId,
    });
    await insertGlobalFinanceAudit({
      client,
      actor: params.actor,
      action: "facturation.facture_issued",
      entityType: "facture",
      entityId: facture.uuid,
      details: {
        legal_number: legal.legalNumber,
        document_checksum_sha256: artifact.checksumSha256,
        correlation_id: correlationId,
      },
    });
    const commandeIds = await listIssuedInvoiceCommandeIds(client, facture.id);
    for (const commandeId of commandeIds) {
      await syncCommandeAfterInvoiceIssue(client, commandeId, params.actor.userId);
    }
    await saveFinanceReceipt({
      client,
      actor: params.actor,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      commandType: "FACTURE_ISSUE",
      aggregateType: "FACTURE",
      aggregateId: facture.uuid,
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
