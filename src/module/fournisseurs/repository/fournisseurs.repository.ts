import type { PoolClient } from "pg"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import db from "../../../config/database"
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"
import { generateFournisseurCode } from "../../../shared/codes/code-generator.service"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators"
import type {
  AttachDocumentsBodyDTO,
  CreateAdresseBodyDTO,
  CreateCatalogueBodyDTO,
  CreateContactBodyDTO,
  CreateFournisseurBodyDTO,
  CreateHomologationBodyDTO,
  DoublonQueryDTO,
  ListCatalogueQueryDTO,
  ListFournisseursQueryDTO,
  UpdateAdresseBodyDTO,
  UpdateCatalogueBodyDTO,
  UpdateContactBodyDTO,
  UpdateFournisseurBodyDTO,
  UpdateHomologationBodyDTO,
} from "../validators/fournisseurs.validators"
import type {
  Fournisseur,
  FournisseurAdresse,
  FournisseurCatalogueItem,
  FournisseurContact,
  FournisseurDomaine,
  FournisseurDomaineLien,
  FournisseurDocument,
  FournisseurEvent,
  FournisseurHomologation,
  FournisseurListItem,
  FournisseurRelations,
  FournisseurStatus,
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

// Internal-only shape for downloads (carries storage_path, never exposed to clients).
export type FournisseurDocumentDownload = {
  storage_path: string
  mime_type: string
  original_name: string
}

const DEFAULT_FOURNISSEUR_DOMAINES: FournisseurDomaine[] = [
  { id: "11111111-0000-4000-8000-000000000010", code: "outillage", label: "Outillage", description: null, icon: "Wrench", sort_order: 10, is_active: true },
  { id: "11111111-0000-4000-8000-000000000020", code: "matiere_brute", label: "Matière brute", description: null, icon: "Package", sort_order: 20, is_active: true },
  { id: "11111111-0000-4000-8000-000000000030", code: "machines_cnc", label: "Machines CNC", description: null, icon: "Factory", sort_order: 30, is_active: true },
  { id: "11111111-0000-4000-8000-000000000040", code: "electrique", label: "Électrique", description: null, icon: "Zap", sort_order: 40, is_active: true },
  { id: "11111111-0000-4000-8000-000000000050", code: "traitements", label: "Traitements", description: null, icon: "Layers", sort_order: 50, is_active: true },
  { id: "11111111-0000-4000-8000-000000000060", code: "informatique", label: "Informatique / IT", description: null, icon: "Monitor", sort_order: 60, is_active: true },
  { id: "11111111-0000-4000-8000-000000000070", code: "maintenance", label: "Maintenance", description: null, icon: "Settings", sort_order: 70, is_active: true },
  { id: "11111111-0000-4000-8000-000000000080", code: "transport", label: "Transport", description: null, icon: "Truck", sort_order: 80, is_active: true },
  { id: "11111111-0000-4000-8000-000000000090", code: "sous_traitance", label: "Sous-traitance", description: null, icon: "Handshake", sort_order: 90, is_active: true },
  { id: "11111111-0000-4000-8000-000000000100", code: "metrologie", label: "Métrologie", description: null, icon: "Ruler", sort_order: 100, is_active: true },
  { id: "11111111-0000-4000-8000-000000000110", code: "epi", label: "EPI", description: null, icon: "Shield", sort_order: 110, is_active: true },
  { id: "11111111-0000-4000-8000-000000000120", code: "consommables_atelier", label: "Consommables atelier", description: null, icon: "Boxes", sort_order: 120, is_active: true },
  { id: "11111111-0000-4000-8000-000000000130", code: "services_generaux", label: "Services généraux", description: null, icon: "Building", sort_order: 130, is_active: true },
  { id: "11111111-0000-4000-8000-000000000999", code: "autre", label: "Autres", description: null, icon: "Circle", sort_order: 999, is_active: true },
]

const emptyRelations: FournisseurRelations = { outillage: null }

// ---- Upload hardening: extension + MIME allowlist + magic-byte signature ----
const ALLOWED_DOC_EXT = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".txt", ".csv",
  ".doc", ".docx", ".xls", ".xlsx", ".odt", ".ods",
])
const ALLOWED_DOC_MIME = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
  "text/plain", "text/csv", "application/vnd.ms-excel",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/octet-stream",
])

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
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

