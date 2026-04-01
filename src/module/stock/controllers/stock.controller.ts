import type { Request, RequestHandler, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";

import { HttpError } from "../../../utils/httpError";
import {
  createInventorySessionSchema,
  createArticleSchema,
  createArticleFamilySchema,
  createMatiereEtatSchema,
  createMatiereNuanceSchema,
  createMatiereSousEtatSchema,
  createEmplacementSchema,
  createLotSchema,
  createMagasinSchema,
  createMovementSchema,
  docIdParamSchema,
  emplacementIdParamSchema,
  idParamSchema,
  listAnalyticsQuerySchema,
  listInventorySessionsQuerySchema,
  listArticlesQuerySchema,
  listArticleFamiliesQuerySchema,
  listMatiereEtatsQuerySchema,
  listMatiereNuancesQuerySchema,
  listMatiereSousEtatsQuerySchema,
  listBalancesQuerySchema,
  listEmplacementsQuerySchema,
  listLotsQuerySchema,
  listMagasinsQuerySchema,
  listMovementsQuerySchema,
  magasinIdParamSchema,
  upsertInventoryLineSchema,
  updateArticleSchema,
  updateEmplacementSchema,
  updateLotSchema,
  updateMagasinSchema,
  type CreateInventorySessionBodyDTO,
  type CreateArticleBodyDTO,
  type CreateArticleFamilyBodyDTO,
  type CreateMatiereEtatBodyDTO,
  type CreateMatiereNuanceBodyDTO,
  type CreateMatiereSousEtatBodyDTO,
  type CreateEmplacementBodyDTO,
  type CreateLotBodyDTO,
  type CreateMagasinBodyDTO,
  type CreateMovementBodyDTO,
  type ListAnalyticsQueryDTO,
  type ListBalancesQueryDTO,
  type ListMatiereEtatsQueryDTO,
  type ListMatiereNuancesQueryDTO,
  type ListMatiereSousEtatsQueryDTO,
  type UpdateArticleBodyDTO,
  type UpdateEmplacementBodyDTO,
  type UpdateLotBodyDTO,
  type UpdateMagasinBodyDTO,
  type UpsertInventoryLineBodyDTO,
} from "../validators/stock.validators";
import type { AuditContext } from "../repository/stock.repository";
import {
  closeStockInventorySessionSVC,
  createStockInventorySessionSVC,
  createStockArticleFamilySVC,
  getStockInventorySessionSVC,
  getStockAnalyticsSVC,
  listStockInventorySessionLinesSVC,
  listStockInventorySessionsSVC,
  upsertStockInventorySessionLineSVC,
  attachStockArticleDocumentsSVC,
  attachStockMovementDocumentsSVC,
  cancelStockMovementSVC,
  createStockArticleSVC,
  createStockEmplacementSVC,
  createStockLotSVC,
  createStockMagasinSVC,
  createStockMovementSVC,
  getStockArticleDocumentForDownloadSVC,
  getStockArticleSVC,
  getStockArticlesKpisSVC,
  listStockArticleCategoriesSVC,
  listStockArticleFamiliesSVC,
  listStockMatiereEtatsSVC,
  listStockMatiereNuancesSVC,
  listStockMatiereSousEtatsSVC,
  getStockLotSVC,
  getStockMagasinSVC,
  getStockMagasinsKpisSVC,
  getStockMovementDocumentForDownloadSVC,
  getStockMovementSVC,
  listStockArticleDocumentsSVC,
  listStockArticlesSVC,
  listStockBalancesSVC,
  listStockEmplacementsSVC,
  listStockLotsSVC,
  listStockMagasinsSVC,
  listStockMovementDocumentsSVC,
  listStockMovementsSVC,
  postStockMovementSVC,
  removeStockArticleDocumentSVC,
  removeStockMovementDocumentSVC,
  updateStockArticleSVC,
  updateStockEmplacementSVC,
  updateStockLotSVC,
  updateStockMagasinSVC,
  deactivateStockMagasinSVC,
  activateStockMagasinSVC,
  createStockMatiereEtatSVC,
  createStockMatiereNuanceSVC,
  createStockMatiereSousEtatSVC,
} from "../services/stock.service";

export const listStockInventorySessions: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listInventorySessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockInventorySessionsSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockInventorySession: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateInventorySessionBodyDTO = createInventorySessionSchema.parse({ body: req.body }).body;
    const out = await createStockInventorySessionSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockInventorySession: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await getStockInventorySessionSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockInventorySessionLines: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await listStockInventorySessionLinesSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ items: out, total: out.length });
  } catch (err) {
    next(err);
  }
};

