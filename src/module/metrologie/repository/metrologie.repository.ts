import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";

import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  CreateCertificatBodyDTO,
  CreateEquipementBodyDTO,
  ListEquipementsQueryDTO,
  PatchEquipementBodyDTO,
  UpsertPlanBodyDTO,
} from "../validators/metrologie.validators";
import type {
  MetrologieAlerts,
  MetrologieCertificat,
  MetrologieEquipement,
  MetrologieEquipementDetail,
  MetrologieEquipementListItem,
  MetrologieEventLog,
  MetrologieKpis,
  MetrologiePlan,
  Paginated,
  UserLite,
} from "../types/metrologie.types";

type DbQueryer = Pick<PoolClient, "query">;
const db = pool;

export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null };
  const code = typeof err.code === "string" ? err.code : null;
  const constraint = typeof err.constraint === "string" ? err.constraint : null;
  return { code, constraint };
}

function userLabel(u: { username: string; name: string | null; surname: string | null }): string {
  const parts = [u.surname ?? "", u.name ?? ""]
    .map((s) => s.trim())
    .filter(Boolean);
  const full = parts.join(" ").trim();
  return full.length ? full : u.username;
}

function mapUserLite(row: {
  id: number | null;
  username: string | null;
  name: string | null;
  surname: string | null;
}): UserLite | null {
  if (!row.id || !row.username) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    surname: row.surname,
    label: userLabel({ username: row.username, name: row.name, surname: row.surname }),
  };
}

async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: { action: string; entity_type: string | null; entity_id: string | null; details?: Record<string, unknown> | null }
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

async function insertMetrologieEvent(
  tx: DbQueryer,
  params: {
    equipement_id: string | null;
    event_type: string;
    user_id: number | null;
    old_values: unknown | null;
    new_values: unknown | null;
  }
) {
  await tx.query(
    `
      INSERT INTO public.metrologie_event_log (
        equipement_id,
        event_type,
        old_values,
        new_values,
        user_id
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5)
    `,
    [
      params.equipement_id,
      params.event_type,
      params.old_values === null ? null : JSON.stringify(params.old_values),
      params.new_values === null ? null : JSON.stringify(params.new_values),
      params.user_id,
    ]
  );
}

export function repoMetrologieDocsBaseDir(): string {
  return path.resolve(path.posix.join("uploads", "docs", "metrologie"));
}

function normalizeLikeQuery(q: string): string {
  const trimmed = q.trim();
  return `%${trimmed.replace(/%/g, "\\%")}%`;
}

function sortColumn(sortBy: ListEquipementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "code":
      return "e.code";
    case "designation":
      return "e.designation";
    case "created_at":
      return "e.created_at";
    case "next_due_date":
      return "p.next_due_date";
    case "updated_at":
    default:
      return "e.updated_at";
  }
}

function sortDirection(sortDir: ListEquipementsQueryDTO["sortDir"]): "ASC" | "DESC" {
  return sortDir === "asc" ? "ASC" : "DESC";
}

