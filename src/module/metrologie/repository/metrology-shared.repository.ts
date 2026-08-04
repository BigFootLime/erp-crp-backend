// Socle transactionnel de la surface Métrologie 360 (#229).
//
// Tout ce qui est partagé par les dépôts du module : contexte d'acteur,
// transaction, idempotence, journal append-only, audit, et surtout le
// chargement de l'ÉTAT SERVEUR d'un instrument — la seule source de vérité de
// l'éligibilité, consommée aussi bien par la métrologie que par la qualité.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";

import {
  decideMetrologyReceipt,
  metrologyRequestHash,
  normalizeMetrologyIdempotencyKey,
} from "../domain/metrology-policy";
import type { MetrologyEquipmentState } from "../domain/metrology-policy";
import type { MetrologyInstrumentState, MetrologyPolicySettings } from "../domain/metrology-eligibility";

export type DbQueryer = Pick<PoolClient, "query">;

export type MetrologyActor = {
  user_id: number;
  role: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
  request_id: string | null;
};

export type MetrologyAggregateType =
  | "EQUIPEMENT"
  | "CATEGORIE"
  | "PLAN"
  | "EXECUTION"
  | "CERTIFICAT"
  | "IMPACT";

export const METROLOGY_SETTING_KEY = "metrologie.block_on_overdue_critical";

/* ========================================================================== */
/* Transaction, journal, audit                                                */
/* ========================================================================== */

export class MetrologyCommitUncertainError<T> extends HttpError {
  readonly transactionResult: T;
  constructor(transactionResult: T) {
    super(503, "METROLOGY_COMMIT_UNCERTAIN", "Le résultat du COMMIT doit être rapproché avant toute compensation.");
    this.transactionResult = transactionResult;
  }
}

export class MetrologyRollbackUncertainError extends HttpError {
  constructor() {
    super(503, "METROLOGY_ROLLBACK_UNCERTAIN", "Le rollback n’a pas pu être confirmé ; les preuves sont préservées.");
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let out: T;
    try {
      out = await fn(client);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new MetrologyRollbackUncertainError();
      }
      throw err;
    }
    try {
      await client.query("COMMIT");
    } catch {
      throw new MetrologyCommitUncertainError(out);
    }
    return out;
  } finally {
    client.release();
  }
}

export function db(): typeof pool {
  return pool;
}