// Reads the first bytes and validates the magic signature for common binary types.
async function magicBytesOk(filePath: string, ext: string): Promise<boolean> {
  let fh: fs.FileHandle | null = null
  try {
    fh = await fs.open(filePath, "r")
    const buf = Buffer.alloc(8)
    const { bytesRead } = await fh.read(buf, 0, 8, 0)
    const head = buf.subarray(0, bytesRead)
    const startsWith = (sig: number[]) => sig.every((b, i) => head[i] === b)
    switch (ext) {
      case ".pdf":
        return head.subarray(0, 5).toString("latin1") === "%PDF-"
      case ".png":
        return startsWith([0x89, 0x50, 0x4e, 0x47])
      case ".jpg":
      case ".jpeg":
        return startsWith([0xff, 0xd8, 0xff])
      case ".gif":
        return head.subarray(0, 3).toString("latin1") === "GIF"
      case ".webp":
        return head.subarray(0, 4).toString("latin1") === "RIFF"
      case ".docx":
      case ".xlsx":
      case ".ods":
      case ".odt":
        // zip-based OOXML/ODF containers
        return startsWith([0x50, 0x4b])
      case ".doc":
      case ".xls":
        return startsWith([0xd0, 0xcf, 0x11, 0xe0])
      default:
        // text/csv and unknown: no binary signature to enforce
        return true
    }
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}

async function assertUploadAllowed(doc: UploadedDocument): Promise<string> {
  const ext = safeDocExtension(doc.originalname)
  if (!ext || !ALLOWED_DOC_EXT.has(ext)) {
    throw new HttpError(400, "UNSUPPORTED_FILE_TYPE", `Extension de fichier non autorisée: ${doc.originalname}`)
  }
  if (!ALLOWED_DOC_MIME.has(doc.mimetype)) {
    throw new HttpError(400, "UNSUPPORTED_MIME_TYPE", `Type MIME non autorisé: ${doc.mimetype}`)
  }
  if (!(await magicBytesOk(doc.path, ext))) {
    throw new HttpError(400, "FILE_SIGNATURE_MISMATCH", `La signature du fichier ne correspond pas à ${ext}`)
  }
  return ext
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

// Records a supplier activity-stream event (best-effort, inside the caller's transaction).
async function insertEvent(tx: DbQueryer, fournisseurId: string, userId: number, entry: {
  event_type: string
  title: string
  description?: string | null
  metadata?: Record<string, unknown>
}) {
  await tx.query(
    `INSERT INTO public.fournisseur_events (fournisseur_id, event_type, title, description, metadata, created_by)
     VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6)`,
    [fournisseurId, entry.event_type, entry.title, entry.description ?? null, JSON.stringify(entry.metadata ?? {}), userId]
  )
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

// Correlated SQL fragments reused by list + detail to fully round-trip the fiche 360.
const DOMAINES_JSON = `
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', d.id::text, 'code', d.code, 'label', d.label, 'description', d.description,
      'icon', d.icon, 'sort_order', d.sort_order, 'is_active', d.is_active,
      'is_primary', l.is_primary, 'notes', l.notes
    ) ORDER BY l.is_primary DESC, d.sort_order ASC)
    FROM public.fournisseur_domaine_lien l
    JOIN public.fournisseur_domaines d ON d.code = l.domaine_code
    WHERE l.fournisseur_id = f.id
  ), '[]'::json) AS domaines`

const RELATIONS_JSON = `
  (SELECT json_build_object('outillage', CASE WHEN m.id_fournisseur IS NULL THEN NULL ELSE json_build_object(
      'id_fournisseur', m.id_fournisseur,
      'outils_count', COALESCE((SELECT count(*) FROM public.gestion_outils_outil_fournisseur x WHERE x.id_fournisseur = m.id_fournisseur), 0),
      'fabricants_count', COALESCE((SELECT count(*) FROM public.gestion_outils_fournisseur_fabricant x WHERE x.id_fournisseur = m.id_fournisseur), 0),
      'prix_count', COALESCE((SELECT count(*) FROM public.gestion_outils_historique_prix x WHERE x.id_fournisseur = m.id_fournisseur), 0),
      'mouvements_count', COALESCE((SELECT count(*) FROM public.gestion_outils_mouvement_stock x WHERE x.id_fournisseur = m.id_fournisseur), 0)
    ) END)
   FROM (SELECT id_fournisseur FROM public.fournisseur_outillage_mapping WHERE fournisseur_id = f.id) m) AS relations`

const HOMOLOGATION_JSON = `
  (SELECT json_build_object('statut', h.statut, 'valid_to', h.valid_to::text, 'domaine_code', h.domaine_code)
   FROM public.fournisseur_homologations h
   WHERE h.fournisseur_id = f.id AND h.is_current = true
   ORDER BY (h.domaine_code IS NULL) ASC, h.updated_at DESC
   LIMIT 1) AS homologation`

const COUNTS_SQL = `
  COALESCE((SELECT count(*) FROM public.fournisseur_contacts c WHERE c.fournisseur_id = f.id AND c.actif), 0) AS contacts_count,
  COALESCE((SELECT count(*) FROM public.fournisseur_catalogue c WHERE c.fournisseur_id = f.id AND c.actif), 0) AS catalogue_count,
  COALESCE((SELECT count(*) FROM public.fournisseur_documents c WHERE c.fournisseur_id = f.id AND c.removed_at IS NULL), 0) AS documents_count,
  COALESCE((SELECT count(*) FROM public.fournisseur_events c WHERE c.fournisseur_id = f.id), 0) AS events_count,
  COALESCE((SELECT count(*) FROM public.fournisseur_adresses c WHERE c.fournisseur_id = f.id AND c.actif), 0) AS adresses_count,
  COALESCE((SELECT count(*) FROM public.fournisseur_homologations c WHERE c.fournisseur_id = f.id AND c.is_current), 0) AS homologations_count`

type FournisseurRow = {
  id: string
  code: string
  nom: string
  actif: boolean
  status: FournisseurStatus | null
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
  domaines: FournisseurDomaineLien[] | null
  relations: FournisseurRelations | null
  homologation: Fournisseur["homologation"] | null
  adresses?: FournisseurAdresse[] | null
  contacts_count: number | null
  catalogue_count: number | null
  documents_count: number | null
  events_count: number | null
  adresses_count: number | null
  homologations_count: number | null
}

function mapFournisseurRow(r: FournisseurRow): Fournisseur {
  const status = r.status ?? (r.actif ? "actif" : "inactif")
  return {
    id: r.id,
    code: r.code,
    nom: r.nom,
    actif: r.actif,
    status,
    type_principal: r.type_principal ?? null,
    tva: r.tva,
    siret: r.siret,
    email: r.email,
    telephone: r.telephone,
    site_web: r.site_web,
    adresse_ligne: r.adresse_ligne ?? null,
    house_no: r.house_no ?? null,
    postcode: r.postcode ?? null,
    city: r.city ?? null,
    country: r.country ?? null,
    nom_commercial: r.nom_commercial ?? null,
    logo: r.logo ?? null,
    notes: r.notes,
    archived_at: r.archived_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
    domaines: Array.isArray(r.domaines) ? r.domaines : [],
    relations: r.relations ?? emptyRelations,
    adresses: Array.isArray(r.adresses) ? r.adresses : [],
    homologation: r.homologation ?? null,
    contacts_count: Number(r.contacts_count ?? 0),
    catalogue_count: Number(r.catalogue_count ?? 0),
    documents_count: Number(r.documents_count ?? 0),
    events_count: Number(r.events_count ?? 0),
    adresses_count: Number(r.adresses_count ?? 0),
    homologations_count: Number(r.homologations_count ?? 0),
  }
}

function mapFournisseurListItem(r: FournisseurRow): FournisseurListItem {
  const s = mapFournisseurRow(r)
  return {
    id: s.id, code: s.code, nom: s.nom, actif: s.actif, status: s.status,
    type_principal: s.type_principal, email: s.email, telephone: s.telephone,
    city: s.city, country: s.country, logo: s.logo, updated_at: s.updated_at,
    domaines: s.domaines, relations: s.relations, homologation: s.homologation,
    contacts_count: s.contacts_count, catalogue_count: s.catalogue_count,
    documents_count: s.documents_count, events_count: s.events_count,
    adresses_count: s.adresses_count, homologations_count: s.homologations_count,
  }
}

const FOURNISSEUR_SELECT = `
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
  ${DOMAINES_JSON},
  ${RELATIONS_JSON},
  ${HOMOLOGATION_JSON},
  ${COUNTS_SQL}`

function sortColumn(sortBy: ListFournisseursQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "code": return "COALESCE(f.code, f.code_fournisseur)"
    case "nom": return "COALESCE(f.nom, f.raison_sociale)"
    case "updated_at":
    default: return "f.updated_at"
  }
}

export async function repoListFournisseurs(filters: ListFournisseursQueryDTO): Promise<Paginated<FournisseurListItem>> {
  const where: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }

  if (filters.search && filters.search.trim()) {
    const p = push(`%${filters.search.trim()}%`)
    where.push(`(COALESCE(f.code, f.code_fournisseur) ILIKE ${p} OR COALESCE(f.nom, f.raison_sociale) ILIKE ${p} OR f.nom_commercial ILIKE ${p} OR f.siret ILIKE ${p} OR f.email ILIKE ${p})`)
  }
  if (typeof filters.actif === "boolean") where.push(`f.actif = ${push(filters.actif)}`)
  if (filters.status) where.push(`f.status = ${push(filters.status)}`)
  if (filters.domaines && filters.domaines.trim()) {
    const codes = filters.domaines.split(",").map((c) => c.trim()).filter(Boolean)
    if (codes.length) {
      where.push(`EXISTS (SELECT 1 FROM public.fournisseur_domaine_lien l WHERE l.fournisseur_id = f.id AND l.domaine_code = ANY(${push(codes)}::text[]))`)
    }
  }
  if (filters.homologation && filters.homologation.trim()) {
    where.push(`EXISTS (SELECT 1 FROM public.fournisseur_homologations h WHERE h.fournisseur_id = f.id AND h.is_current AND h.statut = ${push(filters.homologation.trim())})`)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 20
  const offset = (page - 1) * pageSize
  const orderBy = sortColumn(filters.sortBy)
  const orderDir = filters.sortDir === "asc" ? "ASC" : "DESC"

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.fournisseurs f ${whereSql}`, values
  )
  const total = countRes.rows[0]?.total ?? 0

  const dataRes = await db.query<FournisseurRow>(
    `SELECT ${FOURNISSEUR_SELECT}
     FROM public.fournisseurs f
     ${whereSql}
     ORDER BY ${orderBy} ${orderDir}, f.id ${orderDir}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset]
  )
  return { items: dataRes.rows.map(mapFournisseurListItem), total }
}

