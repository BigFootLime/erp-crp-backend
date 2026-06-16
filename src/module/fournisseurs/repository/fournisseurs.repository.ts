import type { PoolClient } from "pg"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import db from "../../../config/database"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators"
import type {
  AttachDocumentsBodyDTO,
  CreateCatalogueBodyDTO,
  CreateContactBodyDTO,
  CreateFournisseurBodyDTO,
  FournisseurDomaineLienInputDTO,
  ListCatalogueQueryDTO,
  ListFournisseursQueryDTO,
  PutFournisseurDomainesBodyDTO,
  UpdateCatalogueBodyDTO,
  UpdateContactBodyDTO,
  UpdateFournisseurBodyDTO,
} from "../validators/fournisseurs.validators"
import type {
  Fournisseur,
  FournisseurCatalogueItem,
  FournisseurContact,
  FournisseurDomaine,
  FournisseurDomaineLien,
  FournisseurEvent,
  FournisseurDocument,
  FournisseurListItem,
  FournisseurRelations,
  Paginated,
} from "../types/fournisseurs.types"

export type AuditContext = {
  user_id: number
  ip: string | null
  user_agent: string | null
  device_type: string | null
  os: string | null
  browser: string | null
  path: string | null
  page_key: string | null
  client_session_id: string | null
}

type DbQueryer = Pick<PoolClient, "query">
type UploadedDocument = Express.Multer.File

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase()
  return /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : ""
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest("hex")
}

async function insertAuditLog(tx: DbQueryer, audit: AuditContext, entry: {
  action: string
  entity_type: string | null
  entity_id: string | null
  details?: Record<string, unknown> | null
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  }

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  })
}

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505"
}

async function ensureFournisseurExists(tx: DbQueryer, fournisseurId: string): Promise<boolean> {
  const res = await tx.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.fournisseurs WHERE id = $1::uuid LIMIT 1`,
    [fournisseurId]
  )
  return Boolean(res.rows[0]?.ok)
}

type FournisseurRow = {
  id: string
  code: string
  nom: string
  actif: boolean
  status: string | null
  type_principal: string | null
  tva: string | null
  siret: string | null
  email: string | null
  telephone: string | null
  site_web: string | null
  adresse_ligne: string | null
  house_no: string | null
  postcode: string | null
  city: string | null
  country: string | null
  nom_commercial: string | null
  logo: string | null
  notes: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
  domaines_json: FournisseurDomaineLien[] | string | null
  outillage_id_fournisseur: number | null
  outillage_outils_count: number | string | null
  outillage_fabricants_count: number | string | null
  outillage_prix_count: number | string | null
  outillage_mouvements_count: number | string | null
  contacts_count: number | string | null
  catalogue_count: number | string | null
  documents_count: number | string | null
  events_count: number | string | null
}

function toInt(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function parseDomaines(value: FournisseurDomaineLien[] | string | null | undefined): FournisseurDomaineLien[] {
  if (Array.isArray(value)) return value
  if (typeof value !== "string" || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as FournisseurDomaineLien[] : []
  } catch {
    return []
  }
}

function normalizeStatus(row: Pick<FournisseurRow, "status" | "actif" | "archived_at">): Fournisseur["status"] {
  if (row.archived_at) return "archive"
  if (row.status === "a_completer" || row.status === "inactif" || row.status === "archive" || row.status === "actif") return row.status
  return row.actif ? "actif" : "inactif"
}

function mapRelations(r: FournisseurRow): FournisseurRelations {
  if (r.outillage_id_fournisseur === null || typeof r.outillage_id_fournisseur === "undefined") {
    return { outillage: null }
  }

  return {
    outillage: {
      id_fournisseur: Number(r.outillage_id_fournisseur),
      outils_count: toInt(r.outillage_outils_count),
      fabricants_count: toInt(r.outillage_fabricants_count),
      prix_count: toInt(r.outillage_prix_count),
      mouvements_count: toInt(r.outillage_mouvements_count),
    },
  }
}

function mapFournisseurRow(r: FournisseurRow): Fournisseur {
  return {
    id: r.id,
    code: r.code,
    nom: r.nom,
    actif: r.actif,
    status: normalizeStatus(r),
    type_principal: r.type_principal,
    tva: r.tva,
    siret: r.siret,
    email: r.email,
    telephone: r.telephone,
    site_web: r.site_web,
    adresse_ligne: r.adresse_ligne,
    house_no: r.house_no,
    postcode: r.postcode,
    city: r.city,
    country: r.country,
    nom_commercial: r.nom_commercial,
    logo: r.logo,
    notes: r.notes,
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
    domaines: parseDomaines(r.domaines_json),
    relations: mapRelations(r),
    contacts_count: toInt(r.contacts_count),
    catalogue_count: toInt(r.catalogue_count),
    documents_count: toInt(r.documents_count),
    events_count: toInt(r.events_count),
  }
}

function sortColumn(sortBy: ListFournisseursQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "code":
      return "COALESCE(f.code, f.code_fournisseur)"
    case "nom":
      return "COALESCE(f.nom, f.raison_sociale)"
    case "updated_at":
    default:
      return "f.updated_at"
  }
}

function sortDirection(sortDir: ListFournisseursQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC"
}

const fournisseurSelectFields = `
  f.id::text AS id,
  COALESCE(f.code, f.code_fournisseur) AS code,
  COALESCE(f.nom, f.raison_sociale) AS nom,
  f.actif,
  f.status,
  f.type_principal,
  f.tva,
  f.siret,
  f.email,
  f.telephone,
  f.site_web,
  f.adresse_ligne,
  f.house_no,
  f.postcode,
  f.city,
  f.country,
  f.nom_commercial,
  f.logo,
  f.notes,
  f.archived_at::text AS archived_at,
  f.created_at::text AS created_at,
  f.updated_at::text AS updated_at,
  f.created_by,
  f.updated_by,
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', d.id::text,
          'code', d.code,
          'label', d.label,
          'description', d.description,
          'icon', d.icon,
          'sort_order', d.sort_order,
          'is_active', d.is_active,
          'is_primary', l.is_primary,
          'notes', l.notes
        )
        ORDER BY l.is_primary DESC, d.sort_order ASC, d.label ASC
      ),
      '[]'::jsonb
    )
    FROM public.fournisseur_domaine_lien l
    JOIN public.fournisseur_domaines d ON d.id = l.domaine_id
    WHERE l.fournisseur_id = f.id
      AND d.is_active = true
  ) AS domaines_json,
  fom.id_fournisseur AS outillage_id_fournisseur,
  CASE WHEN fom.id_fournisseur IS NULL THEN 0 ELSE (
    SELECT COUNT(*)::int
    FROM public.gestion_outils_outil_fournisseur oof
    WHERE oof.id_fournisseur = fom.id_fournisseur
  ) END AS outillage_outils_count,
  CASE WHEN fom.id_fournisseur IS NULL THEN 0 ELSE (
    SELECT COUNT(*)::int
    FROM public.gestion_outils_fournisseur_fabricant ff
    WHERE ff.id_fournisseur = fom.id_fournisseur
  ) END AS outillage_fabricants_count,
  CASE WHEN fom.id_fournisseur IS NULL THEN 0 ELSE (
    SELECT COUNT(*)::int
    FROM public.gestion_outils_historique_prix hp
    WHERE hp.id_fournisseur = fom.id_fournisseur
  ) END AS outillage_prix_count,
  CASE WHEN fom.id_fournisseur IS NULL THEN 0 ELSE (
    SELECT COUNT(*)::int
    FROM public.gestion_outils_mouvement_stock ms
    WHERE ms.id_fournisseur = fom.id_fournisseur
  ) END AS outillage_mouvements_count,
  (
    SELECT COUNT(*)::int
    FROM public.fournisseur_contacts c
    WHERE c.fournisseur_id = f.id
      AND c.actif = true
  ) AS contacts_count,
  (
    SELECT COUNT(*)::int
    FROM public.fournisseur_catalogue cat
    WHERE cat.fournisseur_id = f.id
      AND cat.actif = true
  ) AS catalogue_count,
  (
    SELECT COUNT(*)::int
    FROM public.fournisseur_documents doc
    WHERE doc.fournisseur_id = f.id
      AND doc.removed_at IS NULL
  ) AS documents_count,
  (
    SELECT COUNT(*)::int
    FROM public.fournisseur_events ev
    WHERE ev.fournisseur_id = f.id
  ) AS events_count