export const upsertStockInventorySessionLine: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const body: UpsertInventoryLineBodyDTO = upsertInventoryLineSchema.parse({ body: req.body }).body;
    const out = await upsertStockInventorySessionLineSVC(id, body, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const closeStockInventorySession: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await closeStockInventorySessionSVC(id, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

function isMulterFile(value: unknown): value is Express.Multer.File {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { path?: unknown; originalname?: unknown; mimetype?: unknown; size?: unknown };
  return typeof v.path === "string" && typeof v.originalname === "string" && typeof v.mimetype === "string" && typeof v.size === "number";
}

function getMulterFiles(req: Request): Express.Multer.File[] {
  const files = (req as Request & { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files.filter(isMulterFile);
}

async function sendDocumentFile(
  req: Request,
  res: Response,
  doc: { storage_path: string; mime_type: string; original_name: string }
) {
  const baseDir = path.resolve(path.posix.join("uploads", "docs", "stock"));
  const absPath = path.resolve(doc.storage_path);
  const basePrefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
  if (!absPath.startsWith(basePrefix)) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Invalid document storage path");
  }

  await fs.access(absPath);
  res.setHeader("Content-Type", doc.mime_type);

  const rawDownload = (req.query as { download?: unknown } | undefined)?.download;
  const download = rawDownload === true || rawDownload === "true" || rawDownload === "1" || rawDownload === 1;
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(doc.original_name)}"`
  );
  res.sendFile(absPath);
}

export const listStockArticles: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listArticlesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockArticlesSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockArticleCategories: RequestHandler = async (_req, res, next) => {
  try {
    const out = await listStockArticleCategoriesSVC();
    res.json({ items: out, total: out.length });
  } catch (err) {
    next(err);
  }
};

export const listStockArticleFamilies: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listArticleFamiliesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockArticleFamiliesSVC(parsed.data);
    res.json({ items: out, total: out.length });
  } catch (err) {
    next(err);
  }
};

export const listStockMatiereNuances: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listMatiereNuancesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockMatiereNuancesSVC(parsed.data as ListMatiereNuancesQueryDTO);
    res.json({ items: out, total: out.length });
  } catch (err) {
    next(err);
  }
};

export const createStockMatiereNuance: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateMatiereNuanceBodyDTO = createMatiereNuanceSchema.parse({ body: req.body }).body;
    const out = await createStockMatiereNuanceSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockMatiereEtats: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listMatiereEtatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockMatiereEtatsSVC(parsed.data as ListMatiereEtatsQueryDTO);
    res.json({ items: out, total: out.length });
  } catch (err) {
    next(err);
  }
};

export const createStockMatiereEtat: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateMatiereEtatBodyDTO = createMatiereEtatSchema.parse({ body: req.body }).body;
    const out = await createStockMatiereEtatSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockMatiereSousEtats: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listMatiereSousEtatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockMatiereSousEtatsSVC(parsed.data as ListMatiereSousEtatsQueryDTO);
    res.json({ items: out, total: out.length });
  } catch (err) {
    next(err);
  }
};