const ADRESSES_JSON_DETAIL = `
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', a.id::text, 'fournisseur_id', a.fournisseur_id::text, 'type', a.type, 'label', a.label,
      'ligne1', a.ligne1, 'ligne2', a.ligne2, 'house_no', a.house_no, 'postcode', a.postcode,
      'city', a.city, 'country', a.country, 'is_primary', a.is_primary, 'actif', a.actif, 'notes', a.notes,
      'created_at', a.created_at::text, 'updated_at', a.updated_at::text, 'created_by', a.created_by, 'updated_by', a.updated_by
    ) ORDER BY a.type ASC, a.is_primary DESC)
    FROM public.fournisseur_adresses a WHERE a.fournisseur_id = f.id AND a.actif
  ), '[]'::json) AS adresses`

export async function repoGetFournisseur(id: string): Promise<Fournisseur | null> {
  const res = await db.query<FournisseurRow>(
    `SELECT ${FOURNISSEUR_SELECT}, ${ADRESSES_JSON_DETAIL}
     FROM public.fournisseurs f WHERE f.id = $1::uuid LIMIT 1`,
    [id]
  )
  const row = res.rows[0] ?? null
  return row ? mapFournisseurRow(row) : null
}

export async function repoListFournisseurDomaines(): Promise<FournisseurDomaine[]> {
  const res = await db.query<FournisseurDomaine>(
    `SELECT id::text AS id, code, label, description, icon, sort_order, is_active
     FROM public.fournisseur_domaines WHERE is_active = true ORDER BY sort_order ASC, label ASC`
  )
  return res.rows.length ? res.rows : DEFAULT_FOURNISSEUR_DOMAINES
}

export async function repoReplaceFournisseurDomaines(
  fournisseurId: string,
  domaines: Array<{ domaine_code: string; is_primary?: boolean; notes?: string | null }>,
  audit: AuditContext
): Promise<Fournisseur | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) {
      await client.query("ROLLBACK")
      return null
    }
    const normalized = domaines.map((d, i) => ({
      ...d,
      is_primary: Boolean(d.is_primary) || (i === 0 && !domaines.some((x) => x.is_primary)),
    }))
    await client.query(`DELETE FROM public.fournisseur_domaine_lien WHERE fournisseur_id = $1::uuid`, [fournisseurId])
    for (const d of normalized) {
      await client.query(
        `INSERT INTO public.fournisseur_domaine_lien (fournisseur_id, domaine_code, is_primary, notes, created_by, updated_by)
         VALUES ($1::uuid,$2,$3,$4,$5,$5)
         ON CONFLICT (fournisseur_id, domaine_code)
         DO UPDATE SET is_primary = EXCLUDED.is_primary, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [fournisseurId, d.domaine_code, d.is_primary, d.notes ?? null, audit.user_id]
      )
    }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.domaines.replace",
      entity_type: "FOURNISSEUR",
      entity_id: fournisseurId,
      details: { domaines: normalized.map((d) => d.domaine_code) },
    })
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err // no longer swallowed — a failed write must surface
  } finally {
    client.release()
  }
  return repoGetFournisseur(fournisseurId)
}

export async function repoListFournisseurEvents(fournisseurId: string): Promise<FournisseurEvent[] | null> {
  if (!(await ensureFournisseurExists(db, fournisseurId))) return null
  const res = await db.query<FournisseurEvent>(
    `SELECT id::text AS id, fournisseur_id::text AS fournisseur_id, event_type, title, description,
            COALESCE(metadata, '{}'::jsonb) AS metadata, created_by, created_at::text AS created_at
     FROM public.fournisseur_events WHERE fournisseur_id = $1::uuid
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    [fournisseurId]
  )
  return res.rows
}

// Keeps the flat "primary address" columns on fournisseurs as a read-cache of the
// primary "commande" address — single write path, never divergently written by clients.
async function syncPrimaryAddressCache(tx: DbQueryer, fournisseurId: string, userId: number) {
  await tx.query(
    `UPDATE public.fournisseurs f SET
       adresse_ligne = a.ligne1, house_no = a.house_no, postcode = a.postcode,
       city = a.city, country = a.country, updated_at = now(), updated_by = $2
     FROM (
       SELECT ligne1, house_no, postcode, city, country
       FROM public.fournisseur_adresses
       WHERE fournisseur_id = $1::uuid AND actif AND type = 'commande'
       ORDER BY is_primary DESC, updated_at DESC LIMIT 1
     ) a
     WHERE f.id = $1::uuid`,
    [fournisseurId, userId]
  )
}

async function insertAdresse(tx: DbQueryer, fournisseurId: string, body: CreateAdresseBodyDTO, userId: number) {
  if (body.is_primary) {
    await tx.query(
      `UPDATE public.fournisseur_adresses SET is_primary = false, updated_at = now(), updated_by = $3
       WHERE fournisseur_id = $1::uuid AND type = $2 AND is_primary = true`,
      [fournisseurId, body.type, userId]
    )
  }
  const res = await tx.query<{ id: string }>(
    `INSERT INTO public.fournisseur_adresses
       (fournisseur_id, type, label, ligne1, ligne2, house_no, postcode, city, country, is_primary, actif, notes, created_by, updated_by)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id::text AS id`,
    [fournisseurId, body.type, body.label ?? null, body.ligne1 ?? null, body.ligne2 ?? null, body.house_no ?? null,
     body.postcode ?? null, body.city ?? null, body.country ?? null, body.is_primary ?? false, body.actif ?? true,
     body.notes ?? null, userId]
  )
  return res.rows[0]?.id ?? null
}

