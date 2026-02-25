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
  ListCatalogueQueryDTO,
  ListFournisseursQueryDTO,
  UpdateCatalogueBodyDTO,
  UpdateContactBodyDTO,
  UpdateFournisseurBodyDTO,
} from "../validators/fournisseurs.validators"
import type {
  Fournisseur,
  FournisseurCatalogueItem,
  FournisseurContact,
  FournisseurDocument,
  FournisseurListItem,
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
  tva: string | null
  siret: string | null
  email: string | null
  telephone: string | null
  site_web: string | null
  notes: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

function mapFournisseurRow(r: FournisseurRow): Fournisseur {
  return {
    id: r.id,
    code: r.code,
    nom: r.nom,
    actif: r.actif,
    tva: r.tva,
    siret: r.siret,
    email: r.email,
    telephone: r.telephone,
    site_web: r.site_web,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

function sortColumn(sortBy: ListFournisseursQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "code":
      return "f.code"
    case "nom":
      return "f.nom"
    case "updated_at":
    default:
      return "f.updated_at"
  }
}

function sortDirection(sortDir: ListFournisseursQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC"
}

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
    where.push(`(f.code ILIKE ${p} OR f.nom ILIKE ${p})`)
  }
  if (typeof filters.actif === "boolean") {
    where.push(`f.actif = ${push(filters.actif)}`)
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
        f.id::text AS id,
        f.code,
        f.nom,
        f.actif,
        f.tva,
        f.siret,
        f.email,
        f.telephone,
        f.site_web,
        f.notes,
        f.created_at::text AS created_at,
        f.updated_at::text AS updated_at,
        f.created_by,
        f.updated_by
      FROM public.fournisseurs f
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, f.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  )

  const items: FournisseurListItem[] = dataRes.rows.map((r) => ({
    id: r.id,
    code: r.code,
    nom: r.nom,
    actif: r.actif,
    updated_at: r.updated_at,
  }))

  return { items, total }
}

export async function repoGetFournisseur(id: string): Promise<Fournisseur | null> {
  const res = await db.query<FournisseurRow>(
    `
      SELECT
        f.id::text AS id,
        f.code,
        f.nom,
        f.actif,
        f.tva,
        f.siret,
        f.email,
        f.telephone,
        f.site_web,
        f.notes,
        f.created_at::text AS created_at,
        f.updated_at::text AS updated_at,
        f.created_by,
        f.updated_by
      FROM public.fournisseurs f
      WHERE f.id = $1::uuid
      LIMIT 1
    `,
    [id]
  )
  const row = res.rows[0] ?? null
  return row ? mapFournisseurRow(row) : null
}

export async function repoCreateFournisseur(body: CreateFournisseurBodyDTO, audit: AuditContext): Promise<Fournisseur> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const ins = await client.query<FournisseurRow>(
      `
        INSERT INTO public.fournisseurs (
          code, nom, actif, tva, siret, email, telephone, site_web, notes,
          created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        RETURNING
          id::text AS id,
          code,
          nom,
          actif,
          tva,
          siret,
          email,
          telephone,
          site_web,
          notes,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      [
        body.code,
        body.nom,
        body.actif ?? true,
        body.tva ?? null,
        body.siret ?? null,
        body.email ?? null,
        body.telephone ?? null,
        body.site_web ?? null,
        body.notes ?? null,
        audit.user_id,
      ]
    )

    const row = ins.rows[0] ?? null
    if (!row) throw new Error("Failed to create fournisseur")

    await insertAuditLog(client, audit, {
      action: "fournisseurs.create",
      entity_type: "FOURNISSEUR",
      entity_id: row.id,
      details: { code: row.code, nom: row.nom, actif: row.actif },
    })

    await client.query("COMMIT")
    return mapFournisseurRow(row)
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

  if (patch.code !== undefined) sets.push(`code = ${push(patch.code)}`)
  if (patch.nom !== undefined) sets.push(`nom = ${push(patch.nom)}`)
  if (patch.actif !== undefined) sets.push(`actif = ${push(patch.actif)}`)
  if (patch.tva !== undefined) sets.push(`tva = ${push(patch.tva)}`)
  if (patch.siret !== undefined) sets.push(`siret = ${push(patch.siret)}`)
  if (patch.email !== undefined) sets.push(`email = ${push(patch.email)}`)
  if (patch.telephone !== undefined) sets.push(`telephone = ${push(patch.telephone)}`)
  if (patch.site_web !== undefined) sets.push(`site_web = ${push(patch.site_web)}`)
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`)

  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)

  const sql = `
    UPDATE public.fournisseurs
    SET ${sets.join(", ")}
    WHERE id = ${push(id)}::uuid
    RETURNING
      id::text AS id,
      code,
      nom,
      actif,
      tva,
      siret,
      email,
      telephone,
      site_web,
      notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at,
      created_by,
      updated_by
  `

  try {
    await client.query("BEGIN")
    const res = await client.query<FournisseurRow>(sql, values)
    const row = res.rows[0] ?? null
    if (!row) {
      await client.query("ROLLBACK")
      return null
    }

    await insertAuditLog(client, audit, {
      action: "fournisseurs.update",
      entity_type: "FOURNISSEUR",
      entity_id: id,
      details: { patch },
    })

    await client.query("COMMIT")
    return mapFournisseurRow(row)
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
      `UPDATE public.fournisseurs SET actif = false, updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
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

type ContactRow = {
  id: string
  fournisseur_id: string
  nom: string
  email: string | null
  telephone: string | null
  role: string | null
  notes: string | null
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
    email: r.email,
    telephone: r.telephone,
    role: r.role,
    notes: r.notes,
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
        email,
        telephone,
        role,
        notes,
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

    const ins = await client.query<ContactRow>(
      `
        INSERT INTO public.fournisseur_contacts (
          fournisseur_id, nom, email, telephone, role, notes, actif,
          created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$8)
        RETURNING
          id::text AS id,
          fournisseur_id::text AS fournisseur_id,
          nom,
          email,
          telephone,
          role,
          notes,
          actif,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by
      `,
      [
        fournisseurId,
        body.nom,
        body.email ?? null,
        body.telephone ?? null,
        body.role ?? null,
        body.notes ?? null,
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
  if (patch.email !== undefined) sets.push(`email = ${push(patch.email)}`)
  if (patch.telephone !== undefined) sets.push(`telephone = ${push(patch.telephone)}`)
  if (patch.role !== undefined) sets.push(`role = ${push(patch.role)}`)
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`)
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
          email,
          telephone,
          role,
          notes,
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