export const createStockMatiereSousEtat: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateMatiereSousEtatBodyDTO = createMatiereSousEtatSchema.parse({ body: req.body }).body;
    const out = await createStockMatiereSousEtatSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockArticleFamily: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateArticleFamilyBodyDTO = createArticleFamilySchema.parse({ body: req.body }).body;
    const out = await createStockArticleFamilySVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const filters: ListAnalyticsQueryDTO = listAnalyticsQuerySchema.parse(req.query);
    const out = await getStockAnalyticsSVC(filters);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockArticlesKpis: RequestHandler = async (_req, res, next) => {
  try {
    const out = await getStockArticlesKpisSVC();
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockArticle: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await getStockArticleSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockArticle: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateArticleBodyDTO = createArticleSchema.parse({ body: req.body }).body;
    const out = await createStockArticleSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateStockArticle: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const body: UpdateArticleBodyDTO = updateArticleSchema.parse({ body: req.body }).body;
    const out = await updateStockArticleSVC(id, body, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockMagasins: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listMagasinsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockMagasinsSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockMagasinsKpis: RequestHandler = async (_req, res, next) => {
  try {
    const out = await getStockMagasinsKpisSVC();
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockMagasin: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await getStockMagasinSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockMagasin: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateMagasinBodyDTO = createMagasinSchema.parse({ body: req.body }).body;
    const out = await createStockMagasinSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateStockMagasin: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const body: UpdateMagasinBodyDTO = updateMagasinSchema.parse({ body: req.body }).body;
    const out = await updateStockMagasinSVC(id, body, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const deactivateStockMagasin: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await deactivateStockMagasinSVC(id, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const activateStockMagasin: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await activateStockMagasinSVC(id, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockEmplacements: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listEmplacementsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockEmplacementsSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockEmplacement: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { magasinId } = magasinIdParamSchema.parse({ params: req.params }).params;
    const body: CreateEmplacementBodyDTO = createEmplacementSchema.parse({ body: req.body }).body;
    const out = await createStockEmplacementSVC(magasinId, body, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateStockEmplacement: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = emplacementIdParamSchema.parse({ params: req.params }).params;
    const body: UpdateEmplacementBodyDTO = updateEmplacementSchema.parse({ body: req.body }).body;
    const out = await updateStockEmplacementSVC(id, body, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockLots: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listLotsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockLotsSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockLot: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await getStockLotSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockLot: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateLotBodyDTO = createLotSchema.parse({ body: req.body }).body;
    const out = await createStockLotSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateStockLot: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const body: UpdateLotBodyDTO = updateLotSchema.parse({ body: req.body }).body;
    const out = await updateStockLotSVC(id, body, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockBalances: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listBalancesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const filters: ListBalancesQueryDTO = parsed.data;
    const out = await listStockBalancesSVC(filters);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockMovements: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listMovementsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listStockMovementsSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getStockMovement: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await getStockMovementSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createStockMovement: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body: CreateMovementBodyDTO = createMovementSchema.parse({ body: req.body }).body;
    const out = await createStockMovementSVC(body, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const postStockMovement: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await postStockMovementSVC(id, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const cancelStockMovement: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await cancelStockMovementSVC(id, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const listStockArticleDocuments: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await listStockArticleDocumentsSVC(id);
    if (out === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const attachStockArticleDocuments: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const files = getMulterFiles(req);
    const out = await attachStockArticleDocumentsSVC(id, files, audit);
    if (out === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const removeStockArticleDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params;
    const out = await removeStockArticleDocumentSVC(id, docId, audit);
    if (out === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const downloadStockArticleDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params;
    const doc = await getStockArticleDocumentForDownloadSVC(id, docId, audit);
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await sendDocumentFile(req, res, doc);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      next(new HttpError(404, "FILE_NOT_FOUND", "File not found"));
      return;
    }
    next(err);
  }
};

export const listStockMovementDocuments: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await listStockMovementDocumentsSVC(id);
    if (out === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const attachStockMovementDocuments: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const files = getMulterFiles(req);
    const out = await attachStockMovementDocumentsSVC(id, files, audit);
    if (out === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const removeStockMovementDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params;
    const out = await removeStockMovementDocumentSVC(id, docId, audit);
    if (out === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const downloadStockMovementDocument: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id, docId } = docIdParamSchema.parse({ params: req.params }).params;
    const doc = await getStockMovementDocumentForDownloadSVC(id, docId, audit);
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await sendDocumentFile(req, res, doc);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      next(new HttpError(404, "FILE_NOT_FOUND", "File not found"));
      return;
    }
    next(err);
  }
};