export async function insertAuditLog(
  tx: DbQueryer,
  actor: MetrologyActor,
  entry: {
    action: string;
    entity_type: string;
    entity_id: string;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  await repoInsertAuditLog({
    user_id: actor.user_id,
    body: {
      event_type: "ACTION",
      action: entry.action,
      page_key: actor.page_key,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      path: actor.path,
      client_session_id: actor.client_session_id,
      details: entry.details ?? null,
    },
    ip: actor.ip,
    user_agent: actor.user_agent,
    device_type: actor.device_type,
    os: actor.os,
    browser: actor.browser,
    tx,
  });
}

/**
 * Journal métier append-only. Écrit dans la MÊME transaction que la décision :
 * une décision sans trace est impossible. Le trigger
 * `trg_metrologie_event_log_append_only_229` interdit toute réécriture.
 */
export async function insertMetrologyEvent(
  tx: DbQueryer,
  params: {
    equipement_id: string | null;
    entity_type: MetrologyAggregateType;
    entity_id: string;
    event_type: string;
    actor: MetrologyActor;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
    correlation_id: string;
    idempotency_key?: string | null;
    rule_code?: string | null;
    reason?: string | null;
  }
): Promise<void> {
  const inserted = await tx.query<{ id: string; created_at: string }>(
    `
      INSERT INTO public.metrologie_event_log (
        equipement_id, entity_type, entity_id, event_type,
        old_values, new_values, user_id,
        correlation_id, idempotency_key, rule_code, reason, request_id, source
      )
      VALUES (
        $1::uuid, $2, $3, $4,
        $5::jsonb, $6::jsonb, $7,
        $8::uuid, $9, $10, $11, $12, 'api'
      )
      RETURNING id::text AS id, created_at::text AS created_at
    `,
    [
      params.equipement_id,
      params.entity_type,
      params.entity_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.actor.user_id,
      params.correlation_id,
      params.idempotency_key ?? null,
      params.rule_code ?? null,
      params.reason ?? null,
      params.actor.request_id,
    ]
  );
  const event = inserted.rows[0];
  if (!event) throw new Error("METROLOGY_EVENT_INSERT_FAILED");
  if (params.equipement_id) {
    await enqueueMetrologyEquipmentChanged(tx, {
      equipementId: params.equipement_id,
      eventId: event.id,
      eventType: params.event_type,
      occurredAt: event.created_at,
    });
  }
}

export async function enqueueMetrologyEquipmentChanged(
  tx: DbQueryer,
  params: { equipementId: string; eventId: string; eventType: string; occurredAt: string }
): Promise<void> {
  const normalized = params.eventType.toUpperCase();
  const action = /^EQUIPEMENT_(?:CREATE|CREATED|REGISTER|REGISTERED)$/.test(normalized)
    ? "created"
    : /^EQUIPEMENT_(?:DELETE|DELETED|REMOVE|REMOVED)$/.test(normalized)
      ? "deleted"
      : normalized.includes("TRANSITION")
          || normalized.includes("VALIDAT")
          || normalized.includes("QUARANTIN")
          || normalized.includes("STATUS")
        ? "status_changed"
        : "updated";
  await enqueueEntityChanged(tx, {
    entityType: "METROLOGIE_EQUIPEMENT",
    entityId: params.equipementId,
    action,
    module: "metrologie",
    at: params.occurredAt,
    invalidateKeys: [
      "metrologie:equipements",
      "metrologie:kpis",
      "metrologie:alerts",
      "metrologie:center",
      `metrologie:equipement:${params.equipementId}`,
    ],
  }, { deduplicationKey: `metrology-event:${params.eventId}` });
}

/* ========================================================================== */
/* Idempotence                                                                */
/* ========================================================================== */

export type IdempotencyClaim = {
  idempotencyKey: string;
  requestHash: string;
  replay: Record<string, unknown> | null;
};

/**
 * Même clé + même payload ⇒ même résultat (rejeu). Même clé + autre payload ⇒
 * 409. Le verrou consultatif transactionnel sérialise deux requêtes concurrentes
 * portant la même clé : la seconde attend et lit le reçu de la première.
 */
export async function acquireIdempotency(params: {
  client: PoolClient;
  actor: MetrologyActor;
  idempotencyKeyRaw: string | null | undefined;
  commandType: string;
  requestPayload: unknown;
}): Promise<IdempotencyClaim> {
  const idempotencyKey = normalizeMetrologyIdempotencyKey(params.idempotencyKeyRaw);
  const requestHash = metrologyRequestHash(params.commandType, params.requestPayload);

  await params.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `metrology:${params.actor.user_id}:${idempotencyKey}`,
  ]);

  const existing = await params.client.query<{
    request_hash: string;
    result_payload: Record<string, unknown>;
  }>(
    `
      SELECT request_hash, result_payload
      FROM public.metrologie_command_receipts
      WHERE actor_user_id = $1 AND idempotency_key = $2
      LIMIT 1
    `,
    [params.actor.user_id, idempotencyKey]
  );

  const receipt = existing.rows[0] ?? null;
  const decision = decideMetrologyReceipt(receipt?.request_hash, requestHash);
  if (decision === "CONFLICT") {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Cette Idempotency-Key a déjà été utilisée avec un autre contenu."
    );
  }

  return {
    idempotencyKey,
    requestHash,
    replay: decision === "REPLAY" ? (receipt?.result_payload ?? null) : null,
  };
}

