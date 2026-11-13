/**
 * Temporary, deliberately narrow compatibility surface for deployments which
 * predate the stock referential routes.  Mount this router at `/stock` after
 * the company context middleware and before the legacy stock module gate.
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z, ZodError } from "zod";

import pool from "../config/database";
import { nuanceIdentity, resolveNuanceIdentity, nuanceNormeShape, nuanceNormeFields } from "../module/stock/domain/nuance-library";
import { HttpError } from "../utils/httpError";
import { authenticateToken } from "../module/auth/middlewares/auth.middleware";
import { repoInsertAuditLog } from "../module/audit-logs/repository/audit-logs.repository";

type ReferentialKind = "nuances" | "etats" | "sous-etats";
type ReferentialConfig = {
  kind: ReferentialKind;
  table: "stock_nuances" | "stock_etats" | "stock_sous_etats";
  pageKey: "matiere-nuances" | "matiere-etats" | "matiere-sous-etats";
  density: boolean;
};

const configs: Record<ReferentialKind, ReferentialConfig> = {
  nuances: { kind: "nuances", table: "stock_nuances", pageKey: "matiere-nuances", density: true },
  etats: { kind: "etats", table: "stock_etats", pageKey: "matiere-etats", density: false },
  "sous-etats": { kind: "sous-etats", table: "stock_sous_etats", pageKey: "matiere-sous-etats", density: false },
};

const codeSchema = z.string().min(1).max(40);
const designationSchema = z.string().max(160).nullable();
const informationsSchema = z.string().max(10000).nullable();
const densitySchema = z.number().finite().min(100).max(30000).nullable();
const positiveId = z.number().int().positive();
const createSchema = z.object({
  code: codeSchema,
  designation: designationSchema.optional(),
  informations: informationsSchema.optional(),
  densite: densitySchema.optional(),
  is_active: z.boolean().optional(),
  etat_ids: z.array(positiveId).max(500).optional(),
  nuance_ids: z.array(positiveId).max(500).optional(),
  unite_achat: positiveId.optional(),
  etat_id: positiveId.nullable().optional(),
}).strict();
const patchSchema = z.object({
  code: codeSchema.optional(),
  designation: designationSchema.optional(),
  informations: informationsSchema.optional(),
  densite: densitySchema.optional(),
  is_active: z.boolean().optional(),
  unite_achat: positiveId.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, "At least one mutable field is required");
const nuanceCreateSchema = createSchema.extend({ ...nuanceNormeShape, code: codeSchema.optional() });
const nuancePatchSchema = z.object({
  ...nuanceNormeShape, code: codeSchema.optional(), designation: designationSchema.optional(),
  densite: densitySchema.optional(), is_active: z.boolean().optional(),
}).strict().refine(body => Object.keys(body).length > 0, "At least one mutable field is required");
type CompatNuanceFields = z.infer<typeof nuanceCreateSchema>;
const idSchema = z.coerce.number().int().positive();

function normalizeCode(raw: string): string {
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!code) throw new ValidationError("code must contain letters or digits");
  return code;
}

class ValidationError extends Error {}
function isPgUniqueViolation(error: unknown): boolean { return (error as { code?: unknown } | null)?.code === "23505"; }
function isPgForeignKeyViolation(error: unknown): boolean { return (error as { code?: unknown } | null)?.code === "23503"; }

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof ZodError) throw new ValidationError(error.issues.map((issue) => issue.message).join("; "));
    throw error;
  }
}

function apiRow(config: ReferentialConfig, row: Record<string, unknown>) {
  const designation = typeof row.designation === "string" && row.designation.trim() ? row.designation : null;
  const common = { id: Number(row.id), code: String(row.code), designation, is_active: Boolean(row.is_active) };
  if (config.kind === "nuances") {
    const densite = row.densite === null || row.densite === undefined ? null : Number(row.densite);
    return { ...common, ...nuanceIdentity(row), densite: Number.isFinite(densite as number) ? densite : null, etat_ids: Array.isArray(row.etat_ids) ? row.etat_ids.map(Number) : [] };
  }
  if (config.kind === "etats") return { ...common, unite_achat: Number(row.unite_achat) || 3020, nuance_ids: Array.isArray(row.nuance_ids) ? row.nuance_ids.map(Number) : [] };
  return { ...common, etat_id: row.etat_id === null ? null : Number(row.etat_id), informations: typeof row.informations === "string" && row.informations.trim() ? row.informations : null };
}

function listFilters(config: ReferentialConfig, query: Request["query"]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q) where.push(`(${config.kind === "nuances" ? "n" : config.kind === "etats" ? "e" : "se"}.code ILIKE ${push(`%${q}%`)} OR ${config.kind === "nuances" ? "n" : config.kind === "etats" ? "e" : "se"}.designation ILIKE $${values.length})`);
  const active = query.is_active === "true" ? true : query.is_active === "false" ? false : undefined;
  const alias = config.kind === "nuances" ? "n" : config.kind === "etats" ? "e" : "se";
  if (q && config.kind === "nuances") {
    const pattern = `$${values.length}`;
    where[0] = `(n.code ILIKE ${pattern} OR n.designation ILIKE ${pattern} OR n.norme_fr ILIKE ${pattern} OR n.norme_en ILIKE ${pattern} OR n.norme_werkstoff ILIKE ${pattern} OR n.norme_usa ILIKE ${pattern})`;
  }
  if (active !== undefined) where.push(`${alias}.is_active=${push(active)}`);
  const relation = config.kind === "etats" ? query.nuance_id : query.etat_id;
  const relationId = typeof relation === "string" && /^\d+$/.test(relation) ? Number(relation) : undefined;
  if (relation !== undefined && relationId === undefined) throw new ValidationError("relation id must be a positive integer");
  if (relationId === undefined || !Number.isSafeInteger(relationId) || relationId <= 0) {
    if (relationId !== undefined) throw new ValidationError("relation id must be a positive integer");
  } else if (config.kind === "nuances") where.push(`EXISTS (SELECT 1 FROM public.stock_nuance_etats ne_filter WHERE ne_filter.nuance_id=n.id AND ne_filter.etat_id=${push(relationId)}::bigint)`);
  else if (config.kind === "etats") where.push(`EXISTS (SELECT 1 FROM public.stock_nuance_etats ne_filter WHERE ne_filter.etat_id=e.id AND ne_filter.nuance_id=${push(relationId)}::bigint)`);
  else where.push(`se.etat_id=${push(relationId)}::bigint`);
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", values };
}

async function list(config: ReferentialConfig, query: Request["query"] = {}) {
  const filters = listFilters(config, query);
  if (config.kind === "nuances") {
    const result = await pool.query<Record<string, unknown>>(`SELECT n.id::int AS id,n.code,n.designation,n.norme_fr,n.norme_en,n.norme_werkstoff,n.norme_usa,n.designation_principale,COALESCE(NULLIF(to_jsonb(n)->>'densite_kg_m3','')::numeric,n.densite*1000) AS densite,n.is_active,COALESCE(array_agg(ne.etat_id::int ORDER BY ne.etat_id) FILTER (WHERE ne.etat_id IS NOT NULL),ARRAY[]::int[]) AS etat_ids FROM public.stock_nuances n LEFT JOIN public.stock_nuance_etats ne ON ne.nuance_id=n.id ${filters.sql} GROUP BY n.id ORDER BY n.code`, filters.values);
    return result.rows.map((row) => apiRow(config, row));
  }
  if (config.kind === "etats") {
    const result = await pool.query<Record<string, unknown>>(`SELECT e.id::int AS id,e.code,e.designation,e.unite_achat::int AS unite_achat,e.is_active,COALESCE(array_agg(ne.nuance_id::int ORDER BY ne.nuance_id) FILTER (WHERE ne.nuance_id IS NOT NULL),ARRAY[]::int[]) AS nuance_ids FROM public.stock_etats e LEFT JOIN public.stock_nuance_etats ne ON ne.etat_id=e.id ${filters.sql} GROUP BY e.id ORDER BY e.code`, filters.values);
    return result.rows.map((row) => apiRow(config, row));
  }
  const result = await pool.query<Record<string, unknown>>(`SELECT se.id::int AS id,se.etat_id::int AS etat_id,se.code,se.designation,se.informations,se.is_active FROM public.stock_sous_etats se ${filters.sql} ORDER BY se.code`, filters.values);
  return result.rows.map((row) => apiRow(config, row));
}

function auditContext(req: Request) {
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const session = typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null;
  return { user_id: req.user!.id, ip: req.ip || null, user_agent: userAgent, device_type: null, os: null, browser: null, path: req.originalUrl || null, client_session_id: session };
}

async function mutate(config: ReferentialConfig, req: Request, create: boolean) {
  const schema = config.kind === "nuances" ? (create ? nuanceCreateSchema : nuancePatchSchema) : (create ? createSchema : patchSchema);
  const raw = parseBody(schema as z.ZodType<unknown>, req.body);
  const body = raw as z.infer<typeof createSchema> & CompatNuanceFields;
  const identity = config.kind === "nuances" && create ? resolveNuanceIdentity(body) : null;
  if (!config.density && body.densite !== undefined) {
    throw new ValidationError("densite is only supported for matiere-nuances");
  }
  if (config.kind !== "nuances" && body.etat_ids !== undefined) throw new ValidationError("etat_ids is only supported for matiere-nuances");
  if (config.kind !== "etats" && body.nuance_ids !== undefined) throw new ValidationError("nuance_ids is only supported for matiere-etats");
  if (config.kind !== "etats" && body.unite_achat !== undefined) throw new ValidationError("unite_achat is only supported for matiere-etats");
  if (config.kind !== "sous-etats" && body.etat_id !== undefined) throw new ValidationError("etat_id is only supported for matiere-sous-etats");
  if (config.kind !== "sous-etats" && body.informations !== undefined) throw new ValidationError("informations is only supported for matiere-sous-etats");
  const code = body.code === undefined ? (identity ? normalizeCode(identity.libelle) : undefined) : normalizeCode(body.code);
  const designation = body.designation === undefined ? undefined : body.designation?.trim() || "";
  const informations = body.informations === undefined ? undefined : body.informations?.trim() || null;
  const densite = body.densite;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (config.kind === "nuances") await client.query("SELECT pg_advisory_xact_lock(20261113, 84)");
    let row: Record<string, unknown> | undefined;
    let before: unknown = undefined;
    if (create) {
      if (!code) throw new ValidationError("code is required");
      const columns = config.kind === "nuances" ? "code,designation,densite,is_active,norme_fr,norme_en,norme_werkstoff,norme_usa,designation_principale" : config.kind === "etats" ? "code,designation,unite_achat,is_active" : "etat_id,code,designation,informations,is_active";
      const params = config.kind === "nuances" ? [code, designation ?? "", densite === undefined || densite === null ? null : densite / 1000, body.is_active ?? true, ...nuanceNormeFields.map(key => identity![key]), identity!.designation_principale] : config.kind === "etats" ? [code, designation ?? "", body.unite_achat ?? 3020, body.is_active ?? true] : [body.etat_id ?? null, code, designation ?? "", informations ?? null, body.is_active ?? true];
      const result = await client.query<Record<string, unknown>>(`INSERT INTO public.${config.table} (${columns}) VALUES (${params.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id::int AS id,code,designation,${config.kind === "sous-etats" ? "informations," : ""}is_active`, params);
      row = result.rows[0];
      const relationIds = config.kind === "nuances" ? body.etat_ids : config.kind === "etats" ? body.nuance_ids : undefined;
      if (relationIds?.length) {
        const ownerColumn = config.kind === "nuances" ? "nuance_id" : "etat_id";
        const relatedColumn = config.kind === "nuances" ? "etat_id" : "nuance_id";
        for (const relatedId of [...new Set(relationIds)]) {
          await client.query(`INSERT INTO public.stock_nuance_etats (${ownerColumn},${relatedColumn}) VALUES ($1::bigint,$2::bigint)`, [row?.id, relatedId]);
        }
      }
    } else {
      const id = idSchema.parse(req.params.id);
      const exists = await client.query<Record<string, unknown>>(`SELECT to_jsonb(r) AS row FROM public.${config.table} r WHERE id=$1 FOR UPDATE`, [id]);
      if (!exists.rows[0]) { await client.query("ROLLBACK"); return null; }
      before = exists.rows[0].row;
      const updates: string[] = [];
      const values: unknown[] = [id];
      const push = (column: string, value: unknown) => { values.push(value); updates.push(`${column}=$${values.length}`); };
      if (config.kind === "nuances") {
        const previous = before as Record<string, unknown>;
        const merged = resolveNuanceIdentity(body, previous);
        if (body.code !== undefined && body.code !== previous.code && merged.designation_principale !== "LEGACY") throw new HttpError(400, "NUANCE_CODE_IMMUTABLE", "Le code technique d’une nuance classée est conservé.");
        if (nuanceNormeFields.some(key => body[key] !== undefined) || body.designation_principale !== undefined) {
          for (const key of nuanceNormeFields) push(key, merged[key]);
          push("designation_principale", merged.designation_principale);
        }
        if (body.code !== undefined && body.code !== previous.code) push("code", code);
      } else if (code !== undefined) push("code", code);
      if (designation !== undefined) push("designation", designation);
      if (config.kind === "sous-etats" && informations !== undefined) push("informations", informations);
      if (config.kind === "nuances" && densite !== undefined) push("densite", densite === null ? null : densite / 1000);
      if (config.kind === "etats" && body.unite_achat !== undefined) push("unite_achat", body.unite_achat);
      if (body.is_active !== undefined) push("is_active", body.is_active);
      updates.push("updated_at=now()");
      const result = await client.query<Record<string, unknown>>(`UPDATE public.${config.table} SET ${updates.join(",")} WHERE id=$1 RETURNING id::int AS id,code,designation,${config.kind === "sous-etats" ? "informations," : ""}is_active`, values);
      row = result.rows[0];
    }
    if (!row) throw new Error("Referential write returned no row");
    const audit = auditContext(req);
    await repoInsertAuditLog({ user_id: audit.user_id, body: { event_type: "ACTION", action: `stock.matiere-${config.kind}.${create ? "create" : "update"}`, page_key: config.pageKey, entity_type: config.table, entity_id: String(row.id), path: audit.path, client_session_id: audit.client_session_id, details: create ? { ...(identity ?? {}), code: row.code, ...(config.kind === "nuances" ? { etat_ids: body.etat_ids ?? [] } : config.kind === "etats" ? { nuance_ids: body.nuance_ids ?? [], unite_achat: body.unite_achat ?? 3020 } : { etat_id: body.etat_id ?? null }) } : { before, patch: raw } }, ip: audit.ip, user_agent: audit.user_agent, device_type: null, os: null, browser: null, tx: client });
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(error)) throw new DuplicateError();
    if (isPgForeignKeyViolation(error)) throw new ValidationError("A referenced relation does not exist");
    throw error;
  } finally { client.release(); }
}
class DuplicateError extends Error {}

function handlers(config: ReferentialConfig): RequestHandler[] {
  const write = (create: boolean): RequestHandler => async (req, res, next) => {
    try {
      const row = await mutate(config, req, create);
      if (!row) { sendError(res, 404, "NOT_FOUND", "Referential entry not found"); return; }
      const fresh = (await list(config)).find((item) => item.id === Number(row.id));
      res.status(create ? 201 : 200).json(fresh ?? apiRow(config, row));
    } catch (error) {
      if (error instanceof HttpError) { sendError(res, error.status, error.code, error.message); return; }
      if (error instanceof ValidationError || error instanceof ZodError) { sendError(res, 400, "VALIDATION_ERROR", error.message); return; }
      if (error instanceof DuplicateError) { sendError(res, 409, "DUPLICATE_REFERENTIAL_CODE", "Une nuance ou valeur possède déjà ce code ou cette désignation. Consultez aussi les entrées inactives."); return; }
      next(error);
    }
  };
  return [async (req, res, next) => { try { const items = await list(config, req.query); res.json({ items, total: items.length }); } catch (error) { if (error instanceof ValidationError) { sendError(res, 400, "VALIDATION_ERROR", error.message); return; } next(error); } }, write(true), write(false)];
}

export const materialReferentialsBackportRouter = Router();
materialReferentialsBackportRouter.use(authenticateToken);
materialReferentialsBackportRouter.get("/matiere-referential-capabilities", (_req, res) => res.json({ read: true, write: true }));
for (const config of Object.values(configs)) {
  const [get, post, patch] = handlers(config);
  const path = `/matiere-${config.kind}`;
  materialReferentialsBackportRouter.get(path, get);
  materialReferentialsBackportRouter.post(path, post);
  materialReferentialsBackportRouter.patch(`${path}/:id`, patch);
}

/** Append only the virtual narrow module to successful access-profile payloads. */
export const augmentMaterialReferentialsAccessProfile: RequestHandler = (req, res, next) => {
  if (req.method !== "GET" || req.path !== "/access-profile") return next();
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300 && body && typeof body === "object" && Array.isArray((body as { modules?: unknown }).modules)) {
      const profile = body as { modules: Array<Record<string, unknown>> };
      const virtual = profile.modules.find((module) => module.module_key === "matiere-referentiels");
      const grants = ["matiere-nuances", "matiere-etats", "matiere-sous-etats"];
      if (virtual) Object.assign(virtual, { allowed: true, nav_page_keys: grants });
      else profile.modules.push({ module_key: "matiere-referentiels", label: "Référentiels matière", allowed: true, nav_page_keys: grants });
    }
    return originalJson(body);
  }) as Response["json"];
  next();
};

export default materialReferentialsBackportRouter;