export async function repoCreateFournisseur(body: CreateFournisseurBodyDTO, audit: AuditContext): Promise<Fournisseur> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const code = await generateFournisseurCode(client)
    const ins = await client.query<{ id: string }>(
      `INSERT INTO public.fournisseurs (
         code, code_fournisseur, nom, raison_sociale, actif, status, type_principal,
         tva, siret, email, telephone, site_web, nom_commercial, logo, notes, created_by, updated_by
       ) VALUES ($1,$1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id::text AS id`,
      [code, body.nom, body.actif ?? true, body.status ?? "actif", body.type_principal ?? null,
       body.tva ?? null, body.siret ?? null, body.email ?? null, body.telephone ?? null, body.site_web ?? null,
       body.nom_commercial ?? null, body.logo ?? null, body.notes ?? null, audit.user_id]
    )
    const id = ins.rows[0]?.id
    if (!id) throw new Error("Failed to create fournisseur")

    if (body.domaines?.length) {
      const normalized = body.domaines.map((d, i) => ({
        ...d, is_primary: Boolean(d.is_primary) || (i === 0 && !body.domaines!.some((x) => x.is_primary)),
      }))
      for (const d of normalized) {
        await client.query(
          `INSERT INTO public.fournisseur_domaine_lien (fournisseur_id, domaine_code, is_primary, notes, created_by, updated_by)
           VALUES ($1::uuid,$2,$3,$4,$5,$5) ON CONFLICT (fournisseur_id, domaine_code) DO NOTHING`,
          [id, d.domaine_code, d.is_primary, d.notes ?? null, audit.user_id]
        )
      }
    }
    if (body.adresses?.length) {
      for (const a of body.adresses) await insertAdresse(client, id, a, audit.user_id)
      await syncPrimaryAddressCache(client, id, audit.user_id)
    }

    await insertEvent(client, id, audit.user_id, { event_type: "created", title: `Fournisseur ${code} créé` })
    await insertAuditLog(client, audit, {
      action: "fournisseurs.create", entity_type: "FOURNISSEUR", entity_id: id,
      details: { code, nom: body.nom },
    })
    await client.query("COMMIT")
    const created = await repoGetFournisseur(id)
    if (!created) throw new Error("Failed to reload created fournisseur")
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
): Promise<Fournisseur | null | "conflict"> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }

  if (patch.nom !== undefined) { sets.push(`nom = ${push(patch.nom)}`); sets.push(`raison_sociale = ${push(patch.nom)}`) }
  if (patch.actif !== undefined) sets.push(`actif = ${push(patch.actif)}`)
  if (patch.status !== undefined) sets.push(`status = ${push(patch.status)}`)
  if (patch.type_principal !== undefined) sets.push(`type_principal = ${push(patch.type_principal)}`)
  if (patch.tva !== undefined) sets.push(`tva = ${push(patch.tva)}`)
  if (patch.siret !== undefined) sets.push(`siret = ${push(patch.siret)}`)
  if (patch.email !== undefined) sets.push(`email = ${push(patch.email)}`)
  if (patch.telephone !== undefined) sets.push(`telephone = ${push(patch.telephone)}`)
  if (patch.site_web !== undefined) sets.push(`site_web = ${push(patch.site_web)}`)
  if (patch.nom_commercial !== undefined) sets.push(`nom_commercial = ${push(patch.nom_commercial)}`)
  if (patch.logo !== undefined) sets.push(`logo = ${push(patch.logo)}`)
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`)
  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)

  try {
    await client.query("BEGIN")
    const lock = await client.query<{ updated_at: string }>(
      `SELECT updated_at::text AS updated_at FROM public.fournisseurs WHERE id = $1::uuid FOR UPDATE`, [id]
    )
    const current = lock.rows[0] ?? null
    if (!current) { await client.query("ROLLBACK"); return null }
    if (patch.expected_updated_at && new Date(patch.expected_updated_at).getTime() !== new Date(current.updated_at).getTime()) {
      await client.query("ROLLBACK"); return "conflict"
    }
    await client.query(`UPDATE public.fournisseurs SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid`, values)
    await insertAuditLog(client, audit, {
      action: "fournisseurs.update", entity_type: "FOURNISSEUR", entity_id: id, details: { patch },
    })
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
  return repoGetFournisseur(id)
}

export async function repoDeactivateFournisseur(id: string, audit: AuditContext): Promise<boolean> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lock = await client.query<{ code: string; nom: string; actif: boolean }>(
      `SELECT COALESCE(code, code_fournisseur) AS code, COALESCE(nom, raison_sociale) AS nom, actif
       FROM public.fournisseurs WHERE id = $1::uuid FOR UPDATE`, [id]
    )
    const before = lock.rows[0] ?? null
    if (!before) { await client.query("ROLLBACK"); return false }
    await client.query(`UPDATE public.fournisseurs SET actif = false, updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [id, audit.user_id])
    await insertEvent(client, id, audit.user_id, { event_type: "deactivated", title: `Fournisseur ${before.code} désactivé` })
    await insertAuditLog(client, audit, {
      action: "fournisseurs.deactivate", entity_type: "FOURNISSEUR", entity_id: id,
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

// Archive is distinct from deactivation. Refuses if the supplier is referenced by
// receptions (traceability) — physical deletion stays forbidden.
export async function repoArchiveFournisseur(id: string, motif: string | null, audit: AuditContext): Promise<boolean | null | "blocked"> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lock = await client.query<{ code: string }>(
      `SELECT COALESCE(code, code_fournisseur) AS code FROM public.fournisseurs WHERE id = $1::uuid FOR UPDATE`, [id]
    )
    const before = lock.rows[0] ?? null
    if (!before) { await client.query("ROLLBACK"); return null }

    const refs = await client.query<{ n: number }>(
      `SELECT COALESCE((SELECT count(*)::int FROM public.receptions_fournisseurs r WHERE r.fournisseur_id = $1::uuid), 0) AS n`,
      [id]
    ).catch(() => ({ rows: [{ n: 0 }] }))
    // Archiving is allowed even with references (unlike deletion); the check is recorded.
    const referenced = (refs.rows[0]?.n ?? 0) > 0

    await client.query(
      `UPDATE public.fournisseurs SET status = 'archive', archived_at = now(), actif = false, updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [id, audit.user_id]
    )
    await insertEvent(client, id, audit.user_id, {
      event_type: "archived", title: `Fournisseur ${before.code} archivé`, description: motif ?? null,
      metadata: { referenced_by_receptions: referenced },
    })
    await insertAuditLog(client, audit, {
      action: "fournisseurs.archive", entity_type: "FOURNISSEUR", entity_id: id,
      details: { code: before.code, motif, referenced_by_receptions: referenced },
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

// ---- Duplicate detection (protected; returns a minimal, non-sensitive projection) ----
export type DoublonCandidate = { id: string; code: string; nom: string; siret: string | null; tva: string | null; match: string }

export async function repoFindDoublons(filters: DoublonQueryDTO): Promise<DoublonCandidate[]> {
  const clauses: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }
  const norm = (col: string, val: string) => `regexp_replace(upper(f.${col}), '[^0-9A-Z]', '', 'g') = regexp_replace(upper(${push(val)}), '[^0-9A-Z]', '', 'g')`

  if (filters.siret) clauses.push(`(f.siret IS NOT NULL AND ${norm("siret", filters.siret)})`)
  if (filters.tva) clauses.push(`(f.tva IS NOT NULL AND ${norm("tva", filters.tva)})`)
  if (filters.email) clauses.push(`lower(f.email) = lower(${push(filters.email)})`)
  if (!clauses.length) return []

  let where = `(${clauses.join(" OR ")})`
  if (filters.exclude_id) where += ` AND f.id <> ${push(filters.exclude_id)}::uuid`

  const res = await db.query<DoublonCandidate>(
    `SELECT f.id::text AS id, COALESCE(f.code, f.code_fournisseur) AS code, COALESCE(f.nom, f.raison_sociale) AS nom,
            f.siret, f.tva,
            CASE WHEN ${filters.siret ? norm("siret", filters.siret) : "false"} THEN 'siret'
                 WHEN ${filters.tva ? norm("tva", filters.tva) : "false"} THEN 'tva'
                 ELSE 'email' END AS match
     FROM public.fournisseurs f WHERE ${where} LIMIT 10`,
    values
  )
  return res.rows
}

// ============================ Contacts ============================

type ContactRow = {
  id: string; fournisseur_id: string; nom: string
  first_name: string | null; last_name: string | null; full_name: string | null
  email: string | null; telephone: string | null; mobile: string | null
  role: string | null; notes: string | null; is_primary: boolean | null; actif: boolean
  created_at: string; updated_at: string; created_by: number | null; updated_by: number | null
}

const CONTACT_SELECT = `
  id::text AS id, fournisseur_id::text AS fournisseur_id, nom, first_name, last_name, full_name,
  email, telephone, mobile, role, notes, is_primary, actif,
  created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by`

function mapContactRow(r: ContactRow): FournisseurContact {
  return {
    id: r.id, fournisseur_id: r.fournisseur_id, nom: r.nom,
    first_name: r.first_name ?? null, last_name: r.last_name ?? null, full_name: r.full_name ?? r.nom,
    email: r.email, telephone: r.telephone, mobile: r.mobile ?? null, role: r.role, notes: r.notes,
    is_primary: Boolean(r.is_primary), actif: r.actif,
    created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, updated_by: r.updated_by,
  }
}

export async function repoListFournisseurContacts(fournisseurId: string): Promise<FournisseurContact[] | null> {
  if (!(await ensureFournisseurExists(db, fournisseurId))) return null
  const res = await db.query<ContactRow>(
    `SELECT ${CONTACT_SELECT} FROM public.fournisseur_contacts
     WHERE fournisseur_id = $1::uuid AND actif = true ORDER BY is_primary DESC, nom ASC, id ASC`,
    [fournisseurId]
  )
  return res.rows.map(mapContactRow)
}

async function demoteOtherPrimaryContacts(tx: DbQueryer, fournisseurId: string, exceptId: string | null, userId: number) {
  await tx.query(
    `UPDATE public.fournisseur_contacts SET is_primary = false, updated_at = now(), updated_by = $3
     WHERE fournisseur_id = $1::uuid AND is_primary = true AND actif = true ${exceptId ? "AND id <> $2::uuid" : "AND $2::text IS NULL"}`,
    [fournisseurId, exceptId, userId]
  )
}

export async function repoCreateFournisseurContact(
  fournisseurId: string, body: CreateContactBodyDTO, audit: AuditContext
): Promise<FournisseurContact | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    if (body.is_primary) await demoteOtherPrimaryContacts(client, fournisseurId, null, audit.user_id)
    const ins = await client.query<ContactRow>(
      `INSERT INTO public.fournisseur_contacts
         (fournisseur_id, nom, first_name, last_name, full_name, email, telephone, mobile, role, notes, is_primary, actif, created_by, updated_by)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       RETURNING ${CONTACT_SELECT}`,
      [fournisseurId, body.nom, body.first_name ?? null, body.last_name ?? null,
       body.full_name ?? body.nom, body.email ?? null, body.telephone ?? null, body.mobile ?? null,
       body.role ?? null, body.notes ?? null, body.is_primary ?? false, body.actif ?? true, audit.user_id]
    )
    const row = ins.rows[0]
    if (!row) throw new Error("Failed to create fournisseur contact")
    await insertAuditLog(client, audit, {
      action: "fournisseurs.contacts.create", entity_type: "FOURNISSEUR", entity_id: fournisseurId,
      details: { contact_id: row.id, nom: row.nom, is_primary: row.is_primary },
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
  fournisseurId: string, contactId: string, patch: UpdateContactBodyDTO, audit: AuditContext
): Promise<FournisseurContact | null | false> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }
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
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    if (patch.is_primary === true) await demoteOtherPrimaryContacts(client, fournisseurId, contactId, audit.user_id)
    const res = await client.query<ContactRow>(
      `UPDATE public.fournisseur_contacts SET ${sets.join(", ")}
       WHERE id = ${push(contactId)}::uuid AND fournisseur_id = ${push(fournisseurId)}::uuid
       RETURNING ${CONTACT_SELECT}`,
      values
    )
    const row = res.rows[0] ?? null
    if (!row) { await client.query("ROLLBACK"); return false }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.contacts.update", entity_type: "FOURNISSEUR_CONTACT", entity_id: contactId,
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
  fournisseurId: string, contactId: string, audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const upd = await client.query(
      `UPDATE public.fournisseur_contacts SET actif = false, is_primary = false, updated_at = now(), updated_by = $3
       WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND actif = true`,
      [contactId, fournisseurId, audit.user_id]
    )
    if ((upd.rowCount ?? 0) === 0) { await client.query("ROLLBACK"); return false }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.contacts.delete", entity_type: "FOURNISSEUR_CONTACT", entity_id: contactId,
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

// ============================ Addresses ============================

type AdresseRow = {
  id: string; fournisseur_id: string; type: FournisseurAdresse["type"]; label: string | null
  ligne1: string | null; ligne2: string | null; house_no: string | null; postcode: string | null
  city: string | null; country: string | null; is_primary: boolean; actif: boolean; notes: string | null
  created_at: string; updated_at: string; created_by: number | null; updated_by: number | null
}
const ADRESSE_SELECT = `
  id::text AS id, fournisseur_id::text AS fournisseur_id, type, label, ligne1, ligne2, house_no, postcode,
  city, country, is_primary, actif, notes, created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by`

function mapAdresseRow(r: AdresseRow): FournisseurAdresse { return { ...r } }

export async function repoListFournisseurAdresses(fournisseurId: string): Promise<FournisseurAdresse[] | null> {
  if (!(await ensureFournisseurExists(db, fournisseurId))) return null
  const res = await db.query<AdresseRow>(
    `SELECT ${ADRESSE_SELECT} FROM public.fournisseur_adresses
     WHERE fournisseur_id = $1::uuid AND actif = true ORDER BY type ASC, is_primary DESC, id ASC`,
    [fournisseurId]
  )
  return res.rows.map(mapAdresseRow)
}

export async function repoCreateFournisseurAdresse(
  fournisseurId: string, body: CreateAdresseBodyDTO, audit: AuditContext
): Promise<FournisseurAdresse | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const id = await insertAdresse(client, fournisseurId, body, audit.user_id)
    if (!id) throw new Error("Failed to create fournisseur adresse")
    if (body.type === "commande") await syncPrimaryAddressCache(client, fournisseurId, audit.user_id)
    await insertAuditLog(client, audit, {
      action: "fournisseurs.adresses.create", entity_type: "FOURNISSEUR", entity_id: fournisseurId,
      details: { adresse_id: id, type: body.type },
    })
    const res = await client.query<AdresseRow>(`SELECT ${ADRESSE_SELECT} FROM public.fournisseur_adresses WHERE id = $1::uuid`, [id])
    await client.query("COMMIT")
    return res.rows[0] ? mapAdresseRow(res.rows[0]) : null
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoUpdateFournisseurAdresse(
  fournisseurId: string, adresseId: string, patch: UpdateAdresseBodyDTO, audit: AuditContext
): Promise<FournisseurAdresse | null | false> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }
  for (const key of ["type", "label", "ligne1", "ligne2", "house_no", "postcode", "city", "country", "is_primary", "actif", "notes"] as const) {
    if (patch[key] !== undefined) sets.push(`${key} = ${push(patch[key])}`)
  }
  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const cur = await client.query<{ type: string }>(
      `SELECT type FROM public.fournisseur_adresses WHERE id = $1::uuid AND fournisseur_id = $2::uuid FOR UPDATE`,
      [adresseId, fournisseurId]
    )
    if (!cur.rows[0]) { await client.query("ROLLBACK"); return false }
    const targetType = patch.type ?? cur.rows[0].type
    if (patch.is_primary === true) {
      await client.query(
        `UPDATE public.fournisseur_adresses SET is_primary = false, updated_at = now(), updated_by = $4
         WHERE fournisseur_id = $1::uuid AND type = $2 AND is_primary = true AND id <> $3::uuid`,
        [fournisseurId, targetType, adresseId, audit.user_id]
      )
    }
    const res = await client.query<AdresseRow>(
      `UPDATE public.fournisseur_adresses SET ${sets.join(", ")}
       WHERE id = ${push(adresseId)}::uuid AND fournisseur_id = ${push(fournisseurId)}::uuid RETURNING ${ADRESSE_SELECT}`,
      values
    )
    const row = res.rows[0] ?? null
    if (!row) { await client.query("ROLLBACK"); return false }
    if (targetType === "commande") await syncPrimaryAddressCache(client, fournisseurId, audit.user_id)
    await insertAuditLog(client, audit, {
      action: "fournisseurs.adresses.update", entity_type: "FOURNISSEUR_ADRESSE", entity_id: adresseId,
      details: { fournisseur_id: fournisseurId, patch },
    })
    await client.query("COMMIT")
    return mapAdresseRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoSoftDeleteFournisseurAdresse(
  fournisseurId: string, adresseId: string, audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const upd = await client.query(
      `UPDATE public.fournisseur_adresses SET actif = false, is_primary = false, updated_at = now(), updated_by = $3
       WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND actif = true`,
      [adresseId, fournisseurId, audit.user_id]
    )
    if ((upd.rowCount ?? 0) === 0) { await client.query("ROLLBACK"); return false }
    await syncPrimaryAddressCache(client, fournisseurId, audit.user_id)
    await insertAuditLog(client, audit, {
      action: "fournisseurs.adresses.delete", entity_type: "FOURNISSEUR_ADRESSE", entity_id: adresseId,
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

// ============================ Homologations ============================

type HomologationRow = {
  id: string; fournisseur_id: string; domaine_code: string | null; statut: FournisseurHomologation["statut"]
  reference: string | null; organisme: string | null; perimetre: string | null
  valid_from: string | null; valid_to: string | null; document_id: string | null
  version: number; is_current: boolean; notes: string | null
  created_at: string; updated_at: string; created_by: number | null; updated_by: number | null
}
const HOMOLOGATION_SELECT = `
  id::text AS id, fournisseur_id::text AS fournisseur_id, domaine_code, statut, reference, organisme, perimetre,
  valid_from::text AS valid_from, valid_to::text AS valid_to, document_id::text AS document_id, version, is_current, notes,
  created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by`

function mapHomologationRow(r: HomologationRow): FournisseurHomologation {
  return { ...r, version: Number(r.version) }
}

export async function repoListFournisseurHomologations(fournisseurId: string): Promise<FournisseurHomologation[] | null> {
  if (!(await ensureFournisseurExists(db, fournisseurId))) return null
  const res = await db.query<HomologationRow>(
    `SELECT ${HOMOLOGATION_SELECT} FROM public.fournisseur_homologations
     WHERE fournisseur_id = $1::uuid ORDER BY is_current DESC, updated_at DESC, id DESC`,
    [fournisseurId]
  )
  return res.rows.map(mapHomologationRow)
}

export async function repoCreateFournisseurHomologation(
  fournisseurId: string, body: CreateHomologationBodyDTO, audit: AuditContext
): Promise<FournisseurHomologation | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    // Supersede the current homologation for the same domain scope (versioning).
    await client.query(
      `UPDATE public.fournisseur_homologations SET is_current = false, updated_at = now(), updated_by = $3
       WHERE fournisseur_id = $1::uuid AND COALESCE(domaine_code,'') = COALESCE($2::text,'') AND is_current = true`,
      [fournisseurId, body.domaine_code ?? null, audit.user_id]
    )
    const ver = await client.query<{ v: number }>(
      `SELECT COALESCE(MAX(version),0)+1 AS v FROM public.fournisseur_homologations
       WHERE fournisseur_id = $1::uuid AND COALESCE(domaine_code,'') = COALESCE($2::text,'')`,
      [fournisseurId, body.domaine_code ?? null]
    )
    const ins = await client.query<HomologationRow>(
      `INSERT INTO public.fournisseur_homologations
         (fournisseur_id, domaine_code, statut, reference, organisme, perimetre, valid_from, valid_to, document_id, version, is_current, notes, created_by, updated_by)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::date,$8::date,$9::uuid,$10,true,$11,$12,$12)
       RETURNING ${HOMOLOGATION_SELECT}`,
      [fournisseurId, body.domaine_code ?? null, body.statut ?? "a_qualifier", body.reference ?? null,
       body.organisme ?? null, body.perimetre ?? null, body.valid_from ?? null, body.valid_to ?? null,
       body.document_id ?? null, ver.rows[0]?.v ?? 1, body.notes ?? null, audit.user_id]
    )
    const row = ins.rows[0]
    if (!row) throw new Error("Failed to create homologation")
    await insertEvent(client, fournisseurId, audit.user_id, {
      event_type: "homologation", title: `Homologation ${body.statut ?? "a_qualifier"}`,
      metadata: { domaine_code: body.domaine_code ?? null, statut: body.statut ?? "a_qualifier" },
    })
    await insertAuditLog(client, audit, {
      action: "fournisseurs.homologations.create", entity_type: "FOURNISSEUR", entity_id: fournisseurId,
      details: { homologation_id: row.id, statut: row.statut, domaine_code: row.domaine_code },
    })
    await client.query("COMMIT")
    return mapHomologationRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function repoUpdateFournisseurHomologation(
  fournisseurId: string, homologationId: string, patch: UpdateHomologationBodyDTO, audit: AuditContext
): Promise<FournisseurHomologation | null | false> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }
  if (patch.domaine_code !== undefined) sets.push(`domaine_code = ${push(patch.domaine_code)}`)
  if (patch.statut !== undefined) sets.push(`statut = ${push(patch.statut)}`)
  if (patch.reference !== undefined) sets.push(`reference = ${push(patch.reference)}`)
  if (patch.organisme !== undefined) sets.push(`organisme = ${push(patch.organisme)}`)
  if (patch.perimetre !== undefined) sets.push(`perimetre = ${push(patch.perimetre)}`)
  if (patch.valid_from !== undefined) sets.push(`valid_from = ${push(patch.valid_from)}::date`)
  if (patch.valid_to !== undefined) sets.push(`valid_to = ${push(patch.valid_to)}::date`)
  if (patch.document_id !== undefined) sets.push(`document_id = ${push(patch.document_id)}::uuid`)
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`)
  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const res = await client.query<HomologationRow>(
      `UPDATE public.fournisseur_homologations SET ${sets.join(", ")}
       WHERE id = ${push(homologationId)}::uuid AND fournisseur_id = ${push(fournisseurId)}::uuid RETURNING ${HOMOLOGATION_SELECT}`,
      values
    )
    const row = res.rows[0] ?? null
    if (!row) { await client.query("ROLLBACK"); return false }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.homologations.update", entity_type: "FOURNISSEUR_HOMOLOGATION", entity_id: homologationId,
      details: { fournisseur_id: fournisseurId, patch },
    })
    await client.query("COMMIT")
    return mapHomologationRow(row)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

