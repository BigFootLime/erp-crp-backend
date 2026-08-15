import crypto from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";
import type { IdentificationEntityType } from "./domain/identification";

export type IdentificationActor = {
  user_id: number;
  role: string | null;
  request_id: string | null;
  correlation_id: string | null;
};

export type IdentificationLabelRow = {
  id: string;
  public_id: string;
  contract_version: 1;
  entity_type: IdentificationEntityType;
  entity_id: string;
  human_code: string;
  site_code: string | null;
  status: "ACTIVE" | "INVALIDATED" | "REPLACED";
  issued_by: number;
  issued_at: string;
  invalidated_at: string | null;
  invalidation_reason: string | null;
  replaced_by_label_id: string | null;
};

export type EntityDescriptor = {
  entity_type: IdentificationEntityType;
  entity_id: string;
  canonical_code: string;
  label: string;
  status: string | null;
};

export type StoredScanEvent = {
  event_id: string;
  payload_sha256: string;
  source: string;
  flow: string;
  expected_entity_types: string[];
  result_code: string;
  entity_type: IdentificationEntityType | null;
  entity_id: string | null;
  label_id: string | null;
  actor_user_id: number;
  client_scanned_at: string;
  device_id: string | null;
  details: Record<string, unknown>;
};

type Queryer = Pick<PoolClient, "query">;

export function identificationRequestHash(commandType: string, payload: unknown): string {
  return crypto.createHash("sha256").update(`${commandType}\n${JSON.stringify(payload)}`).digest("hex");
}

export function identificationPayloadHash(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function withIdentificationTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertUuidEntityId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(422, "IDENTIFICATION_INVALID_ENTITY_ID", "L'identifiant métier n'a pas le format UUID attendu.");
  }
}

function assertIntegerEntityId(value: string): void {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new HttpError(422, "IDENTIFICATION_INVALID_ENTITY_ID", "L'identifiant métier n'a pas le format entier attendu.");
  }
}

async function descriptorFromQuery(
  queryer: Queryer,
  entityType: IdentificationEntityType,
  sql: string,
  entityId: string
): Promise<EntityDescriptor> {
  const result = await queryer.query<{ entity_id: string; canonical_code: string; label: string; status: string | null }>(sql, [entityId]);
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "IDENTIFICATION_ENTITY_NOT_FOUND", "L'entité à étiqueter est introuvable.");
  return { entity_type: entityType, ...row };
}

export async function repoFindEntity(entityType: IdentificationEntityType, entityId: string, queryer: Queryer = pool): Promise<EntityDescriptor> {
  switch (entityType) {
    case "STOCK_ARTICLE":
      assertUuidEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id::text AS entity_id,code::text AS canonical_code,designation::text AS label,
                CASE WHEN archived_at IS NOT NULL OR NOT is_active THEN 'INACTIVE' ELSE status::text END AS status
           FROM public.articles WHERE id=$1::uuid`, entityId);
    case "STOCK_LOT":
      assertUuidEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT l.id::text AS entity_id,l.lot_code::text AS canonical_code,
                (a.code||' — lot '||l.lot_code)::text AS label,l.lot_status::text AS status
           FROM public.lots l JOIN public.articles a ON a.id=l.article_id WHERE l.id=$1::uuid`, entityId);
    case "STOCK_LOCATION":
      assertIntegerEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT e.id::text AS entity_id,e.code::text AS canonical_code,
                (m.code||' — '||e.name)::text AS label,
                CASE WHEN e.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END AS status
           FROM public.emplacements e JOIN public.magasins m ON m.id=e.magasin_id WHERE e.id=$1::integer`, entityId);
    case "WORK_ORDER":
      assertIntegerEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id::text AS entity_id,numero::text AS canonical_code,numero::text AS label,statut::text AS status
           FROM public.ordres_fabrication WHERE id=$1::bigint`, entityId);
    case "PURCHASE_ORDER":
      assertUuidEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id::text AS entity_id,code::text AS canonical_code,code::text AS label,statut::text AS status
           FROM public.commande_fournisseur WHERE id=$1::uuid`, entityId);
    case "RECEPTION":
      assertUuidEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id::text AS entity_id,reception_no::text AS canonical_code,reception_no::text AS label,status::text AS status
           FROM public.receptions_fournisseurs WHERE id=$1::uuid`, entityId);
    case "QUALITY_CONTROL":
      assertUuidEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id::text AS entity_id,reference::text AS canonical_code,reference::text AS label,status::text AS status
           FROM public.quality_control WHERE id=$1::uuid`, entityId);
    case "TOOL":
      assertIntegerEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id_outil::text AS entity_id,
                COALESCE(NULLIF(btrim(codification),''),NULLIF(btrim(reference_fabricant),''),id_outil::text)::text AS canonical_code,
                COALESCE(NULLIF(btrim(designation_outil_cnc),''),NULLIF(btrim(codification),''),NULLIF(btrim(designation),''),id_outil::text)::text AS label,
                CASE WHEN COALESCE(s.quantite,0)>0 THEN 'AVAILABLE' ELSE 'OUT_OF_STOCK' END AS status
           FROM public.gestion_outils_outil o
           LEFT JOIN public.gestion_outils_stock s ON s.id_outil=o.id_outil
          WHERE o.id_outil=$1::integer`, entityId);
    case "DELIVERY":
      assertUuidEntityId(entityId);
      return descriptorFromQuery(queryer, entityType,
        `SELECT id::text AS entity_id,numero::text AS canonical_code,numero::text AS label,statut::text AS status
           FROM public.bon_livraison WHERE id=$1::uuid`, entityId);
  }
}