`

export async function repoListFournisseurs(filters: ListFournisseursQueryDTO): Promise<Paginated<FournisseurListItem>> {
  const where: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (filters.search && filters.search.trim()) {
    const q = `%${filters.search.trim()}%`
    const p = push(q)
    where.push(`(
      COALESCE(f.code, f.code_fournisseur) ILIKE ${p}
      OR COALESCE(f.nom, f.raison_sociale) ILIKE ${p}
      OR f.email ILIKE ${p}
      OR f.telephone ILIKE ${p}
      OR f.city ILIKE ${p}
      OR f.country ILIKE ${p}
      OR EXISTS (
        SELECT 1
        FROM public.fournisseur_contacts c
        WHERE c.fournisseur_id = f.id
          AND c.actif = true
          AND (
            c.nom ILIKE ${p}
            OR c.full_name ILIKE ${p}
            OR c.email ILIKE ${p}
            OR c.telephone ILIKE ${p}
            OR c.mobile ILIKE ${p}
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.fournisseur_domaine_lien l
        JOIN public.fournisseur_domaines d ON d.id = l.domaine_id
        WHERE l.fournisseur_id = f.id
          AND (d.code ILIKE ${p} OR d.label ILIKE ${p})
      )
      OR EXISTS (
        SELECT 1
        FROM public.fournisseur_outillage_mapping om
        JOIN public.gestion_outils_fournisseur of ON of.id_fournisseur = om.id_fournisseur
        WHERE om.fournisseur_id = f.id
          AND of.nom ILIKE ${p}
      )
    )`)
  }
  if (typeof filters.actif === "boolean") {
    where.push(`f.actif = ${push(filters.actif)}`)
  }
  if (filters.status) {
    where.push(`COALESCE(f.status, CASE WHEN f.actif THEN 'actif' ELSE 'inactif' END) = ${push(filters.status)}`)
  }
  const domaineCodes = filters.domaines?.split(",").map((item) => item.trim()).filter(Boolean) ?? []
  if (domaineCodes.length) {
    where.push(`EXISTS (
      SELECT 1
      FROM public.fournisseur_domaine_lien l
      JOIN public.fournisseur_domaines d ON d.id = l.domaine_id
      WHERE l.fournisseur_id = f.id
        AND d.code = ANY(${push(domaineCodes)}::text[])
    )`)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 20
  const offset = (page - 1) * pageSize
  const orderBy = sortColumn(filters.sortBy)
  const orderDir = sortDirection(filters.sortDir)

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.fournisseurs f ${whereSql}`,
    values
  )
  const total = countRes.rows[0]?.total ?? 0

  const dataRes = await db.query<FournisseurRow>(
    `
      SELECT
        ${fournisseurSelectFields}
      FROM public.fournisseurs f
      LEFT JOIN public.fournisseur_outillage_mapping fom ON fom.fournisseur_id = f.id
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, f.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  )

  const items: FournisseurListItem[] = dataRes.rows.map((r) => {
    const f = mapFournisseurRow(r)
    return {
      id: f.id,
      code: f.code,
      nom: f.nom,
      actif: f.actif,
      status: f.status,
      type_principal: f.type_principal,
      email: f.email,
      telephone: f.telephone,
      city: f.city,
      country: f.country,
      logo: f.logo,
      updated_at: f.updated_at,
      domaines: f.domaines,
      relations: f.relations,
      contacts_count: f.contacts_count,
      catalogue_count: f.catalogue_count,
      documents_count: f.documents_count,
      events_count: f.events_count,
    }
  })

  return { items, total }
}

export async function repoGetFournisseur(id: string): Promise<Fournisseur | null> {
  const res = await db.query<FournisseurRow>(
    `
      SELECT
        ${fournisseurSelectFields}
      FROM public.fournisseurs f
      LEFT JOIN public.fournisseur_outillage_mapping fom ON fom.fournisseur_id = f.id
      WHERE f.id = $1::uuid
      LIMIT 1
    `,
    [id]
  )
  const row = res.rows[0] ?? null
  return row ? mapFournisseurRow(row) : null
}

function normalizeDomainLinks(links: FournisseurDomaineLienInputDTO[] | undefined): FournisseurDomaineLienInputDTO[] {
  if (!Array.isArray(links)) return []

  const byCode = new Map<string, FournisseurDomaineLienInputDTO>()
  for (const link of links) {
    const code = link.domaine_code.trim()
    if (!code) continue
    if (!byCode.has(code)) {
      byCode.set(code, { domaine_code: code, is_primary: Boolean(link.is_primary), notes: link.notes ?? null })
      continue
    }
    const current = byCode.get(code)!
    byCode.set(code, {
      domaine_code: code,
      is_primary: current.is_primary || Boolean(link.is_primary),
      notes: current.notes ?? link.notes ?? null,
    })
  }

  const normalized = Array.from(byCode.values())
  if (!normalized.length) return []
  const primaryIndex = normalized.findIndex((link) => link.is_primary)
  return normalized.map((link, index) => ({
    ...link,
    is_primary: primaryIndex >= 0 ? index === primaryIndex : index === 0,
  }))
}

function primaryDomainCode(links: FournisseurDomaineLienInputDTO[] | undefined): string | null {
  const normalized = normalizeDomainLinks(links)
  return normalized.find((link) => link.is_primary)?.domaine_code ?? normalized[0]?.domaine_code ?? null
}

async function replaceFournisseurDomainesTx(
  tx: DbQueryer,
  fournisseurId: string,
  links: FournisseurDomaineLienInputDTO[] | undefined,
  audit: AuditContext
) {
  const normalized = normalizeDomainLinks(links)

  await tx.query(`DELETE FROM public.fournisseur_domaine_lien WHERE fournisseur_id = $1::uuid`, [fournisseurId])

  for (const link of normalized) {
    const inserted = await tx.query(
      `
        INSERT INTO public.fournisseur_domaine_lien (
          fournisseur_id,
          domaine_id,
          is_primary,
          notes,
          created_by,
          updated_by
        )
        SELECT $1::uuid, d.id, $3, $4, $5, $5
        FROM public.fournisseur_domaines d
        WHERE d.code = $2
          AND d.is_active = true
        ON CONFLICT (fournisseur_id, domaine_id) DO UPDATE SET
          is_primary = EXCLUDED.is_primary,
          notes = EXCLUDED.notes,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
      `,
      [fournisseurId, link.domaine_code, link.is_primary, link.notes ?? null, audit.user_id]
    )
    if ((inserted.rowCount ?? 0) === 0) {
      throw new HttpError(400, "UNKNOWN_FOURNISSEUR_DOMAIN", `Domaine fournisseur inconnu: ${link.domaine_code}`)
    }
  }

  await tx.query(
    `
      UPDATE public.fournisseurs f
      SET
        type_principal = (
          SELECT d.code
          FROM public.fournisseur_domaine_lien l
          JOIN public.fournisseur_domaines d ON d.id = l.domaine_id
          WHERE l.fournisseur_id = f.id
          ORDER BY l.is_primary DESC, d.sort_order ASC, d.label ASC
          LIMIT 1
        ),
        updated_at = now(),
        updated_by = $2
      WHERE f.id = $1::uuid
    `,
    [fournisseurId, audit.user_id]
  )
}

export async function repoCreateFournisseur(body: CreateFournisseurBodyDTO, audit: AuditContext): Promise<Fournisseur> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const mainDomain = body.type_principal ?? primaryDomainCode(body.domaines)
    const status = body.status ?? (body.actif === false ? "inactif" : "actif")

    const ins = await client.query<{ id: string; code: string; nom: string; actif: boolean }>(
      `
        INSERT INTO public.fournisseurs (
          code,
          code_fournisseur,
          nom,
          raison_sociale,
          actif,
          status,
          type_principal,
          tva,
          siret,
          email,
          telephone,
          site_web,
          adresse_ligne,
          house_no,
          postcode,
          city,
          country,
          nom_commercial,
          logo,
          notes,
          created_by,
          updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
        RETURNING
          id::text AS id,
          COALESCE(code, code_fournisseur) AS code,
          COALESCE(nom, raison_sociale) AS nom,
          actif
      `,
      [
        body.code,
        body.code,
        body.nom,
        body.nom,
        body.actif ?? true,
        status,
        mainDomain,
        body.tva ?? null,
        body.siret ?? null,
        body.email ?? null,
        body.telephone ?? null,
        body.site_web ?? null,
        body.adresse_ligne ?? null,
        body.house_no ?? null,
        body.postcode ?? null,
        body.city ?? null,
        body.country ?? null,
        body.nom_commercial ?? null,
        body.logo ?? null,
        body.notes ?? null,
        audit.user_id,
      ]
    )

    const row = ins.rows[0] ?? null
    if (!row) throw new Error("Failed to create fournisseur")

    if (body.domaines !== undefined) {
      await replaceFournisseurDomainesTx(client, row.id, body.domaines, audit)
    }

    await client.query(
      `
        INSERT INTO public.fournisseur_events (
          fournisseur_id,
          event_type,
          title,
          description,
          metadata,
          created_by
        )
        VALUES ($1::uuid, 'created', 'Fournisseur créé', $2, $3::jsonb, $4)
      `,
      [
        row.id,
        `Création de ${row.nom}`,
        JSON.stringify({ code: row.code, nom: row.nom, domains: body.domaines?.map((d) => d.domaine_code) ?? [] }),
        audit.user_id,
      ]
    )

    await insertAuditLog(client, audit, {
      action: "fournisseurs.create",
      entity_type: "FOURNISSEUR",
      entity_id: row.id,
      details: { code: row.code, nom: row.nom, actif: row.actif, status, type_principal: mainDomain },
    })

    await client.query("COMMIT")
    const created = await repoGetFournisseur(row.id)
    if (!created) throw new Error("Failed to reload fournisseur after create")
    return created
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoUpdateFournisseur(
  id: string,
  patch: UpdateFournisseurBodyDTO,
  audit: AuditContext
): Promise<Fournisseur | null> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (patch.code !== undefined) {
    sets.push(`code = ${push(patch.code)}`)
    sets.push(`code_fournisseur = ${push(patch.code)}`)
  }
  if (patch.nom !== undefined) {
    sets.push(`nom = ${push(patch.nom)}`)
    sets.push(`raison_sociale = ${push(patch.nom)}`)
  }
  if (patch.actif !== undefined) sets.push(`actif = ${push(patch.actif)}`)
  if (patch.status !== undefined) {
    sets.push(`status = ${push(patch.status)}`)
    if (patch.status === "archive") sets.push("archived_at = COALESCE(archived_at, now())")
    if (patch.status !== "archive") sets.push("archived_at = NULL")
  }
  if (patch.type_principal !== undefined) sets.push(`type_principal = ${push(patch.type_principal)}`)
  if (patch.tva !== undefined) sets.push(`tva = ${push(patch.tva)}`)
  if (patch.siret !== undefined) sets.push(`siret = ${push(patch.siret)}`)
  if (patch.email !== undefined) sets.push(`email = ${push(patch.email)}`)
  if (patch.telephone !== undefined) sets.push(`telephone = ${push(patch.telephone)}`)
  if (patch.site_web !== undefined) sets.push(`site_web = ${push(patch.site_web)}`)
  if (patch.adresse_ligne !== undefined) sets.push(`adresse_ligne = ${push(patch.adresse_ligne)}`)
  if (patch.house_no !== undefined) sets.push(`house_no = ${push(patch.house_no)}`)
  if (patch.postcode !== undefined) sets.push(`postcode = ${push(patch.postcode)}`)
  if (patch.city !== undefined) sets.push(`city = ${push(patch.city)}`)
  if (patch.country !== undefined) sets.push(`country = ${push(patch.country)}`)
  if (patch.nom_commercial !== undefined) sets.push(`nom_commercial = ${push(patch.nom_commercial)}`)
  if (patch.logo !== undefined) sets.push(`logo = ${push(patch.logo)}`)
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`)

  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)

  const sql = `
    UPDATE public.fournisseurs
    SET ${sets.join(", ")}
    WHERE id = ${push(id)}::uuid
    RETURNING
      id::text AS id
  `

  try {
    await client.query("BEGIN")
    const res = await client.query<{ id: string }>(sql, values)
    const row = res.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return null
    }

    if (patch.domaines !== undefined) {
      await replaceFournisseurDomainesTx(client, id, patch.domaines, audit)
      await client.query(
        `
          INSERT INTO public.fournisseur_events (
            fournisseur_id,
            event_type,
            title,
            description,
            metadata,
            created_by
          )
          VALUES ($1::uuid, 'domaines.updated', 'Domaines fournisseur mis à jour', NULL, $2::jsonb, $3)
        `,
        [id, JSON.stringify({ domains: patch.domaines.map((d) => d.domaine_code) }), audit.user_id]
      )
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.update",
      entity_type: "FOURNISSEUR",
      entity_id: id,
      details: { patch },
    })

    await client.query("COMMIT")
    return await repoGetFournisseur(row.id)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoDeactivateFournisseur(id: string, audit: AuditContext): Promise<boolean> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lock = await client.query<{ code: string; nom: string; actif: boolean }>(
      `SELECT code, nom, actif FROM public.fournisseurs WHERE id = $1::uuid FOR UPDATE`,
      [id]
    )
    const before = lock.rows[0] ?? null
    if (!before) {
      await client.query("ROLLBACK")
      return false
    }

    await client.query(
      `UPDATE public.fournisseurs SET actif = false, status = 'inactif', updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [id, audit.user_id]
    )

    await insertAuditLog(client, audit, {
      action: "fournisseurs.deactivate",
      entity_type: "FOURNISSEUR",
      entity_id: id,
      details: { code: before.code, nom: before.nom, from_actif: before.actif, to_actif: false },
    })

    await client.query("COMMIT")
    return true
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

type DomaineRow = {
  id: string
  code: string
  label: string
  description: string | null
  icon: string | null
  sort_order: number
  is_active: boolean
}

function mapDomaineRow(r: DomaineRow): FournisseurDomaine {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    icon: r.icon,
    sort_order: Number(r.sort_order),
    is_active: r.is_active,
  }
}

export async function repoListFournisseurDomaines(): Promise<FournisseurDomaine[]> {
  const res = await db.query<DomaineRow>(
    `
      SELECT
        id::text AS id,
        code,
        label,
        description,
        icon,
        sort_order,
        is_active
      FROM public.fournisseur_domaines
      WHERE is_active = true
      ORDER BY sort_order ASC, label ASC
    `
  )
  return res.rows.map(mapDomaineRow)
}

export async function repoReplaceFournisseurDomaines(
  fournisseurId: string,
  body: PutFournisseurDomainesBodyDTO,
  audit: AuditContext
): Promise<Fournisseur | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    await replaceFournisseurDomainesTx(client, fournisseurId, body.domaines, audit)
    await client.query(
      `
        INSERT INTO public.fournisseur_events (
          fournisseur_id,
          event_type,
          title,
          description,
          metadata,
          created_by
        )
        VALUES ($1::uuid, 'domaines.updated', 'Domaines fournisseur mis à jour', NULL, $2::jsonb, $3)
      `,
      [fournisseurId, JSON.stringify({ domains: body.domaines.map((d) => d.domaine_code) }), audit.user_id]
    )

    await insertAuditLog(client, audit, {
      action: "fournisseurs.domaines.replace",
      entity_type: "FOURNISSEUR",
      entity_id: fournisseurId,
      details: { domaines: body.domaines },
    })

    await client.query("COMMIT")
    return await repoGetFournisseur(fournisseurId)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

type EventRow = {
  id: string
  fournisseur_id: string
  event_type: string
  title: string
  description: string | null
  metadata: Record<string, unknown> | string | null
  created_by: number | null
  created_at: string
}

function mapEventRow(r: EventRow): FournisseurEvent {
  let metadata: Record<string, unknown> = {}
  if (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)) metadata = r.metadata
  if (typeof r.metadata === "string" && r.metadata.trim()) {
    try {
      const parsed = JSON.parse(r.metadata)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed
    } catch {
      metadata = {}
    }
  }

  return {
    id: r.id,
    fournisseur_id: r.fournisseur_id,
    event_type: r.event_type,
    title: r.title,
    description: r.description,
    metadata,
    created_by: r.created_by,
    created_at: r.created_at,
  }
}

export async function repoListFournisseurEvents(fournisseurId: string): Promise<FournisseurEvent[] | null> {
  const exists = await ensureFournisseurExists(db, fournisseurId)
  if (!exists) return null

  const res = await db.query<EventRow>(
    `
      SELECT
        id::text AS id,
        fournisseur_id::text AS fournisseur_id,
        event_type,
        title,
        description,
        metadata,
        created_by,
        created_at::text AS created_at
      FROM public.fournisseur_events
      WHERE fournisseur_id = $1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `,
    [fournisseurId]
  )
  return res.rows.map(mapEventRow)
}

type ContactRow = {
  id: string
  fournisseur_id: string
  nom: string
  first_name: string | null
  last_name: string | null
  full_name: string | null
  email: string | null
  telephone: string | null
  mobile: string | null
  role: string | null
  notes: string | null
  is_primary: boolean
  actif: boolean
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

function mapContactRow(r: ContactRow): FournisseurContact {
  return {
    id: r.id,
    fournisseur_id: r.fournisseur_id,
    nom: r.nom,
    first_name: r.first_name,
    last_name: r.last_name,
    full_name: r.full_name,
    email: r.email,
    telephone: r.telephone,
    mobile: r.mobile,
    role: r.role,
    notes: r.notes,
    is_primary: r.is_primary,
    actif: r.actif,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

export async function repoListFournisseurContacts(fournisseurId: string): Promise<FournisseurContact[] | null> {
  const exists = await ensureFournisseurExists(db, fournisseurId)
  if (!exists) return null

  const res = await db.query<ContactRow>(
    `
      SELECT
        id::text AS id,
        fournisseur_id::text AS fournisseur_id,
        nom,
        first_name,
        last_name,
        full_name,
        email,
        telephone,
        mobile,
        role,
        notes,
        is_primary,
        actif,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by
      FROM public.fournisseur_contacts
      WHERE fournisseur_id = $1::uuid
        AND actif = true
      ORDER BY nom ASC, id ASC
    `,
    [fournisseurId]
  )
  return res.rows.map(mapContactRow)
}

export async function repoCreateFournisseurContact(
  fournisseurId: string,
  body: CreateContactBodyDTO,
  audit: AuditContext
): Promise<FournisseurContact | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    if (body.is_primary) {
      await client.query(
        `UPDATE public.fournisseur_contacts SET is_primary = false, updated_at = now(), updated_by = $2 WHERE fournisseur_id = $1::uuid`,
        [fournisseurId, audit.user_id]
      )
    }

    const ins = await client.query<ContactRow>(
      `
        INSERT INTO public.fournisseur_contacts (
          fournisseur_id, nom, first_name, last_name, full_name, email, telephone, mobile, role, notes, is_primary, actif,
          created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING
          id::text AS id,
          fournisseur_id::text AS fournisseur_id,
          nom,
          first_name,
          last_name,
          full_name,
          email,
          telephone,
          mobile,
          role,
          notes,
          is_primary,
          actif,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      [
        fournisseurId,
        body.nom,
        body.first_name ?? null,
        body.last_name ?? null,
        body.full_name ?? body.nom,
        body.email ?? null,
        body.telephone ?? null,
        body.mobile ?? null,
        body.role ?? null,
        body.notes ?? null,
        body.is_primary ?? false,
        body.actif ?? true,
        audit.user_id,
      ]
    )
    const row = ins.rows[0] ?? null
    if (!row) throw new Error("Failed to create fournisseur contact")

    await insertAuditLog(client, audit, {
      action: "fournisseurs.contacts.create",
      entity_type: "FOURNISSEUR",
      entity_id: fournisseurId,
      details: { contact_id: row.id, nom: row.nom, actif: row.actif },
    })

    await client.query("COMMIT")
    return mapContactRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoUpdateFournisseurContact(
  fournisseurId: string,
  contactId: string,
  patch: UpdateContactBodyDTO,
  audit: AuditContext
): Promise<FournisseurContact | null | false> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (patch.nom !== undefined) sets.push(`nom = ${push(patch.nom)}`)
  if (patch.first_name !== undefined) sets.push(`first_name = ${push(patch.first_name)}`)
  if (patch.last_name !== undefined) sets.push(`last_name = ${push(patch.last_name)}`)
  if (patch.full_name !== undefined) sets.push(`full_name = ${push(patch.full_name)}`)
  if (patch.email !== undefined) sets.push(`email = ${push(patch.email)}`)
  if (patch.telephone !== undefined) sets.push(`telephone = ${push(patch.telephone)}`)
  if (patch.mobile !== undefined) sets.push(`mobile = ${push(patch.mobile)}`)
  if (patch.role !== undefined) sets.push(`role = ${push(patch.role)}`)
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`)
  if (patch.is_primary !== undefined) sets.push(`is_primary = ${push(patch.is_primary)}`)
  if (patch.actif !== undefined) sets.push(`actif = ${push(patch.actif)}`)

  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)

  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    if (patch.is_primary === true) {
      await client.query(
        `UPDATE public.fournisseur_contacts SET is_primary = false, updated_at = now(), updated_by = $2 WHERE fournisseur_id = $1::uuid`,
        [fournisseurId, audit.user_id]
      )
    }

    const res = await client.query<ContactRow>(
      `
        UPDATE public.fournisseur_contacts
        SET ${sets.join(", ")}
        WHERE id = ${push(contactId)}::uuid
          AND fournisseur_id = ${push(fournisseurId)}::uuid
        RETURNING
          id::text AS id,
          fournisseur_id::text AS fournisseur_id,
          nom,
          first_name,
          last_name,
          full_name,
          email,
          telephone,
          mobile,
          role,
          notes,
          is_primary,
          actif,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      values
    )
    const row = res.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return false
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.contacts.update",
      entity_type: "FOURNISSEUR_CONTACT",
      entity_id: contactId,
      details: { fournisseur_id: fournisseurId, patch },
    })

    await client.query("COMMIT")
    return mapContactRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoSoftDeleteFournisseurContact(
  fournisseurId: string,
  contactId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const upd = await client.query(
      `
        UPDATE public.fournisseur_contacts
        SET actif = false, updated_at = now(), updated_by = $3
        WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND actif = true
      `,
      [contactId, fournisseurId, audit.user_id]
    )
    const ok = (upd.rowCount ?? 0) > 0
    if (!ok) {
      await client.query("ROLLBACK")
      return false
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.contacts.delete",
      entity_type: "FOURNISSEUR_CONTACT",
      entity_id: contactId,
      details: { fournisseur_id: fournisseurId },
    })

    await client.query("COMMIT")
    return true
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