export async function repoListEquipements(filters: ListEquipementsQueryDTO): Promise<Paginated<MetrologieEquipementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const where: string[] = ["e.deleted_at IS NULL"]; 
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(
      COALESCE(e.code,'') ILIKE ${p}
      OR e.designation ILIKE ${p}
      OR COALESCE(e.numero_serie,'') ILIKE ${p}
      OR COALESCE(e.localisation,'') ILIKE ${p}
    )`);
  }
  if (filters.criticite) where.push(`e.criticite = ${push(filters.criticite)}`);
  if (filters.statut) where.push(`e.statut = ${push(filters.statut)}`);
  if (filters.overdue === true) {
    where.push(`(
      p.deleted_at IS NULL
      AND p.statut = 'EN_COURS'
      AND p.next_due_date IS NOT NULL
      AND p.next_due_date < CURRENT_DATE
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.metrologie_equipements e
      LEFT JOIN public.metrologie_plan p
        ON p.equipement_id = e.id
        AND p.deleted_at IS NULL
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataRes = await db.query<MetrologieEquipementListItem>(
    `
      SELECT
        e.id::text AS id,
        e.code,
        e.designation,
        e.localisation,
        e.criticite,
        e.statut,
        p.last_done_date::text AS last_done_date,
        p.next_due_date::text AS next_due_date,
        (
          p.deleted_at IS NULL
          AND p.statut = 'EN_COURS'
          AND p.next_due_date IS NOT NULL
          AND p.next_due_date < CURRENT_DATE
        ) AS is_overdue,
        e.updated_at::text AS updated_at,
        e.created_at::text AS created_at
      FROM public.metrologie_equipements e
      LEFT JOIN public.metrologie_plan p
        ON p.equipement_id = e.id
        AND p.deleted_at IS NULL
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir} NULLS LAST, e.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  return { items: dataRes.rows, total };
}

export async function repoGetKpis(): Promise<MetrologieKpis> {
  const res = await db.query<{
    total: number;
    actifs: number;
    critiques: number;
    en_retard: number;
    en_retard_critiques: number;
    echeance_30j: number;
  }>(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE e.statut = 'ACTIF')::int AS actifs,
        COUNT(*) FILTER (WHERE e.criticite = 'CRITIQUE')::int AS critiques,
        COUNT(*) FILTER (
          WHERE p.deleted_at IS NULL
            AND p.statut = 'EN_COURS'
            AND p.next_due_date IS NOT NULL
            AND p.next_due_date < CURRENT_DATE
        )::int AS en_retard,
        COUNT(*) FILTER (
          WHERE e.statut = 'ACTIF'
            AND e.criticite = 'CRITIQUE'
            AND p.deleted_at IS NULL
            AND p.statut = 'EN_COURS'
            AND p.next_due_date IS NOT NULL
            AND p.next_due_date < CURRENT_DATE
        )::int AS en_retard_critiques,
        COUNT(*) FILTER (
          WHERE p.deleted_at IS NULL
            AND p.statut = 'EN_COURS'
            AND p.next_due_date IS NOT NULL
            AND p.next_due_date >= CURRENT_DATE
            AND p.next_due_date < (CURRENT_DATE + interval '30 days')
        )::int AS echeance_30j
      FROM public.metrologie_equipements e
      LEFT JOIN public.metrologie_plan p
        ON p.equipement_id = e.id
        AND p.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
    `
  );

  const row = res.rows[0];
  return {
    kpis: {
      total: row?.total ?? 0,
      actifs: row?.actifs ?? 0,
      critiques: row?.critiques ?? 0,
      en_retard: row?.en_retard ?? 0,
      en_retard_critiques: row?.en_retard_critiques ?? 0,
      echeance_30j: row?.echeance_30j ?? 0,
    },
  };
}