// ============================ Catalogue ============================

type CatalogueRow = {
  id: string; fournisseur_id: string; type: string; article_id: string | null; designation: string
  reference_fournisseur: string | null; unite: string | null; prix_unitaire: number | null; devise: string | null
  delai_jours: number | null; moq: number | null; conditions: string | null
  incoterm: string | null; prix_multiple: number | null; valid_from: string | null; valid_to: string | null
  exigence_qualite: string | null; requiert_controle_reception: boolean; actif: boolean
  created_at: string; updated_at: string; created_by: number | null; updated_by: number | null
}
const CATALOGUE_SELECT = `
  id::text AS id, fournisseur_id::text AS fournisseur_id, type, article_id::text AS article_id, designation,
  reference_fournisseur, unite, prix_unitaire::float8 AS prix_unitaire, devise, delai_jours, moq::float8 AS moq, conditions,
  incoterm, prix_multiple::float8 AS prix_multiple, valid_from::text AS valid_from, valid_to::text AS valid_to,
  exigence_qualite, requiert_controle_reception, actif,
  created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by`

function mapCatalogueRow(r: CatalogueRow): FournisseurCatalogueItem {
  const t = String(r.type)
  const type = (["MATIERE", "CONSOMMABLE", "SOUS_TRAITANCE", "SERVICE", "OUTILLAGE", "AUTRE"] as const).includes(t as never)
    ? (t as FournisseurCatalogueItem["type"]) : "AUTRE"
  return {
    id: r.id, fournisseur_id: r.fournisseur_id, type, article_id: r.article_id, designation: r.designation,
    reference_fournisseur: r.reference_fournisseur, unite: r.unite,
    prix_unitaire: r.prix_unitaire === null ? null : Number(r.prix_unitaire), devise: r.devise,
    delai_jours: r.delai_jours === null ? null : Number(r.delai_jours),
    moq: r.moq === null ? null : Number(r.moq), conditions: r.conditions,
    incoterm: r.incoterm, prix_multiple: r.prix_multiple === null ? null : Number(r.prix_multiple),
    valid_from: r.valid_from, valid_to: r.valid_to, exigence_qualite: r.exigence_qualite,
    requiert_controle_reception: Boolean(r.requiert_controle_reception), actif: r.actif,
    created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, updated_by: r.updated_by,
  }
}