type CatalogueRow = {
  id: string
  fournisseur_id: string
  type: string
  article_id: string | null
  designation: string
  reference_fournisseur: string | null
  unite: string | null
  prix_unitaire: number | null
  devise: string | null
  delai_jours: number | null
  moq: number | null
  conditions: string | null
  actif: boolean
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

function mapCatalogueRow(r: CatalogueRow): FournisseurCatalogueItem {
  const t = String(r.type)
  return {
    id: r.id,
    fournisseur_id: r.fournisseur_id,
    type:
      t === "MATIERE" ||
      t === "CONSOMMABLE" ||
      t === "SOUS_TRAITANCE" ||
      t === "SERVICE" ||
      t === "OUTILLAGE" ||
      t === "AUTRE"
        ? t
        : "AUTRE",
    article_id: r.article_id,
    designation: r.designation,
    reference_fournisseur: r.reference_fournisseur,
    unite: r.unite,
    prix_unitaire: r.prix_unitaire === null ? null : Number(r.prix_unitaire),
    devise: r.devise,
    delai_jours: r.delai_jours === null ? null : Number(r.delai_jours),
    moq: r.moq === null ? null : Number(r.moq),
    conditions: r.conditions,
    actif: r.actif,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

export async function repoListFournisseurCatalogue(
  fournisseurId: string,
  filters: ListCatalogueQueryDTO
): Promise<FournisseurCatalogueItem[] | null> {
  const exists = await ensureFournisseurExists(db, fournisseurId)
  if (!exists) return null

  const where: string[] = ["fournisseur_id = $1::uuid"]
  const values: unknown[] = [fournisseurId]
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (filters.type) where.push(`type = ${push(filters.type)}`)
  if (typeof filters.actif === "boolean") where.push(`actif = ${push(filters.actif)}`)
  else where.push("actif = true")

  const whereSql = `WHERE ${where.join(" AND ")}`
  const res = await db.query<CatalogueRow>(
    `
      SELECT
        id::text AS id,
        fournisseur_id::text AS fournisseur_id,
        type,
        article_id::text AS article_id,
        designation,
        reference_fournisseur,
        unite,
        prix_unitaire::float8 AS prix_unitaire,
        devise,
        delai_jours,
        moq::float8 AS moq,
        conditions,
        actif,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by
      FROM public.fournisseur_catalogue
      ${whereSql}
      ORDER BY type ASC, designation ASC, id ASC
    `,
    values
  )
  return res.rows.map(mapCatalogueRow)
}

export async function repoCreateFournisseurCatalogueItem(
  fournisseurId: string,
  body: CreateCatalogueBodyDTO,
  audit: AuditContext
): Promise<FournisseurCatalogueItem | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const ins = await client.query<CatalogueRow>(
      `
        INSERT INTO public.fournisseur_catalogue (
          fournisseur_id,
          type,
          article_id,
          designation,
          reference_fournisseur,
          unite,
          prix_unitaire,
          devise,
          delai_jours,
          moq,
          conditions,
          actif,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING
          id::text AS id,
          fournisseur_id::text AS fournisseur_id,
          type,
          article_id::text AS article_id,
          designation,
          reference_fournisseur,
          unite,
          prix_unitaire::float8 AS prix_unitaire,
          devise,
          delai_jours,
          moq::float8 AS moq,
          conditions,
          actif,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      [
        fournisseurId,
        body.type,
        body.article_id ?? null,
        body.designation,
        body.reference_fournisseur ?? null,
        body.unite ?? null,
        body.prix_unitaire ?? null,
        body.devise ?? "EUR",
        body.delai_jours ?? null,
        body.moq ?? null,
        body.conditions ?? null,
        body.actif ?? true,
        audit.user_id,
      ]
    )
    const row = ins.rows[0] ?? null
    if (!row) throw new Error("Failed to create fournisseur catalogue item")

    await insertAuditLog(client, audit, {
      action: "fournisseurs.catalogue.create",
      entity_type: "FOURNISSEUR",
      entity_id: fournisseurId,
      details: { catalogue_id: row.id, type: row.type, designation: row.designation, actif: row.actif },
    })

    await client.query("COMMIT")
    return mapCatalogueRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoUpdateFournisseurCatalogueItem(
  fournisseurId: string,
  catalogueId: string,
  patch: UpdateCatalogueBodyDTO,
  audit: AuditContext
): Promise<FournisseurCatalogueItem | null | false> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (patch.type !== undefined) sets.push(`type = ${push(patch.type)}`)
  if (patch.article_id !== undefined) sets.push(`article_id = ${push(patch.article_id)}::uuid`)
  if (patch.designation !== undefined) sets.push(`designation = ${push(patch.designation)}`)
  if (patch.reference_fournisseur !== undefined) sets.push(`reference_fournisseur = ${push(patch.reference_fournisseur)}`)
  if (patch.unite !== undefined) sets.push(`unite = ${push(patch.unite)}`)
  if (patch.prix_unitaire !== undefined) sets.push(`prix_unitaire = ${push(patch.prix_unitaire)}`)
  if (patch.devise !== undefined) sets.push(`devise = ${push(patch.devise)}`)
  if (patch.delai_jours !== undefined) sets.push(`delai_jours = ${push(patch.delai_jours)}`)
  if (patch.moq !== undefined) sets.push(`moq = ${push(patch.moq)}`)
  if (patch.conditions !== undefined) sets.push(`conditions = ${push(patch.conditions)}`)
  if (patch.actif !== undefined) sets.push(`actif = ${push(patch.actif)}`)
  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)

  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const res = await client.query<CatalogueRow>(
      `
        UPDATE public.fournisseur_catalogue
        SET ${sets.join(", ")}
        WHERE id = ${push(catalogueId)}::uuid
          AND fournisseur_id = ${push(fournisseurId)}::uuid
        RETURNING
          id::text AS id,
          fournisseur_id::text AS fournisseur_id,
          type,
          article_id::text AS article_id,
          designation,
          reference_fournisseur,
          unite,
          prix_unitaire::float8 AS prix_unitaire,
          devise,
          delai_jours,
          moq::float8 AS moq,
          conditions,
          actif,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      values
    )
    const row = res.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return false
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.catalogue.update",
      entity_type: "FOURNISSEUR_CATALOGUE",
      entity_id: catalogueId,
      details: { fournisseur_id: fournisseurId, patch },
    })

    await client.query("COMMIT")
    return mapCatalogueRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoSoftDeleteFournisseurCatalogueItem(
  fournisseurId: string,
  catalogueId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const upd = await client.query(
      `
        UPDATE public.fournisseur_catalogue
        SET actif = false, updated_at = now(), updated_by = $3
        WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND actif = true
      `,
      [catalogueId, fournisseurId, audit.user_id]
    )
    const ok = (upd.rowCount ?? 0) > 0
    if (!ok) {
      await client.query("ROLLBACK")
      return false
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.catalogue.delete",
      entity_type: "FOURNISSEUR_CATALOGUE",
      entity_id: catalogueId,
      details: { fournisseur_id: fournisseurId },
    })

    await client.query("COMMIT")
    return true
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

type DocumentRow = {
  id: string
  fournisseur_id: string
  document_type: string
  commentaire: string | null
  original_name: string
  stored_name: string
  storage_path: string
  mime_type: string
  size_bytes: string
  sha256: string | null
  label: string | null
  uploaded_by: number | null
  removed_at: string | null
  removed_by: number | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

function mapDocumentRow(r: DocumentRow): FournisseurDocument {
  return {
    id: r.id,
    fournisseur_id: r.fournisseur_id,
    document_type: r.document_type,
    commentaire: r.commentaire,
    original_name: r.original_name,
    stored_name: r.stored_name,
    storage_path: r.storage_path,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    label: r.label,
    uploaded_by: r.uploaded_by,
    removed_at: r.removed_at,
    removed_by: r.removed_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

export async function repoListFournisseurDocuments(fournisseurId: string): Promise<FournisseurDocument[] | null> {
  const exists = await ensureFournisseurExists(db, fournisseurId)
  if (!exists) return null

  const res = await db.query<DocumentRow>(
    `
      SELECT
        id::text AS id,
        fournisseur_id::text AS fournisseur_id,
        document_type,
        commentaire,
        original_name,
        stored_name,
        storage_path,
        mime_type,
        size_bytes::text AS size_bytes,
        sha256,
        label,
        uploaded_by,
        removed_at::text AS removed_at,
        removed_by,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        created_by,
        updated_by
      FROM public.fournisseur_documents
      WHERE fournisseur_id = $1::uuid
        AND removed_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
    [fournisseurId]
  )
  return res.rows.map(mapDocumentRow)
}

export async function repoAttachFournisseurDocuments(
  fournisseurId: string,
  body: AttachDocumentsBodyDTO,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<FournisseurDocument[] | null> {
  const client = await db.connect()
  const docsDirRel = path.posix.join("uploads", "docs", "fournisseurs")
  const docsDirAbs = path.resolve(docsDirRel)
  const movedFiles: string[] = []
  try {
    await client.query("BEGIN")

    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    if (!documents.length) {
      await client.query("COMMIT")
      return []
    }

    await fs.mkdir(docsDirAbs, { recursive: true })
    const inserted: FournisseurDocument[] = []

    for (const doc of documents) {
      const documentId = crypto.randomUUID()
      const safeExt = safeDocExtension(doc.originalname)
      const storedName = `${documentId}${safeExt}`
      const relPath = toPosixPath(path.join(docsDirRel, storedName))
      const absPath = path.join(docsDirAbs, storedName)
      const tempPath = path.resolve(doc.path)

      try {
        await fs.rename(tempPath, absPath)
      } catch {
        await fs.copyFile(tempPath, absPath)
        await fs.unlink(tempPath)
      }

      movedFiles.push(absPath)
      const hash = await sha256File(absPath)

      const ins = await client.query<DocumentRow>(
        `
          INSERT INTO public.fournisseur_documents (
            fournisseur_id,
            document_type,
            commentaire,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes,
            sha256,
            label,
            uploaded_by,
            created_by,
            updated_by
          )
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11)
          RETURNING
            id::text AS id,
            fournisseur_id::text AS fournisseur_id,
            document_type,
            commentaire,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes::text AS size_bytes,
            sha256,
            label,
            uploaded_by,
            removed_at::text AS removed_at,
            removed_by,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            created_by,
            updated_by
        `,
        [
          fournisseurId,
          body.document_type,
          body.commentaire ?? null,
          doc.originalname,
          storedName,
          relPath,
          doc.mimetype,
          doc.size,
          hash,
          body.label ?? null,
          audit.user_id,
        ]
      )

      const row = ins.rows[0] ?? null
      if (!row) throw new Error("Failed to insert fournisseur document")
      inserted.push(mapDocumentRow(row))
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.documents.attach",
      entity_type: "FOURNISSEUR",
      entity_id: fournisseurId,
      details: {
        document_type: body.document_type,
        count: inserted.length,
        documents: inserted.map((d) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes })),
      },
    })

    await client.query("COMMIT")
    return inserted
  } catch (err) {
    await client.query("ROLLBACK")
    for (const f of movedFiles) await fs.unlink(f).catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export async function repoRemoveFournisseurDocument(
  fournisseurId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const current = await client.query<Pick<DocumentRow, "original_name" | "storage_path">>(
      `
        SELECT original_name, storage_path
        FROM public.fournisseur_documents
        WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND removed_at IS NULL
        FOR UPDATE
      `,
      [documentId, fournisseurId]
    )
    const doc = current.rows[0] ?? null
    if (!doc) {
      await client.query("ROLLBACK")
      return false
    }

    const upd = await client.query(
      `
        UPDATE public.fournisseur_documents
        SET removed_at = now(), removed_by = $3, updated_at = now(), updated_by = $3
        WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND removed_at IS NULL
      `,
      [documentId, fournisseurId, audit.user_id]
    )
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK")
      return false
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.documents.remove",
      entity_type: "FOURNISSEUR_DOCUMENT",
      entity_id: documentId,
      details: { fournisseur_id: fournisseurId, original_name: doc.original_name, storage_path: doc.storage_path },
    })

    await client.query("COMMIT")
    return true
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoGetFournisseurDocumentForDownload(
  fournisseurId: string,
  documentId: string,
  audit: AuditContext
): Promise<FournisseurDocument | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const exists = await ensureFournisseurExists(client, fournisseurId)
    if (!exists) {
      await client.query("ROLLBACK")
      return null
    }

    const res = await client.query<DocumentRow>(
      `
        SELECT
          id::text AS id,
          fournisseur_id::text AS fournisseur_id,
          document_type,
          commentaire,
          original_name,
          stored_name,
          storage_path,
          mime_type,
          size_bytes::text AS size_bytes,
          sha256,
          label,
          uploaded_by,
          removed_at::text AS removed_at,
          removed_by,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
        FROM public.fournisseur_documents
        WHERE id = $1::uuid
          AND fournisseur_id = $2::uuid
          AND removed_at IS NULL
        LIMIT 1
      `,
      [documentId, fournisseurId]
    )
    const row = res.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return null
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.documents.download",
      entity_type: "FOURNISSEUR_DOCUMENT",
      entity_id: documentId,
      details: { fournisseur_id: fournisseurId, original_name: row.original_name },
    })

    await client.query("COMMIT")
    return mapDocumentRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export function assertNoUniqueViolation(err: unknown, message: string) {
  if (!isPgUniqueViolation(err)) return
  throw new HttpError(409, "CONFLICT", message)
}