const LABEL_SELECT = `SELECT id::text,public_id::text,contract_version,entity_type,entity_id,human_code,site_code,status,
  issued_by,issued_at::text,invalidated_at::text,invalidation_reason,replaced_by_label_id::text
  FROM public.identification_labels`;

export async function repoFindLabelById(id: string, queryer: Queryer = pool, lock = false): Promise<IdentificationLabelRow | null> {
  const result = await queryer.query<IdentificationLabelRow>(`${LABEL_SELECT} WHERE id=$1::uuid ${lock ? "FOR UPDATE" : ""}`, [id]);
  return result.rows[0] ?? null;
}

export async function repoFindLabelByPublicId(publicId: string, queryer: Queryer = pool): Promise<IdentificationLabelRow | null> {
  const result = await queryer.query<IdentificationLabelRow>(`${LABEL_SELECT} WHERE public_id=$1::uuid`, [publicId]);
  return result.rows[0] ?? null;
}

export async function repoFindActiveLabel(entityType: IdentificationEntityType, entityId: string, queryer: Queryer = pool): Promise<IdentificationLabelRow | null> {
  const result = await queryer.query<IdentificationLabelRow>(`${LABEL_SELECT} WHERE entity_type=$1 AND entity_id=$2 AND status='ACTIVE'`, [entityType, entityId]);
  return result.rows[0] ?? null;
}

export async function repoListLabels(filters: { entity_type?: IdentificationEntityType; entity_id?: string; status?: string; limit: number }): Promise<IdentificationLabelRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.entity_type) { values.push(filters.entity_type); where.push(`entity_type=$${values.length}`); }
  if (filters.entity_id) { values.push(filters.entity_id); where.push(`entity_id=$${values.length}`); }
  if (filters.status) { values.push(filters.status); where.push(`status=$${values.length}`); }
  values.push(filters.limit);
  const result = await pool.query<IdentificationLabelRow>(`${LABEL_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY issued_at DESC LIMIT $${values.length}`, values);
  return result.rows;
}

export async function repoInsertLabel(client: PoolClient, params: {
  public_id: string;
  entity: EntityDescriptor;
  human_code: string;
  site_code?: string;
  actor: IdentificationActor;
}): Promise<IdentificationLabelRow> {
  try {
    const result = await client.query<IdentificationLabelRow>(
      `WITH inserted AS (
         INSERT INTO public.identification_labels(public_id,entity_type,entity_id,human_code,site_code,issued_by,request_id)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) RETURNING *
       )
       SELECT id::text,public_id::text,contract_version,entity_type,entity_id,human_code,site_code,status,
              issued_by,issued_at::text,invalidated_at::text,invalidation_reason,replaced_by_label_id::text
       FROM inserted`,
      [params.public_id, params.entity.entity_type, params.entity.entity_id, params.human_code, params.site_code ?? null, params.actor.user_id, params.actor.request_id]
    );
    return result.rows[0]!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, "IDENTIFICATION_LABEL_ALREADY_ACTIVE", "Une étiquette active existe déjà pour cette entité. Utilisez la réimpression ou le remplacement.");
    }
    throw error;
  }
}

export async function repoInvalidateLabel(client: PoolClient, params: { label: IdentificationLabelRow; actor: IdentificationActor; reason: string; replacementId?: string }): Promise<IdentificationLabelRow> {
  const status = params.replacementId ? "REPLACED" : "INVALIDATED";
  await client.query(
    `UPDATE public.identification_labels SET status=$2,invalidated_by=$3,invalidated_at=now(),invalidation_reason=$4,replaced_by_label_id=$5::uuid
      WHERE id=$1::uuid`,
    [params.label.id, status, params.actor.user_id, params.reason, params.replacementId ?? null]
  );
  return (await repoFindLabelById(params.label.id, client))!;
}