export async function saveReceipt(params: {
  client: PoolClient;
  actor: MetrologyActor;
  claim: IdempotencyClaim;
  commandType: string;
  aggregateType: MetrologyAggregateType;
  aggregateId: string;
  requestPayload: unknown;
  resultPayload: unknown;
  correlationId: string;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO public.metrologie_command_receipts (
        actor_user_id, idempotency_key, request_hash, command_type,
        aggregate_type, aggregate_id, request_payload, result_payload, correlation_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid)
    `,
    [
      params.actor.user_id,
      params.claim.idempotencyKey,
      params.claim.requestHash,
      params.commandType,
      params.aggregateType,
      params.aggregateId,
      JSON.stringify(params.requestPayload ?? null),
      JSON.stringify(params.resultPayload ?? null),
      params.correlationId,
    ]
  );
}

/* ========================================================================== */
/* Utilitaires                                                                */
/* ========================================================================== */

export function toNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toInt(value: unknown, fallback = 0): number {
  const n = toNumber(value, fallback);
  return n === null ? fallback : Math.trunc(n);
}

export function sortDirection(dir: "asc" | "desc"): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type UserLite = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  label: string;
};

export function mapUserLite(row: {
  id: number | null;
  username: string | null;
  name: string | null;
  surname: string | null;
}): UserLite | null {
  if (!row.id || !row.username) return null;
  const parts = [row.surname ?? "", row.name ?? ""].map((s) => s.trim()).filter(Boolean);
  const label = parts.join(" ").trim() || row.username;
  return { id: row.id, username: row.username, name: row.name, surname: row.surname, label };
}

export async function loadMetrologyPolicy(q: DbQueryer): Promise<MetrologyPolicySettings> {
  try {
    const res = await q.query<{ value_json: unknown }>(
      `SELECT value_json FROM public.erp_settings WHERE key = $1`,
      [METROLOGY_SETTING_KEY]
    );
    const raw = res.rows[0]?.value_json ?? null;
    const enabled = Boolean(isRecord(raw) && raw.enabled === true);
    return { block_on_overdue_critical: enabled };
  } catch {
    // Un réglage illisible ne doit jamais bloquer l'atelier : on retombe sur
    // le comportement le moins intrusif, et l'éligibilité reste évaluée par le
    // plan applicable.
    return { block_on_overdue_critical: false };
  }
}

/* ========================================================================== */
/* État serveur d'un instrument                                               */
/* ========================================================================== */

type InstrumentRow = {
  id: string;
  code: string | null;
  designation: string | null;
  categorie_code: string | null;
  sous_categorie_code: string | null;
  categorie_legacy: string | null;
  etat: MetrologyEquipmentState;
  criticite: string | null;
  deleted: boolean;
  unite: string | null;
  plage_min: string | null;
  plage_max: string | null;
  resolution: string | null;
  mpe: string | null;
  incertitude: string | null;
  methodes: string[] | null;
  restrictions: string | null;
  exige_certificat: boolean;
  plan_version_id: string | null;
  plan_version: number | null;
  plan_blocking_strategy: "BLOCK" | "WARN" | "NONE" | null;
  plan_alert_window_days: number | null;
  next_due_date: string | null;
  last_proof_execution_id: string | null;
  last_proof_date: string | null;
  last_proof_verdict: string | null;
  certificate_id: string | null;
};

/**
 * Sélection du plan applicable : parmi les versions ACTIVE de l'équipement, on
 * retient LA PLUS CONTRAIGNANTE, c'est-à-dire celle dont l'échéance tombe le
 * plus tôt. Un instrument dont la vérification interne est échue n'est pas
 * « à jour » parce que son étalonnage annuel, lui, ne l'est pas encore.
 *
 * Repli : `metrologie_plan` (table historique, une ligne par équipement) pour
 * les instruments qui n'ont pas encore de plan versionné — aucun écran existant
 * ne change de comportement.
 */
const INSTRUMENT_SELECT = `
  SELECT
    e.id::text                       AS id,
    e.code,
    e.designation,
    e.categorie_code,
    e.sous_categorie_code,
    e.categorie                      AS categorie_legacy,
    e.etat,
    e.criticite,
    (e.deleted_at IS NOT NULL)       AS deleted,
    e.unite,
    e.plage_min::text                AS plage_min,
    e.plage_max::text                AS plage_max,
    e.resolution::text               AS resolution,
    e.mpe::text                      AS mpe,
    e.incertitude::text              AS incertitude,
    e.methodes,
    e.restrictions,
    e.exige_certificat,
    pv.id::text                      AS plan_version_id,
    pv.version                       AS plan_version,
    pv.blocking_strategy             AS plan_blocking_strategy,
    pv.alert_window_days             AS plan_alert_window_days,
    COALESCE(pv.next_due_date, legacy.next_due_date)::text AS next_due_date,
    proof.id::text                   AS last_proof_execution_id,
    proof.ended_at::text             AS last_proof_date,
    proof.verdict                    AS last_proof_verdict,
    cert.id::text                    AS certificate_id
  FROM public.metrologie_equipements e
  LEFT JOIN LATERAL (
    SELECT p.id, p.version, p.blocking_strategy, p.alert_window_days, p.next_due_date
    FROM public.metrologie_plan_version p
    WHERE p.equipement_id = e.id
      AND p.status = 'ACTIVE'
    ORDER BY p.next_due_date ASC NULLS LAST, p.version DESC
    LIMIT 1
  ) pv ON TRUE
  LEFT JOIN LATERAL (
    SELECT lp.next_due_date
    FROM public.metrologie_plan lp
    WHERE lp.equipement_id = e.id
      AND lp.deleted_at IS NULL
      AND lp.statut <> 'SUSPENDU'
    ORDER BY lp.created_at DESC
    LIMIT 1
  ) legacy ON TRUE
  LEFT JOIN LATERAL (
    SELECT x.id, x.ended_at, x.verdict
    FROM public.metrologie_execution x
    WHERE x.equipement_id = e.id
      AND x.status = 'VALIDATED'
      AND x.verdict IN ('CONFORME', 'CONFORME_AVEC_RESTRICTION')
    ORDER BY x.ended_at DESC NULLS LAST
    LIMIT 1
  ) proof ON TRUE
  LEFT JOIN LATERAL (
    SELECT c.id
    FROM public.metrologie_certificats c
    WHERE c.equipement_id = e.id
      AND c.deleted_at IS NULL
      AND c.statut = 'VALIDE'
      AND c.resultat = 'CONFORME'
      AND (c.date_echeance IS NULL OR c.date_echeance >= CURRENT_DATE)
    ORDER BY c.date_etalonnage DESC, c.created_at DESC
    LIMIT 1
  ) cert ON TRUE
`;

function mapInstrumentRow(row: InstrumentRow): MetrologyInstrumentState {
  return {
    id: row.id,
    code: row.code,
    designation: row.designation,
    categorie_code: row.categorie_code,
    sous_categorie_code: row.sous_categorie_code,
    categorie_legacy: row.categorie_legacy,
    etat: row.etat,
    criticite: row.criticite,
    deleted: row.deleted,
    unite: row.unite,
    plage_min: toNumber(row.plage_min),
    plage_max: toNumber(row.plage_max),
    resolution: toNumber(row.resolution),
    mpe: toNumber(row.mpe),
    incertitude: toNumber(row.incertitude),
    methodes: row.methodes ?? [],
    restrictions: row.restrictions,
    exige_certificat: row.exige_certificat === true,
    plan_version_id: row.plan_version_id,
    plan_version: row.plan_version,
    plan_blocking_strategy: row.plan_blocking_strategy,
    plan_alert_window_days: row.plan_alert_window_days,
    next_due_date: row.next_due_date ? row.next_due_date.slice(0, 10) : null,
    last_proof_execution_id: row.last_proof_execution_id,
    last_proof_date: row.last_proof_date ? row.last_proof_date.slice(0, 10) : null,
    last_proof_verdict: row.last_proof_verdict,
    has_valid_certificate: Boolean(row.certificate_id),
    certificate_id: row.certificate_id,
  };
}

export async function loadInstrumentState(
  q: DbQueryer,
  instrumentId: string
): Promise<MetrologyInstrumentState | null> {
  const res = await q.query<InstrumentRow>(`${INSTRUMENT_SELECT} WHERE e.id = $1::uuid LIMIT 1`, [
    instrumentId,
  ]);
  const row = res.rows[0] ?? null;
  return row ? mapInstrumentRow(row) : null;
}

/**
 * Instruments candidats pour une caractéristique. Le filtrage grossier est fait
 * en SQL (parc utilisable, catégorie) ; le verdict fin reste au domaine, pour
 * qu'une règle d'éligibilité ne vive jamais à deux endroits.
 */
export async function loadInstrumentCandidates(
  q: DbQueryer,
  params: { category: string | null; search: string | null; limit: number }
): Promise<MetrologyInstrumentState[]> {
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const where: string[] = [
    "e.deleted_at IS NULL",
    "e.etat IN ('ACTIVE','QUALIFIED')",
  ];

  if (params.category) {
    const p = push(params.category);
    where.push(
      `(upper(COALESCE(e.categorie_code,'')) = upper(${p})
        OR upper(COALESCE(e.sous_categorie_code,'')) = upper(${p})
        OR upper(COALESCE(e.categorie,'')) = upper(${p}))`
    );
  }
  if (params.search) {
    const p = push(`%${params.search.replace(/%/g, "\\%")}%`);
    where.push(
      `(COALESCE(e.code,'') ILIKE ${p} OR e.designation ILIKE ${p} OR COALESCE(e.numero_serie,'') ILIKE ${p})`
    );
  }

  const res = await q.query<InstrumentRow>(
    `${INSTRUMENT_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(pv.next_due_date, legacy.next_due_date) DESC NULLS LAST, e.designation ASC
     LIMIT ${push(params.limit)}`,
    values
  );
  return res.rows.map(mapInstrumentRow);
}

/* ========================================================================== */
/* Erreurs PostgreSQL                                                         */
/* ========================================================================== */

export function pgErrorInfo(err: unknown): { code: string | null; constraint: string | null } {
  if (!isRecord(err)) return { code: null, constraint: null };
  return {
    code: typeof err.code === "string" ? err.code : null,
    constraint: typeof err.constraint === "string" ? err.constraint : null,
  };
}

/**
 * Traduit une violation de contrainte en erreur métier lisible. Aucune trace
 * SQL, aucun nom de table brut ne remonte au client.
 */
export function mapConstraintError(err: unknown): HttpError | null {
  const { code, constraint } = pgErrorInfo(err);
  if (code !== "23505") return null;
  switch (constraint) {
    case "metrologie_equipements_code_uniq":
      return new HttpError(409, "METROLOGY_CODE_DUPLICATE", "Ce code d'équipement existe déjà.");
    case "metrologie_categories_code_229_uq":
      return new HttpError(409, "METROLOGY_CATEGORY_DUPLICATE", "Ce code de catégorie existe déjà.");
    case "metrologie_plan_version_229_uq":
    case "metrologie_plan_version_active_229_uq":
      return new HttpError(
        409,
        "METROLOGY_PLAN_ALREADY_ACTIVE",
        "Une version de plan est déjà active pour ce type d'opération."
      );
    case "metrologie_execution_code_229_uq":
      return new HttpError(409, "METROLOGY_EXECUTION_DUPLICATE", "Ce code d'exécution existe déjà.");
    case "metrologie_certificats_numero_externe_229_uq":
      return new HttpError(
        409,
        "METROLOGY_CERTIFICATE_DUPLICATE",
        "Ce numéro de certificat est déjà enregistré pour cet émetteur."
      );
    case "metrologie_impact_dossier_execution_229_uq":
      return new HttpError(
        409,
        "METROLOGY_IMPACT_ALREADY_OPEN",
        "Un dossier d'impact existe déjà pour cette exécution."
      );
    case "metrologie_command_receipts_229_uq":
      return new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Cette Idempotency-Key a déjà été utilisée."
      );
    default:
      return null;
  }
}

export function rethrowMapped(err: unknown): never {
  const mapped = mapConstraintError(err);
  if (mapped) throw mapped;
  throw err;
}
