import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  insertGlobalFinanceAudit,
  issuerSnapshotAt,
  requireFinanceIssuerSnapshotAt,
  type FinanceActorContext,
} from "./workflow.repository.shared";
import type {
  ActivateFinanceConfigurationBodyDTO,
  CreateFinanceSequencesBodyDTO,
  FinanceConfigurationReadinessQueryDTO,
} from "../validators/finance-configuration.validators";

const REQUIRED_LEGAL_KEYS = [
  "company_name",
  "legal_mentions_version",
  "legal_form",
  "share_capital",
  "share_capital_currency",
  "rcs_city",
  "rcs_number",
  "siret",
  "vat_number",
  "late_penalty_rate",
  "late_penalty_basis",
  "recovery_indemnity",
] as const;

type BillerRow = {
  biller_id: string;
  biller_name: string;
  bank_details_complete: boolean;
};

function missingLegalKeys(snapshot: Record<string, unknown> | null): string[] {
  if (!snapshot) return [...REQUIRED_LEGAL_KEYS];
  return REQUIRED_LEGAL_KEYS.filter((key) => {
    const value = snapshot[key];
    return value === null || value === undefined || (typeof value === "string" && !value.trim());
  });
}

function sequenceInputRows(input: ActivateFinanceConfigurationBodyDTO) {
  return [
    { document_type: "FACTURE" as const, ...input.sequences.facture },
    ...(input.sequences.avoir ? [{ document_type: "AVOIR" as const, ...input.sequences.avoir }] : []),
  ];
}

function isMissingSchemaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ["42P01", "42883"].includes(String((error as { code?: unknown }).code));
}

export async function repoGetFinanceConfigurationReadiness(
  query: FinanceConfigurationReadinessQueryDTO
) {
  const periodKey = String(query.year ?? new Date().getUTCFullYear());
  const [billers, policy, sequences] = await Promise.all([
    pool.query<BillerRow>(
      `
        SELECT biller_id::text AS biller_id, biller_name,
          (NULLIF(trim(COALESCE(default_bank_name, '')), '') IS NOT NULL
           AND NULLIF(trim(COALESCE(default_iban, '')), '') IS NOT NULL
           AND NULLIF(trim(COALESCE(default_bic, '')), '') IS NOT NULL) AS bank_details_complete
        FROM public.factureur
        ORDER BY biller_name, biller_id
      `
    ),
    pool.query(
      `SELECT policy_version, legal_entity_code, eligible_delivery_statuses, require_distinct_issuer,
              effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM public.finance_billing_policies
       WHERE active = TRUE AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY effective_from DESC, created_at DESC LIMIT 1`
    ),
    pool.query(
      `SELECT document_type, entity_code, period_key, prefix, next_value::text AS next_value,
              padding, active
       FROM public.finance_legal_sequences
       WHERE period_key = $1 AND document_type IN ('FACTURE', 'AVOIR')
       ORDER BY entity_code, document_type`,
      [periodKey]
    ),
  ]);

  let legalFunctionAvailable = true;
  const issuers = await Promise.all(
    billers.rows.map(async (biller) => {
      let snapshot: Record<string, unknown> | null = null;
      try {
        snapshot = await issuerSnapshotAt(pool, biller.biller_id, `${periodKey}-01-01`);
      } catch (error) {
        if (!isMissingSchemaError(error)) throw error;
        legalFunctionAvailable = false;
      }
      const missing_legal_fields = missingLegalKeys(snapshot);
      return {
        legal_entity_code: biller.biller_id,
        name: biller.biller_name,
        bank_details_complete: biller.bank_details_complete,
        legal_snapshot_complete: missing_legal_fields.length === 0,
        missing_legal_fields,
      };
    })
  );

  const activePolicy = policy.rows[0] ?? null;
  const blockers: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];
  if (!issuers.length) blockers.push({ code: "FINANCE_ISSUER_NOT_CONFIGURED", message: "Aucun émetteur Finance n'est configuré." });
  if (!legalFunctionAvailable) blockers.push({ code: "FINANCE_LEGAL_MENTIONS_NOT_CONFIGURED", message: "Le référentiel des mentions légales Finance est indisponible." });
  if (!activePolicy && issuers.some((issuer) => !issuer.legal_snapshot_complete)) warnings.push({ code: "FINANCE_LEGAL_MENTIONS_NOT_CONFIGURED", message: "Un ou plusieurs émetteurs ont des mentions légales obligatoires incomplètes." });
  if (issuers.some((issuer) => !issuer.bank_details_complete)) warnings.push({ code: "FINANCE_ISSUER_BANK_DETAILS_INCOMPLETE", message: "Au moins un émetteur ne possède pas toutes ses coordonnées bancaires." });
  if (!activePolicy) blockers.push({ code: "FINANCE_BILLING_POLICY_NOT_CONFIGURED", message: "Aucune politique de facturation active n'est applicable aujourd'hui." });
  if (activePolicy) {
    const activeIssuer = issuers.find((issuer) => issuer.legal_entity_code === activePolicy.legal_entity_code);
    if (!activeIssuer?.legal_snapshot_complete) blockers.push({ code: "FINANCE_LEGAL_MENTIONS_NOT_CONFIGURED", message: "Les mentions légales de l'émetteur sélectionné par la politique active sont incomplètes." });
  }
  if (activePolicy && !sequences.rows.some((sequence) => sequence.document_type === "FACTURE" && sequence.entity_code === activePolicy.legal_entity_code && sequence.active)) {
    blockers.push({ code: "FINANCE_LEGAL_SEQUENCE_NOT_CONFIGURED", message: "La séquence FACTURE active de l'émetteur sélectionné est absente pour cette année." });
  }
  if (activePolicy && !sequences.rows.some((sequence) => sequence.document_type === "AVOIR" && sequence.entity_code === activePolicy.legal_entity_code && sequence.active)) {
    warnings.push({ code: "FINANCE_AVOIR_SEQUENCE_NOT_CONFIGURED", message: "La séquence AVOIR est optionnelle mais absente pour cette année." });
  }
  return {
    current_year: Number(periodKey),
    issuers,
    active_policy: activePolicy,
    sequences: sequences.rows,
    readiness: { ready: blockers.length === 0, blockers, warnings },
  };
}