export async function repoGetAlerts(): Promise<MetrologieAlerts> {
  const countRes = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.metrologie_equipements e
      JOIN public.metrologie_plan p
        ON p.equipement_id = e.id
        AND p.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND e.statut = 'ACTIF'
        AND e.criticite = 'CRITIQUE'
        AND p.statut = 'EN_COURS'
        AND p.next_due_date IS NOT NULL
        AND p.next_due_date < CURRENT_DATE
    `
  );
  const overdue_critical_count = countRes.rows[0]?.total ?? 0;

  const listRes = await db.query<{
    id: string;
    code: string | null;
    designation: string;
    localisation: string | null;
    criticite: "NORMAL" | "CRITIQUE";
    next_due_date: string;
    days_overdue: number;
  }>(
    `
      SELECT
        e.id::text AS id,
        e.code,
        e.designation,
        e.localisation,
        e.criticite,
        p.next_due_date::text AS next_due_date,
        GREATEST(0, (CURRENT_DATE - p.next_due_date))::int AS days_overdue
      FROM public.metrologie_equipements e
      JOIN public.metrologie_plan p
        ON p.equipement_id = e.id
        AND p.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND e.statut = 'ACTIF'
        AND e.criticite = 'CRITIQUE'
        AND p.statut = 'EN_COURS'
        AND p.next_due_date IS NOT NULL
        AND p.next_due_date < CURRENT_DATE
      ORDER BY p.next_due_date ASC, e.id ASC
      LIMIT 50
    `
  );

  return {
    overdue_critical_count,
    overdue_critical: listRes.rows,
  };
}

type EquipementRow = {
  id: string;
  code: string | null;
  designation: string;
  categorie: string | null;
  marque: string | null;
  modele: string | null;
  numero_serie: string | null;
  localisation: string | null;
  criticite: MetrologieEquipement["criticite"];
  statut: MetrologieEquipement["statut"];
  notes: string | null;
  created_at: string;
  updated_at: string;

  created_by_id: number | null;
  created_by_username: string | null;
  created_by_name: string | null;
  created_by_surname: string | null;
  updated_by_id: number | null;
  updated_by_username: string | null;
  updated_by_name: string | null;
  updated_by_surname: string | null;
};

function mapEquipementRow(r: EquipementRow): MetrologieEquipement {
  return {
    id: r.id,
    code: r.code,
    designation: r.designation,
    categorie: r.categorie,
    marque: r.marque,
    modele: r.modele,
    numero_serie: r.numero_serie,
    localisation: r.localisation,
    criticite: r.criticite,
    statut: r.statut,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: mapUserLite({
      id: r.created_by_id,
      username: r.created_by_username,
      name: r.created_by_name,
      surname: r.created_by_surname,
    }),
    updated_by: mapUserLite({
      id: r.updated_by_id,
      username: r.updated_by_username,
      name: r.updated_by_name,
      surname: r.updated_by_surname,
    }),
  };
}

type PlanRow = {
  id: string;
  equipement_id: string;
  periodicite_mois: number;
  last_done_date: string | null;
  next_due_date: string | null;
  statut: MetrologiePlan["statut"];
  commentaire: string | null;
  created_at: string;
  updated_at: string;

  created_by_id: number | null;
  created_by_username: string | null;
  created_by_name: string | null;
  created_by_surname: string | null;
  updated_by_id: number | null;
  updated_by_username: string | null;
  updated_by_name: string | null;
  updated_by_surname: string | null;
};

function mapPlanRow(r: PlanRow): MetrologiePlan {
  return {
    id: r.id,
    equipement_id: r.equipement_id,
    periodicite_mois: r.periodicite_mois,
    last_done_date: r.last_done_date,
    next_due_date: r.next_due_date,
    statut: r.statut,
    commentaire: r.commentaire,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: mapUserLite({
      id: r.created_by_id,
      username: r.created_by_username,
      name: r.created_by_name,
      surname: r.created_by_surname,
    }),
    updated_by: mapUserLite({
      id: r.updated_by_id,
      username: r.updated_by_username,
      name: r.updated_by_name,
      surname: r.updated_by_surname,
    }),
  };
}

type CertRow = {
  id: string;
  equipement_id: string;
  date_etalonnage: string;
  date_echeance: string | null;
  resultat: MetrologieCertificat["resultat"];
  organisme: string | null;
  commentaire: string | null;
  file_original_name: string | null;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  created_at: string;
  updated_at: string;

  created_by_id: number | null;
  created_by_username: string | null;
  created_by_name: string | null;
  created_by_surname: string | null;
  updated_by_id: number | null;
  updated_by_username: string | null;
  updated_by_name: string | null;
  updated_by_surname: string | null;
};

function mapCertRow(r: CertRow): MetrologieCertificat {
  return {
    id: r.id,
    equipement_id: r.equipement_id,
    date_etalonnage: r.date_etalonnage,
    date_echeance: r.date_echeance,
    resultat: r.resultat,
    organisme: r.organisme,
    commentaire: r.commentaire,
    file_original_name: r.file_original_name,
    storage_path: r.storage_path,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes !== null && r.size_bytes !== undefined ? Number(r.size_bytes) : null,
    sha256: r.sha256,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: mapUserLite({
      id: r.created_by_id,
      username: r.created_by_username,
      name: r.created_by_name,
      surname: r.created_by_surname,
    }),
    updated_by: mapUserLite({
      id: r.updated_by_id,
      username: r.updated_by_username,
      name: r.updated_by_name,
      surname: r.updated_by_surname,
    }),
  };
}

type EventRow = {
  id: string;
  equipement_id: string | null;
  event_type: string;
  old_values: unknown | null;
  new_values: unknown | null;
  created_at: string;
  user_id: number | null;
  username: string | null;
  name: string | null;
  surname: string | null;
};

function mapEventRow(r: EventRow): MetrologieEventLog {
  return {
    id: r.id,
    equipement_id: r.equipement_id,
    event_type: r.event_type,
    old_values: r.old_values ?? null,
    new_values: r.new_values ?? null,
    user: mapUserLite({ id: r.user_id, username: r.username, name: r.name, surname: r.surname }),
    created_at: r.created_at,
  };
}

export async function repoGetEquipementDetail(id: string): Promise<MetrologieEquipementDetail | null> {
  const coreRes = await db.query<EquipementRow>(
    `
      SELECT
        e.id::text AS id,
        e.code,
        e.designation,
        e.categorie,
        e.marque,
        e.modele,
        e.numero_serie,
        e.localisation,
        e.criticite,
        e.statut,
        e.notes,
        e.created_at::text AS created_at,
        e.updated_at::text AS updated_at,

        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.metrologie_equipements e
      LEFT JOIN public.users cb ON cb.id = e.created_by
      LEFT JOIN public.users ub ON ub.id = e.updated_by
      WHERE e.id = $1::uuid
        AND e.deleted_at IS NULL
      LIMIT 1
    `,
    [id]
  );
  const core = coreRes.rows[0] ?? null;
  if (!core) return null;
  const equipement = mapEquipementRow(core);

  const planRes = await db.query<PlanRow>(
    `
      SELECT
        p.id::text AS id,
        p.equipement_id::text AS equipement_id,
        p.periodicite_mois,
        p.last_done_date::text AS last_done_date,
        p.next_due_date::text AS next_due_date,
        p.statut,
        p.commentaire,
        p.created_at::text AS created_at,
        p.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.metrologie_plan p
      LEFT JOIN public.users cb ON cb.id = p.created_by
      LEFT JOIN public.users ub ON ub.id = p.updated_by
      WHERE p.equipement_id = $1::uuid
        AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 1
    `,
    [id]
  );
  const plan = planRes.rows[0] ? mapPlanRow(planRes.rows[0]) : null;

  const certRes = await db.query<CertRow>(
    `
      SELECT
        c.id::text AS id,
        c.equipement_id::text AS equipement_id,
        c.date_etalonnage::text AS date_etalonnage,
        c.date_echeance::text AS date_echeance,
        c.resultat,
        c.organisme,
        c.commentaire,
        c.file_original_name,
        c.storage_path,
        c.mime_type,
        c.size_bytes::text AS size_bytes,
        c.sha256,
        c.created_at::text AS created_at,
        c.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.metrologie_certificats c
      LEFT JOIN public.users cb ON cb.id = c.created_by
      LEFT JOIN public.users ub ON ub.id = c.updated_by
      WHERE c.equipement_id = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.date_etalonnage DESC, c.created_at DESC, c.id DESC
    `,
    [id]
  );
  const certificats = certRes.rows.map(mapCertRow);

  const eventsRes = await db.query<EventRow>(
    `
      SELECT
        e.id::text AS id,
        e.equipement_id::text AS equipement_id,
        e.event_type,
        e.old_values,
        e.new_values,
        e.created_at::text AS created_at,
        u.id AS user_id,
        u.username,
        u.name,
        u.surname
      FROM public.metrologie_event_log e
      LEFT JOIN public.users u ON u.id = e.user_id
      WHERE e.equipement_id = $1::uuid
      ORDER BY e.created_at ASC, e.id ASC
    `,
    [id]
  );
  const events = eventsRes.rows.map(mapEventRow);

  return { equipement, plan, certificats, events };
}

export async function repoCreateEquipement(body: CreateEquipementBodyDTO, audit: AuditContext): Promise<MetrologieEquipementDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.metrologie_equipements (
          code,
          designation,
          categorie,
          marque,
          modele,
          numero_serie,
          localisation,
          criticite,
          statut,
          notes,
          created_by,
          updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
        RETURNING id::text AS id
      `,
      [
        body.code ?? null,
        body.designation,
        body.categorie ?? null,
        body.marque ?? null,
        body.modele ?? null,
        body.numero_serie ?? null,
        body.localisation ?? null,
        body.criticite,
        body.statut,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create equipement");

    await insertMetrologieEvent(client, {
      equipement_id: id,
      event_type: "EQUIPEMENT_CREATE",
      user_id: audit.user_id,
      old_values: null,
      new_values: { id, ...body },
    });

    await insertAuditLog(client, audit, {
      action: "metrologie.equipements.create",
      entity_type: "metrologie_equipements",
      entity_id: id,
      details: { code: body.code ?? null, designation: body.designation, criticite: body.criticite, statut: body.statut },
    });

    await client.query("COMMIT");
    const out = await repoGetEquipementDetail(id);
    if (!out) throw new Error("Failed to reload equipement");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "metrologie_equipements_code_uniq") {
      throw new HttpError(409, "DUPLICATE", "Equipement code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPatchEquipement(
  id: string,
  body: PatchEquipementBodyDTO,
  audit: AuditContext
): Promise<MetrologieEquipementDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const currentRes = await client.query<{
      code: string | null;
      designation: string;
      categorie: string | null;
      marque: string | null;
      modele: string | null;
      numero_serie: string | null;
      localisation: string | null;
      criticite: MetrologieEquipement["criticite"];
      statut: MetrologieEquipement["statut"];
      notes: string | null;
    }>(
      `
        SELECT
          code,
          designation,
          categorie,
          marque,
          modele,
          numero_serie,
          localisation,
          criticite,
          statut,
          notes
        FROM public.metrologie_equipements
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [id]
    );
    const current = currentRes.rows[0] ?? null;
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }

    const patch = body.patch;
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    const setIfDefined = (key: keyof typeof patch, sql: string, cast?: string) => {
      const v = patch[key];
      if (v === undefined) return;
      oldValues[key] = current[key as keyof typeof current] ?? null;
      newValues[key] = v ?? null;
      sets.push(`${sql} = ${push(v ?? null)}${cast ?? ""}`);
    };

    setIfDefined("code", "code");
    setIfDefined("designation", "designation");
    setIfDefined("categorie", "categorie");
    setIfDefined("marque", "marque");
    setIfDefined("modele", "modele");
    setIfDefined("numero_serie", "numero_serie");
    setIfDefined("localisation", "localisation");
    setIfDefined("criticite", "criticite");
    setIfDefined("statut", "statut");
    setIfDefined("notes", "notes");

    if (sets.length) {
      sets.push(`updated_at = now()`);
      sets.push(`updated_by = ${push(audit.user_id)}`);
      await client.query(
        `UPDATE public.metrologie_equipements SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid`,
        values
      );
    }

    await insertMetrologieEvent(client, {
      equipement_id: id,
      event_type: "EQUIPEMENT_UPDATE",
      user_id: audit.user_id,
      old_values: sets.length ? oldValues : null,
      new_values: sets.length ? newValues : null,
    });

    await insertAuditLog(client, audit, {
      action: "metrologie.equipements.update",
      entity_type: "metrologie_equipements",
      entity_id: id,
      details: { note: body.note ?? null, patch: newValues },
    });

    await client.query("COMMIT");
    return repoGetEquipementDetail(id);
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "metrologie_equipements_code_uniq") {
      throw new HttpError(409, "DUPLICATE", "Equipement code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteEquipement(id: string, audit: AuditContext): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentRes = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.metrologie_equipements WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    if (!currentRes.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
        UPDATE public.metrologie_equipements
        SET
          deleted_at = now(),
          deleted_by = $2,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
          AND deleted_at IS NULL
      `,
      [id, audit.user_id]
    );

    await insertMetrologieEvent(client, {
      equipement_id: id,
      event_type: "EQUIPEMENT_DELETE",
      user_id: audit.user_id,
      old_values: { id },
      new_values: null,
    });
    await insertAuditLog(client, audit, {
      action: "metrologie.equipements.delete",
      entity_type: "metrologie_equipements",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpsertPlan(equipementId: string, body: UpsertPlanBodyDTO, audit: AuditContext): Promise<MetrologiePlan | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const equipOk = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.metrologie_equipements WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
      [equipementId]
    );
    if (!equipOk.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const currentRes = await client.query<{
      id: string;
      periodicite_mois: number;
      last_done_date: string | null;
      next_due_date: string | null;
      statut: MetrologiePlan["statut"];
      commentaire: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          periodicite_mois,
          last_done_date::text AS last_done_date,
          next_due_date::text AS next_due_date,
          statut,
          commentaire
        FROM public.metrologie_plan
        WHERE equipement_id = $1::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [equipementId]
    );
    const current = currentRes.rows[0] ?? null;

    const lastDoneProvided = body.last_done_date !== undefined;
    const nextDueProvided = body.next_due_date !== undefined;
    const commentaireProvided = body.commentaire !== undefined;
    const shouldRecomputeNextDue = !nextDueProvided && lastDoneProvided && body.last_done_date !== null;

    let planId: string;
    if (current) {
      await client.query(
        `
          UPDATE public.metrologie_plan
          SET
            periodicite_mois = $2,
            last_done_date = CASE WHEN $8::boolean THEN $3::date ELSE last_done_date END,
            next_due_date = CASE
              WHEN $9::boolean THEN $4::date
              WHEN $10::boolean THEN ($3::date + ($2::text || ' months')::interval)::date
              ELSE next_due_date
            END,
            statut = $5,
            commentaire = CASE WHEN $11::boolean THEN $6 ELSE commentaire END,
            updated_at = now(),
            updated_by = $7
          WHERE id = $1::uuid
        `,
        [
          current.id,
          body.periodicite_mois,
          body.last_done_date ?? null,
          body.next_due_date ?? null,
          body.statut,
          body.commentaire ?? null,
          audit.user_id,
          lastDoneProvided,
          nextDueProvided,
          shouldRecomputeNextDue,
          commentaireProvided,
        ]
      );
      planId = current.id;
    } else {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.metrologie_plan (
            equipement_id,
            periodicite_mois,
            last_done_date,
            next_due_date,
            statut,
            commentaire,
            created_by,
            updated_by
          )
          VALUES (
            $1::uuid,
            $2,
            $3::date,
            CASE
              WHEN $4::date IS NOT NULL THEN $4::date
              WHEN $3::date IS NOT NULL THEN ($3::date + ($2::text || ' months')::interval)::date
              ELSE NULL
            END,
            $5,
            $6,
            $7,
            $7
          )
          RETURNING id::text AS id
        `,
        [
          equipementId,
          body.periodicite_mois,
          body.last_done_date ?? null,
          body.next_due_date ?? null,
          body.statut,
          body.commentaire ?? null,
          audit.user_id,
        ]
      );
      planId = ins.rows[0]?.id ?? "";
      if (!planId) throw new Error("Failed to insert plan");
    }

    await insertMetrologieEvent(client, {
      equipement_id: equipementId,
      event_type: "PLAN_UPSERT",
      user_id: audit.user_id,
      old_values: current,
      new_values: { equipement_id: equipementId, ...body },
    });
    await insertAuditLog(client, audit, {
      action: "metrologie.plan.upsert",
      entity_type: "metrologie_plan",
      entity_id: planId,
      details: { equipement_id: equipementId, periodicite_mois: body.periodicite_mois },
    });

    await client.query("COMMIT");

    const planRes = await db.query<PlanRow>(
      `
        SELECT
          p.id::text AS id,
          p.equipement_id::text AS equipement_id,
          p.periodicite_mois,
          p.last_done_date::text AS last_done_date,
          p.next_due_date::text AS next_due_date,
          p.statut,
          p.commentaire,
          p.created_at::text AS created_at,
          p.updated_at::text AS updated_at,
          cb.id AS created_by_id,
          cb.username AS created_by_username,
          cb.name AS created_by_name,
          cb.surname AS created_by_surname,
          ub.id AS updated_by_id,
          ub.username AS updated_by_username,
          ub.name AS updated_by_name,
          ub.surname AS updated_by_surname
        FROM public.metrologie_plan p
        LEFT JOIN public.users cb ON cb.id = p.created_by
        LEFT JOIN public.users ub ON ub.id = p.updated_by
        WHERE p.id = $1::uuid
        LIMIT 1
      `,
      [planId]
    );

    const row = planRes.rows[0] ?? null;
    return row ? mapPlanRow(row) : null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase();
  const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
  return safeExt;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function repoListCertificats(equipementId: string): Promise<MetrologieCertificat[] | null> {
  const equipOk = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.metrologie_equipements WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
    [equipementId]
  );
  if (!equipOk.rows[0]?.ok) return null;

  const certRes = await db.query<CertRow>(
    `
      SELECT
        c.id::text AS id,
        c.equipement_id::text AS equipement_id,
        c.date_etalonnage::text AS date_etalonnage,
        c.date_echeance::text AS date_echeance,
        c.resultat,
        c.organisme,
        c.commentaire,
        c.file_original_name,
        c.storage_path,
        c.mime_type,
        c.size_bytes::text AS size_bytes,
        c.sha256,
        c.created_at::text AS created_at,
        c.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.metrologie_certificats c
      LEFT JOIN public.users cb ON cb.id = c.created_by
      LEFT JOIN public.users ub ON ub.id = c.updated_by
      WHERE c.equipement_id = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.date_etalonnage DESC, c.created_at DESC, c.id DESC
    `,
    [equipementId]
  );
  return certRes.rows.map(mapCertRow);
}

export async function repoAttachCertificats(params: {
  equipement_id: string;
  body: CreateCertificatBodyDTO;
  documents: Express.Multer.File[];
  audit: AuditContext;
}): Promise<MetrologieCertificat[] | null> {
  const { equipement_id, body, documents, audit } = params;
  const client = await pool.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "metrologie");
  const docsDirAbs = path.resolve(docsDirRel);

  try {
    await client.query("BEGIN");

    const equipOk = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.metrologie_equipements WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
      [equipement_id]
    );
    if (!equipOk.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!documents.length) {
      await client.query("COMMIT");
      return [];
    }

    await fs.mkdir(docsDirAbs, { recursive: true });

    const inserted: MetrologieCertificat[] = [];
    for (const doc of documents) {
      const certId = crypto.randomUUID();
      const safeExt = safeDocExtension(doc.originalname);
      const storedName = `${certId}${safeExt}`;
      const relPath = toPosixPath(path.join(docsDirRel, storedName));
      const absPath = path.join(docsDirAbs, storedName);
      const tempPath = path.resolve(doc.path);

      try {
        await fs.rename(tempPath, absPath);
      } catch {
        await fs.copyFile(tempPath, absPath);
        await fs.unlink(tempPath);
      }

      const hash = await sha256File(absPath);

      const ins = await client.query<CertRow>(
        `
          INSERT INTO public.metrologie_certificats (
            id,
            equipement_id,
            date_etalonnage,
            date_echeance,
            resultat,
            organisme,
            commentaire,
            file_original_name,
            storage_path,
            mime_type,
            size_bytes,
            sha256,
            created_by,
            updated_by
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3::date,
            $4::date,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $13
          )
          RETURNING
            id::text AS id,
            equipement_id::text AS equipement_id,
            date_etalonnage::text AS date_etalonnage,
            date_echeance::text AS date_echeance,
            resultat,
            organisme,
            commentaire,
            file_original_name,
            storage_path,
            mime_type,
            size_bytes::text AS size_bytes,
            sha256,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            NULL::int AS created_by_id,
            NULL::text AS created_by_username,
            NULL::text AS created_by_name,
            NULL::text AS created_by_surname,
            NULL::int AS updated_by_id,
            NULL::text AS updated_by_username,
            NULL::text AS updated_by_name,
            NULL::text AS updated_by_surname
        `,
        [
          certId,
          equipement_id,
          body.date_etalonnage,
          body.date_echeance ?? null,
          body.resultat,
          body.organisme ?? null,
          body.commentaire ?? null,
          doc.originalname,
          relPath,
          doc.mimetype,
          doc.size,
          hash,
          audit.user_id,
        ]
      );
      const row = ins.rows[0] ?? null;
      if (!row) throw new Error("Failed to insert certificat");
      inserted.push(mapCertRow(row));
    }

    // Update plan when present
    const planRes = await client.query<{ id: string; periodicite_mois: number }>(
      `
        SELECT id::text AS id, periodicite_mois
        FROM public.metrologie_plan
        WHERE equipement_id = $1::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [equipement_id]
    );
    const plan = planRes.rows[0] ?? null;
    if (plan) {
      await client.query(
        `
          UPDATE public.metrologie_plan
          SET
            last_done_date = $2::date,
            next_due_date = CASE
              WHEN $3::date IS NOT NULL THEN $3::date
              ELSE ($2::date + (periodicite_mois::text || ' months')::interval)::date
            END,
            updated_at = now(),
            updated_by = $4
          WHERE id = $1::uuid
        `,
        [plan.id, body.date_etalonnage, body.date_echeance ?? null, audit.user_id]
      );
    }

    await insertMetrologieEvent(client, {
      equipement_id,
      event_type: "CERTIFICAT_ATTACH",
      user_id: audit.user_id,
      old_values: null,
      new_values: {
        count: inserted.length,
        certificats: inserted.map((c) => ({ id: c.id, date_etalonnage: c.date_etalonnage, resultat: c.resultat })),
      },
    });
    await insertAuditLog(client, audit, {
      action: "metrologie.certificats.attach",
      entity_type: "metrologie_certificats",
      entity_id: equipement_id,
      details: { equipement_id, count: inserted.length, date_etalonnage: body.date_etalonnage, resultat: body.resultat },
    });

    await client.query("COMMIT");
    return inserted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoRemoveCertificat(params: {
  equipement_id: string;
  certificat_id: string;
  audit: AuditContext;
}): Promise<boolean | null> {
  const { equipement_id, certificat_id, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentRes = await client.query<{ file_original_name: string | null; storage_path: string | null }>(
      `
        SELECT file_original_name, storage_path
        FROM public.metrologie_certificats
        WHERE id = $1::uuid
          AND equipement_id = $2::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [certificat_id, equipement_id]
    );
    const current = currentRes.rows[0] ?? null;
    if (!current) {
      await client.query("ROLLBACK");
      return false;
    }

    const upd = await client.query(
      `
        UPDATE public.metrologie_certificats
        SET deleted_at = now(), deleted_by = $3, updated_at = now(), updated_by = $3
        WHERE id = $1::uuid
          AND equipement_id = $2::uuid
          AND deleted_at IS NULL
      `,
      [certificat_id, equipement_id, audit.user_id]
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertMetrologieEvent(client, {
      equipement_id,
      event_type: "CERTIFICAT_REMOVE",
      user_id: audit.user_id,
      old_values: { certificat_id, file_original_name: current.file_original_name, storage_path: current.storage_path },
      new_values: null,
    });
    await insertAuditLog(client, audit, {
      action: "metrologie.certificats.remove",
      entity_type: "metrologie_certificats",
      entity_id: certificat_id,
      details: { equipement_id, certificat_id },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetCertificatForDownload(params: {
  equipement_id: string;
  certificat_id: string;
  audit: AuditContext;
}): Promise<Pick<MetrologieCertificat, "storage_path" | "mime_type" | "file_original_name"> | null> {
  const { equipement_id, certificat_id, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ storage_path: string | null; mime_type: string | null; file_original_name: string | null }>(
      `
        SELECT storage_path, mime_type, file_original_name
        FROM public.metrologie_certificats
        WHERE id = $1::uuid
          AND equipement_id = $2::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [certificat_id, equipement_id]
    );
    const row = res.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, audit, {
      action: "metrologie.certificats.download",
      entity_type: "metrologie_certificats",
      entity_id: certificat_id,
      details: { equipement_id, certificat_id },
    });
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const METROLOGIE_BLOCK_SETTING_KEY = "metrologie.block_on_overdue_critical";

export async function repoGetMetrologieBlockState(q: Pick<DbQueryer, "query">): Promise<{ enabled: boolean; overdue_critical: number }> {
  try {
    const settingRes = await q.query<{ value_json: unknown }>(
      `SELECT value_json FROM public.erp_settings WHERE key = $1`,
      [METROLOGIE_BLOCK_SETTING_KEY]
    );
    const raw = settingRes.rows[0]?.value_json ?? null;
    const enabled = isRecord(raw) && raw.enabled === true;
    if (!enabled) return { enabled: false, overdue_critical: 0 };

    const countRes = await q.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM public.metrologie_equipements e
        JOIN public.metrologie_plan p
          ON p.equipement_id = e.id
          AND p.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
          AND e.statut = 'ACTIF'
          AND e.criticite = 'CRITIQUE'
          AND p.statut = 'EN_COURS'
          AND p.next_due_date IS NOT NULL
          AND p.next_due_date < CURRENT_DATE
      `
    );
    return { enabled: true, overdue_critical: countRes.rows[0]?.total ?? 0 };
  } catch {
    return { enabled: false, overdue_critical: 0 };
  }
}