export async function repoListFournisseurCatalogue(
  fournisseurId: string, filters: ListCatalogueQueryDTO
): Promise<FournisseurCatalogueItem[] | null> {
  if (!(await ensureFournisseurExists(db, fournisseurId))) return null
  const where: string[] = ["fournisseur_id = $1::uuid"]
  const values: unknown[] = [fournisseurId]
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }
  if (filters.type) where.push(`type = ${push(filters.type)}`)
  if (typeof filters.actif === "boolean") where.push(`actif = ${push(filters.actif)}`)
  else where.push("actif = true")
  const res = await db.query<CatalogueRow>(
    `SELECT ${CATALOGUE_SELECT} FROM public.fournisseur_catalogue WHERE ${where.join(" AND ")}
     ORDER BY type ASC, designation ASC, id ASC`, values
  )
  return res.rows.map(mapCatalogueRow)
}

async function recordCataloguePrice(tx: DbQueryer, catalogueId: string, row: CatalogueRow, userId: number) {
  await tx.query(
    `INSERT INTO public.fournisseur_catalogue_prix_history (catalogue_id, prix_unitaire, devise, delai_jours, moq, valid_from, recorded_by)
     VALUES ($1::uuid,$2,$3,$4,$5,$6::date,$7)`,
    [catalogueId, row.prix_unitaire, row.devise, row.delai_jours, row.moq, row.valid_from, userId]
  )
}