async function assertIssuerExists(client: PoolClient, legalEntityCode: string): Promise<void> {
  const issuer = await client.query(
    "SELECT biller_id FROM public.factureur WHERE biller_id::text = $1 FOR KEY SHARE",
    [legalEntityCode]
  );
  if (!issuer.rows[0]) throw new HttpError(409, "FINANCE_ISSUER_NOT_CONFIGURED", "L'émetteur légal sélectionné est introuvable.");
}

export async function repoActivateFinanceConfiguration(params: {
  input: ActivateFinanceConfigurationBodyDTO;
  actor: FinanceActorContext;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializes all activations so no active date range can appear between check and insert.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["finance:billing-policy:activation"]);
    await assertIssuerExists(client, params.input.legal_entity_code);
    await requireFinanceIssuerSnapshotAt(client, params.input.legal_entity_code, params.input.effective_from);

    const duplicateVersion = await client.query(
      "SELECT id FROM public.finance_billing_policies WHERE policy_version = $1 FOR UPDATE",
      [params.input.policy_version]
    );
    if (duplicateVersion.rows[0]) throw new HttpError(409, "FINANCE_POLICY_VERSION_EXISTS", "Cette version de politique existe déjà.");
    const overlap = await client.query(
      `SELECT id FROM public.finance_billing_policies
       WHERE active = TRUE
         AND effective_from <= COALESCE($1::date, 'infinity'::date)
         AND COALESCE(effective_to, 'infinity'::date) >= $2::date
       FOR UPDATE`,
      [params.input.effective_to ?? null, params.input.effective_from]
    );
    if (overlap.rows[0]) throw new HttpError(409, "FINANCE_BILLING_POLICY_OVERLAP", "Une politique Finance active couvre déjà cette période.");

    const sequenceRows = sequenceInputRows(params.input);
    for (const sequence of sequenceRows) {
      const existing = await client.query(
        `SELECT id FROM public.finance_legal_sequences
         WHERE document_type = $1 AND entity_code = $2 AND period_key = $3 FOR UPDATE`,
        [sequence.document_type, params.input.legal_entity_code, String(sequence.year)]
      );
      if (existing.rows[0]) {
        throw new HttpError(409, "FINANCE_LEGAL_SEQUENCE_SCOPE_EXISTS", `La séquence ${sequence.document_type} existe déjà pour ce périmètre.`);
      }
    }

    const createdPolicy = await client.query<{ id: string }>(
      `INSERT INTO public.finance_billing_policies (
         policy_version, legal_entity_code, eligible_delivery_statuses, require_distinct_issuer,
         active, effective_from, effective_to, created_by
       ) VALUES ($1,$2,$3::text[],$4,TRUE,$5::date,$6::date,$7) RETURNING id::text AS id`,
      [params.input.policy_version, params.input.legal_entity_code, params.input.eligible_delivery_statuses,
        params.input.require_distinct_issuer, params.input.effective_from, params.input.effective_to ?? null, params.actor.userId]
    );
    const policyId = createdPolicy.rows[0]?.id;
    if (!policyId) throw new Error("Finance billing policy creation failed");
    for (const sequence of sequenceRows) {
      await client.query(
        `INSERT INTO public.finance_legal_sequences
          (document_type, entity_code, period_key, prefix, next_value, padding, active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [sequence.document_type, params.input.legal_entity_code, String(sequence.year), sequence.prefix,
          sequence.next_value, sequence.padding]
      );
    }
    await insertGlobalFinanceAudit({
      client, actor: params.actor, action: "facturation.configuration.activated",
      entityType: "finance_billing_policy", entityId: policyId,
      details: {
        policy_version: params.input.policy_version,
        legal_entity_code: params.input.legal_entity_code,
        effective_from: params.input.effective_from,
        effective_to: params.input.effective_to ?? null,
        eligible_delivery_statuses: params.input.eligible_delivery_statuses,
        require_distinct_issuer: params.input.require_distinct_issuer,
        sequences: sequenceRows.map((sequence) => ({ document_type: sequence.document_type, year: sequence.year, prefix: sequence.prefix, next_value: sequence.next_value, padding: sequence.padding })),
      },
    });
    await client.query("COMMIT");
    return { id: policyId, policy_version: params.input.policy_version, legal_entity_code: params.input.legal_entity_code, active: true, sequences: sequenceRows.map(({ document_type, year }) => ({ document_type, year, active: true })) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCreateFinanceSequences(params: {
  input: CreateFinanceSequencesBodyDTO;
  actor: FinanceActorContext;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["finance:legal-sequence:creation"]);
    const policy = await client.query<{ legal_entity_code: string; policy_version: string }>(
      `SELECT legal_entity_code, policy_version FROM public.finance_billing_policies
       WHERE active = TRUE AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY effective_from DESC, created_at DESC LIMIT 1 FOR UPDATE`
    );
    const activePolicy = policy.rows[0];
    if (!activePolicy) throw new HttpError(409, "FINANCE_BILLING_POLICY_NOT_CONFIGURED", "Une politique Finance active est requise pour créer une séquence.");
    const rows = [
      ...(params.input.sequences.facture ? [{ document_type: "FACTURE" as const, ...params.input.sequences.facture }] : []),
      ...(params.input.sequences.avoir ? [{ document_type: "AVOIR" as const, ...params.input.sequences.avoir }] : []),
    ];
    for (const sequence of rows) {
      const existing = await client.query(
        `SELECT id FROM public.finance_legal_sequences
         WHERE document_type = $1 AND entity_code = $2 AND period_key = $3 FOR UPDATE`,
        [sequence.document_type, activePolicy.legal_entity_code, String(sequence.year)]
      );
      if (existing.rows[0]) throw new HttpError(409, "FINANCE_LEGAL_SEQUENCE_SCOPE_EXISTS", `La séquence ${sequence.document_type} existe déjà pour ce périmètre.`);
    }
    for (const sequence of rows) {
      await client.query(
        `INSERT INTO public.finance_legal_sequences
          (document_type, entity_code, period_key, prefix, next_value, padding, active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [sequence.document_type, activePolicy.legal_entity_code, String(sequence.year), sequence.prefix, sequence.next_value, sequence.padding]
      );
    }
    await insertGlobalFinanceAudit({
      client, actor: params.actor, action: "facturation.configuration.sequences_created",
      entityType: "finance_legal_sequence", entityId: activePolicy.legal_entity_code,
      details: { policy_version: activePolicy.policy_version, sequences: rows.map((row) => ({ document_type: row.document_type, year: row.year, prefix: row.prefix, next_value: row.next_value, padding: row.padding })) },
    });
    await client.query("COMMIT");
    return { legal_entity_code: activePolicy.legal_entity_code, sequences: rows.map(({ document_type, year }) => ({ document_type, year, active: true })) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