export async function repoPrintCount(labelId: string, queryer: Queryer = pool): Promise<number> {
  const result = await queryer.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.identification_print_events WHERE label_id=$1::uuid`, [labelId]);
  return result.rows[0]?.count ?? 0;
}

export async function repoInsertPrintEvent(client: PoolClient, params: { label_id: string; event_type: "PRINT" | "REPRINT"; symbology: string; label_profile: string; reason?: string; actor: IdentificationActor }): Promise<void> {
  await client.query(
    `INSERT INTO public.identification_print_events(label_id,event_type,symbology,label_profile,reason,actor_user_id,request_id)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
    [params.label_id, params.event_type, params.symbology, params.label_profile, params.reason ?? null, params.actor.user_id, params.actor.request_id]
  );
}

export async function repoInsertAudit(client: Queryer, params: { actor: IdentificationActor; action: string; entity_type: string; entity_id: string; label_id?: string | null; details?: Record<string, unknown> }): Promise<void> {
  await client.query(
    `INSERT INTO public.identification_audit_events(actor_user_id,action,entity_type,entity_id,label_id,request_id,correlation_id,details)
     VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8::jsonb)`,
    [params.actor.user_id, params.action, params.entity_type, params.entity_id, params.label_id ?? null, params.actor.request_id, params.actor.correlation_id, JSON.stringify(params.details ?? {})]
  );
}

export async function repoAcquireReceipt(client: PoolClient, params: { actor: IdentificationActor; key: string; command_type: string; payload: unknown }): Promise<{ hash: string; replay: Record<string, unknown> | null }> {
  const hash = identificationRequestHash(params.command_type, params.payload);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`identification:${params.actor.user_id}:${params.command_type}:${params.key}`]);
  const existing = await client.query<{ request_sha256: string; result_payload: Record<string, unknown> }>(
    `SELECT request_sha256,result_payload FROM public.identification_command_receipts WHERE actor_user_id=$1 AND command_type=$2 AND idempotency_key=$3::uuid`,
    [params.actor.user_id, params.command_type, params.key]
  );
  const row = existing.rows[0];
  if (row && row.request_sha256 !== hash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a déjà été utilisée avec un autre contenu.");
  return { hash, replay: row?.result_payload ?? null };
}

export async function repoSaveReceipt(client: PoolClient, params: { actor: IdentificationActor; key: string; command_type: string; hash: string; aggregate_id: string; result: unknown }): Promise<void> {
  await client.query(
    `INSERT INTO public.identification_command_receipts(actor_user_id,command_type,idempotency_key,request_sha256,aggregate_id,result_payload)
     VALUES ($1,$2,$3::uuid,$4,$5,$6::jsonb)`,
    [params.actor.user_id, params.command_type, params.key, params.hash, params.aggregate_id, JSON.stringify(params.result)]
  );
}

export async function repoFindScanEvent(eventId: string): Promise<StoredScanEvent | null> {
  const result = await pool.query<StoredScanEvent>(
    `SELECT event_id::text,payload_sha256,source,flow,expected_entity_types,result_code,entity_type,entity_id,
            label_id::text,actor_user_id,client_scanned_at::text,device_id,details
       FROM public.identification_scan_events WHERE event_id=$1::uuid`, [eventId]
  );
  return result.rows[0] ?? null;
}

export async function repoInsertScanEvent(params: {
  event_id: string;
  payload_sha256: string;
  source: string;
  flow: string;
  expected_entity_types: readonly IdentificationEntityType[];
  result_code: string;
  label_id?: string | null;
  entity_type?: IdentificationEntityType | null;
  entity_id?: string | null;
  actor: IdentificationActor;
  client_scanned_at: string;
  device_id?: string;
  details?: Record<string, unknown>;
}): Promise<{ event: StoredScanEvent; inserted: boolean }> {
  try {
    const result = await pool.query<StoredScanEvent>(
      `INSERT INTO public.identification_scan_events(event_id,label_id,payload_sha256,source,flow,expected_entity_types,result_code,
         entity_type,entity_id,actor_user_id,client_scanned_at,request_id,device_id,details)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11::timestamptz,$12,$13,$14::jsonb)
       RETURNING event_id::text,payload_sha256,source,flow,expected_entity_types,result_code,entity_type,entity_id,label_id::text,
                 actor_user_id,client_scanned_at::text,device_id,details`,
      [params.event_id, params.label_id ?? null, params.payload_sha256, params.source, params.flow, params.expected_entity_types,
        params.result_code, params.entity_type ?? null, params.entity_id ?? null, params.actor.user_id, params.client_scanned_at,
        params.actor.request_id, params.device_id ?? null, JSON.stringify(params.details ?? {})]
    );
    return { event: result.rows[0]!, inserted: true };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      const replay = await repoFindScanEvent(params.event_id);
      if (replay) return { event: replay, inserted: false };
    }
    throw error;
  }
}

export function asObject<T extends QueryResultRow>(row: T): Record<string, unknown> {
  return row as Record<string, unknown>;
}