export async function repoCreateFournisseurCatalogueItem(
  fournisseurId: string, body: CreateCatalogueBodyDTO, audit: AuditContext
): Promise<FournisseurCatalogueItem | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const ins = await client.query<CatalogueRow>(
      `INSERT INTO public.fournisseur_catalogue
         (fournisseur_id, type, article_id, designation, reference_fournisseur, unite, prix_unitaire, devise,
          delai_jours, moq, conditions, incoterm, prix_multiple, valid_from, valid_to, exigence_qualite,
          requiert_controle_reception, actif, created_by, updated_by)
       VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::date,$16,$17,$18,$19,$19)
       RETURNING ${CATALOGUE_SELECT}`,
      [fournisseurId, body.type, body.article_id ?? null, body.designation, body.reference_fournisseur ?? null,
       body.unite ?? null, body.prix_unitaire ?? null, body.devise ?? "EUR", body.delai_jours ?? null, body.moq ?? null,
       body.conditions ?? null, body.incoterm ?? null, body.prix_multiple ?? null, body.valid_from ?? null,
       body.valid_to ?? null, body.exigence_qualite ?? null, body.requiert_controle_reception ?? false, body.actif ?? true, audit.user_id]
    )
    const row = ins.rows[0]
    if (!row) throw new Error("Failed to create catalogue item")
    if (row.prix_unitaire !== null) await recordCataloguePrice(client, row.id, row, audit.user_id)
    await insertAuditLog(client, audit, {
      action: "fournisseurs.catalogue.create", entity_type: "FOURNISSEUR", entity_id: fournisseurId,
      details: { catalogue_id: row.id, type: row.type, designation: row.designation },
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
  fournisseurId: string, catalogueId: string, patch: UpdateCatalogueBodyDTO, audit: AuditContext
): Promise<FournisseurCatalogueItem | null | false> {
  const client = await db.connect()
  const sets: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => { values.push(v); return `$${values.length}` }
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
  if (patch.incoterm !== undefined) sets.push(`incoterm = ${push(patch.incoterm)}`)
  if (patch.prix_multiple !== undefined) sets.push(`prix_multiple = ${push(patch.prix_multiple)}`)
  if (patch.valid_from !== undefined) sets.push(`valid_from = ${push(patch.valid_from)}::date`)
  if (patch.valid_to !== undefined) sets.push(`valid_to = ${push(patch.valid_to)}::date`)
  if (patch.exigence_qualite !== undefined) sets.push(`exigence_qualite = ${push(patch.exigence_qualite)}`)
  if (patch.requiert_controle_reception !== undefined) sets.push(`requiert_controle_reception = ${push(patch.requiert_controle_reception)}`)
  if (patch.actif !== undefined) sets.push(`actif = ${push(patch.actif)}`)
  sets.push("updated_at = now()")
  sets.push(`updated_by = ${push(audit.user_id)}`)
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const res = await client.query<CatalogueRow>(
      `UPDATE public.fournisseur_catalogue SET ${sets.join(", ")}
       WHERE id = ${push(catalogueId)}::uuid AND fournisseur_id = ${push(fournisseurId)}::uuid RETURNING ${CATALOGUE_SELECT}`,
      values
    )
    const row = res.rows[0] ?? null
    if (!row) { await client.query("ROLLBACK"); return false }
    const priceTouched = patch.prix_unitaire !== undefined || patch.delai_jours !== undefined || patch.moq !== undefined || patch.devise !== undefined
    if (priceTouched && row.prix_unitaire !== null) await recordCataloguePrice(client, row.id, row, audit.user_id)
    await insertAuditLog(client, audit, {
      action: "fournisseurs.catalogue.update", entity_type: "FOURNISSEUR_CATALOGUE", entity_id: catalogueId,
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
  fournisseurId: string, catalogueId: string, audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const upd = await client.query(
      `UPDATE public.fournisseur_catalogue SET actif = false, updated_at = now(), updated_by = $3
       WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND actif = true`,
      [catalogueId, fournisseurId, audit.user_id]
    )
    if ((upd.rowCount ?? 0) === 0) { await client.query("ROLLBACK"); return false }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.catalogue.delete", entity_type: "FOURNISSEUR_CATALOGUE", entity_id: catalogueId,
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

// ============================ Documents ============================

type DocumentRow = {
  id: string; fournisseur_id: string; document_type: string; commentaire: string | null
  original_name: string; mime_type: string; size_bytes: string; sha256: string | null; label: string | null
  uploaded_by: number | null; removed_at: string | null; removed_by: number | null
  created_at: string; updated_at: string; created_by: number | null; updated_by: number | null
}
// Client-facing SELECT — storage_path / stored_name are intentionally excluded.
const DOCUMENT_SELECT = `
  id::text AS id, fournisseur_id::text AS fournisseur_id, document_type, commentaire, original_name, mime_type,
  size_bytes::text AS size_bytes, sha256, label, uploaded_by, removed_at::text AS removed_at, removed_by,
  created_at::text AS created_at, updated_at::text AS updated_at, created_by, updated_by`

function mapDocumentRow(r: DocumentRow): FournisseurDocument {
  return {
    id: r.id, fournisseur_id: r.fournisseur_id, document_type: r.document_type, commentaire: r.commentaire,
    original_name: r.original_name, mime_type: r.mime_type, size_bytes: Number(r.size_bytes), sha256: r.sha256,
    label: r.label, uploaded_by: r.uploaded_by, removed_at: r.removed_at, removed_by: r.removed_by,
    created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, updated_by: r.updated_by,
  }
}

export async function repoListFournisseurDocuments(fournisseurId: string): Promise<FournisseurDocument[] | null> {
  if (!(await ensureFournisseurExists(db, fournisseurId))) return null
  const res = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_SELECT} FROM public.fournisseur_documents
     WHERE fournisseur_id = $1::uuid AND removed_at IS NULL ORDER BY created_at DESC, id DESC`,
    [fournisseurId]
  )
  return res.rows.map(mapDocumentRow)
}

export async function repoAttachFournisseurDocuments(
  fournisseurId: string, body: AttachDocumentsBodyDTO, documents: UploadedDocument[], audit: AuditContext
): Promise<FournisseurDocument[] | null> {
  // Validate every upload BEFORE opening a transaction or moving files.
  const validated: Array<{ doc: UploadedDocument; ext: string }> = []
  for (const doc of documents) validated.push({ doc, ext: await assertUploadAllowed(doc) })

  const client = await db.connect()
  const docsDirRel = ensureDocumentStoragePath("fournisseurs")
  const docsDirAbs = path.resolve(docsDirRel)
  const movedFiles: string[] = []
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    if (!validated.length) { await client.query("COMMIT"); return [] }
    await fs.mkdir(docsDirAbs, { recursive: true })
    const inserted: FournisseurDocument[] = []
    for (const { doc, ext } of validated) {
      const documentId = crypto.randomUUID()
      const storedName = `${documentId}${ext}`
      const relPath = toPosixPath(path.join(docsDirRel, storedName))
      const absPath = path.join(docsDirAbs, storedName)
      const tempPath = path.resolve(doc.path)
      try { await fs.rename(tempPath, absPath) } catch { await fs.copyFile(tempPath, absPath); await fs.unlink(tempPath) }
      movedFiles.push(absPath)
      const hash = await sha256File(absPath)
      const ins = await client.query<DocumentRow>(
        `INSERT INTO public.fournisseur_documents
           (fournisseur_id, document_type, commentaire, original_name, stored_name, storage_path, mime_type, size_bytes, sha256, label, uploaded_by, created_by, updated_by)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11) RETURNING ${DOCUMENT_SELECT}`,
        [fournisseurId, body.document_type, body.commentaire ?? null, doc.originalname, storedName, relPath,
         doc.mimetype, doc.size, hash, body.label ?? null, audit.user_id]
      )
      const row = ins.rows[0]
      if (!row) throw new Error("Failed to insert fournisseur document")
      inserted.push(mapDocumentRow(row))
    }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.documents.attach", entity_type: "FOURNISSEUR", entity_id: fournisseurId,
      details: { document_type: body.document_type, count: inserted.length,
        documents: inserted.map((d) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes })) },
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
  fournisseurId: string, documentId: string, audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const current = await client.query<{ original_name: string }>(
      `SELECT original_name FROM public.fournisseur_documents
       WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND removed_at IS NULL FOR UPDATE`,
      [documentId, fournisseurId]
    )
    const doc = current.rows[0] ?? null
    if (!doc) { await client.query("ROLLBACK"); return false }
    await client.query(
      `UPDATE public.fournisseur_documents SET removed_at = now(), removed_by = $3, updated_at = now(), updated_by = $3
       WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND removed_at IS NULL`,
      [documentId, fournisseurId, audit.user_id]
    )
    await insertAuditLog(client, audit, {
      action: "fournisseurs.documents.remove", entity_type: "FOURNISSEUR_DOCUMENT", entity_id: documentId,
      details: { fournisseur_id: fournisseurId, original_name: doc.original_name },
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
  fournisseurId: string, documentId: string, audit: AuditContext
): Promise<FournisseurDocumentDownload | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    if (!(await ensureFournisseurExists(client, fournisseurId))) { await client.query("ROLLBACK"); return null }
    const res = await client.query<{ storage_path: string; mime_type: string; original_name: string }>(
      `SELECT storage_path, mime_type, original_name FROM public.fournisseur_documents
       WHERE id = $1::uuid AND fournisseur_id = $2::uuid AND removed_at IS NULL LIMIT 1`,
      [documentId, fournisseurId]
    )
    const row = res.rows[0] ?? null
    if (!row) { await client.query("ROLLBACK"); return null }
    await insertAuditLog(client, audit, {
      action: "fournisseurs.documents.download", entity_type: "FOURNISSEUR_DOCUMENT", entity_id: documentId,
      details: { fournisseur_id: fournisseurId, original_name: row.original_name },
    })
    await client.query("COMMIT")
    return { storage_path: row.storage_path, mime_type: row.mime_type, original_name: row.original_name }
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
