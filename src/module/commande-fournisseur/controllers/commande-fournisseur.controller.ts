import type { Request, RequestHandler } from "express";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";

import { HttpError } from "../../../utils/httpError";
import { roleHasCommandeFournisseurCapability } from "../domain/commande-fournisseur-rbac";
import type { AuditContext } from "../repository/commande-fournisseur.repository";
import {
  accuseSchema,
  addLigneSchema,
  commandeIdParamSchema,
  createCommandeSchema,
  deleteLigneSchema,
  documentIdParamSchema,
  duplicateSchema,
  generateDocumentSchema,
  ligneIdParamSchema,
  officialDocumentIdParamSchema,
  officialDocumentRequestSchema,
  listCommandesQuerySchema,
  propositionsConfirmSchema,
  propositionsPreviewSchema,
  reorderLignesSchema,
  simulateTotauxSchema,
  transitionSchema,
  updateCommandeSchema,
  updateLigneSchema,
} from "../validators/commande-fournisseur.validators";
import {
  accuseReceptionSVC,
  addLigneSVC,
  confirmPropositionsSVC,
  createCommandeFournisseurSVC,
  deleteLigneSVC,
  duplicateAsDraftSVC,
  generateDocumentSVC,
  getCommandeFournisseurKpisSVC,
  getCommandeFournisseurSVC,
  getDocumentSVC,
  listCommandesFournisseursSVC,
  previewPropositionsSVC,
  reorderLignesSVC,
  resyncReceptionsSVC,
  simulateTotauxSVC,
  transitionCommandeFournisseurSVC,
  updateCommandeFournisseurSVC,
  updateLigneSVC,
  getSupplierPoOfficialDocumentSVC,
  listSupplierPoOfficialDocumentsSVC,
  queueSupplierPoOfficialDocumentSVC,
  readSupplierPoOfficialDocumentSVC,
  recordSupplierPoOfficialPrintSVC,
} from "../services/commande-fournisseur.service";

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
    role: user.role ?? null,
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

function includePricesFor(req: Request): boolean {
  return (
    requestHasGrantedAccountModuleAccess(req) ||
    roleHasCommandeFournisseurCapability(req.user?.role, "prices")
  );
}

/** Clé d'idempotence : header standard prioritaire, sinon champ body. */
function idempotencyKeyFrom(req: Request, bodyKey?: string): string | undefined {
  const header = req.headers["idempotency-key"];
  if (typeof header === "string" && header.trim().length >= 8) return header.trim().slice(0, 120);
  return bodyKey;
}

export const listCommandesFournisseurs: RequestHandler = async (req, res, next) => {
  try {
    const { query } = listCommandesQuerySchema.parse({ query: req.query });
    const out = await listCommandesFournisseursSVC(query, includePricesFor(req));
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getCommandeFournisseurKpis: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await getCommandeFournisseurKpisSVC());
  } catch (err) {
    next(err);
  }
};

export const getCommandeFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const out = await getCommandeFournisseurSVC(params.id, includePricesFor(req));
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createCommandeFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const { body } = createCommandeSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    const out = await createCommandeFournisseurSVC(
      { ...body, idempotency_key: idempotencyKeyFrom(req, body.idempotency_key) },
      audit
    );
    res.status(out.idempotent_replay ? 200 : 201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateCommandeFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const { body } = updateCommandeSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    await updateCommandeFournisseurSVC(params.id, body, audit);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const addLigne: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const { body } = addLigneSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    res.status(201).json(await addLigneSVC(params.id, body, audit));
  } catch (err) {
    next(err);
  }
};

export const updateLigne: RequestHandler = async (req, res, next) => {
  try {
    const { params } = ligneIdParamSchema.parse({ params: req.params });
    const { body } = updateLigneSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    await updateLigneSVC(params.id, params.ligneId, body, audit);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const deleteLigne: RequestHandler = async (req, res, next) => {
  try {
    const { params } = ligneIdParamSchema.parse({ params: req.params });
    const parsed = deleteLigneSchema.parse({ body: req.body ?? {} });
    const audit = buildAuditContext(req);
    await deleteLigneSVC(params.id, params.ligneId, parsed.body?.expected_updated_at, audit);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const reorderLignes: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const { body } = reorderLignesSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    res.json(await reorderLignesSVC(params.id, body, audit));
  } catch (err) {
    next(err);
  }
};

export const transitionCommandeFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const { body } = transitionSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    res.json(
      await transitionCommandeFournisseurSVC(
        params.id,
        { ...body, idempotency_key: idempotencyKeyFrom(req, body.idempotency_key) },
        audit
      )
    );
  } catch (err) {
    next(err);
  }
};

export const accuseReception: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const { body } = accuseSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    res.json(await accuseReceptionSVC(params.id, body, audit));
  } catch (err) {
    next(err);
  }
};

export const generateDocument: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const parsed = generateDocumentSchema.parse({ body: req.body ?? {} });
    const audit = buildAuditContext(req);
    res
      .status(201)
      .json(await generateDocumentSVC(params.id, parsed.body?.motif_revision, parsed.body?.expected_updated_at, audit));
  } catch (err) {
    next(err);
  }
};

export const getDocument: RequestHandler = async (req, res, next) => {
  try {
    const { params } = documentIdParamSchema.parse({ params: req.params });
    res.json(await getDocumentSVC(params.id, params.documentId));
  } catch (err) {
    next(err);
  }
};

export const listOfficialDocuments: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    res.json(await listSupplierPoOfficialDocumentsSVC(params.id));
  } catch (err) { next(err); }
};

export const queueOfficialDocument: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const { body } = officialDocumentRequestSchema.parse({ body: req.body ?? {} });
    const key = idempotencyKeyFrom(req);
    if (!key) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une clé d'idempotence est requise.");
    const audit = buildAuditContext(req);
    const result = await queueSupplierPoOfficialDocumentSVC(params.id, key, audit, body);
    res.status(201).json(result);
  } catch (err) { next(err); }
};

export const getOfficialDocument: RequestHandler = async (req, res, next) => {
  try {
    const { params } = officialDocumentIdParamSchema.parse({ params: req.params });
    const result = await getSupplierPoOfficialDocumentSVC(params.id, params.documentId);
    if (!result) throw new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable.");
    res.json(result);
  } catch (err) { next(err); }
};

function sendOfficialPdf(disposition: "inline" | "attachment"): RequestHandler {
  return async (req, res, next) => {
    try {
      const { params } = officialDocumentIdParamSchema.parse({ params: req.params });
      const actorId = buildAuditContext(req).user_id;
      const file = await readSupplierPoOfficialDocumentSVC(
        params.id, params.documentId, actorId,
        disposition === "inline" ? "AUTHORITATIVE_PDF_PREVIEWED" : "AUTHORITATIVE_PDF_DOWNLOADED"
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(file.bytes.byteLength));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Disposition", `${disposition}; filename="${file.filename}"`);
      res.send(file.bytes);
    } catch (err) { next(err); }
  };
}

export const previewOfficialDocument = sendOfficialPdf("inline");
export const downloadOfficialDocument = sendOfficialPdf("attachment");

export const printOfficialDocument: RequestHandler = async (req, res, next) => {
  try {
    const { params } = officialDocumentIdParamSchema.parse({ params: req.params });
    await recordSupplierPoOfficialPrintSVC(params.id, params.documentId, buildAuditContext(req).user_id);
    res.status(204).send();
  } catch (err) { next(err); }
};

export const simulateTotaux: RequestHandler = async (req, res, next) => {
  try {
    const { body } = simulateTotauxSchema.parse({ body: req.body });
    res.json(simulateTotauxSVC(body));
  } catch (err) {
    next(err);
  }
};

export const previewPropositions: RequestHandler = async (req, res, next) => {
  try {
    const { body } = propositionsPreviewSchema.parse({ body: req.body });
    res.json(await previewPropositionsSVC(body));
  } catch (err) {
    next(err);
  }
};

export const confirmPropositions: RequestHandler = async (req, res, next) => {
  try {
    const { body } = propositionsConfirmSchema.parse({ body: req.body });
    const audit = buildAuditContext(req);
    const key = idempotencyKeyFrom(req, body.idempotency_key);
    if (!key) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une clé d'idempotence est requise.");
    res.status(201).json(await confirmPropositionsSVC({ ...body, idempotency_key: key }, audit));
  } catch (err) {
    next(err);
  }
};

export const resyncReceptions: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const audit = buildAuditContext(req);
    const allowOver =
      requestHasGrantedAccountModuleAccess(req) ||
      roleHasCommandeFournisseurCapability(req.user?.role, "over_receipt");
    res.json(await resyncReceptionsSVC(params.id, audit, allowOver));
  } catch (err) {
    next(err);
  }
};

export const duplicateCommandeFournisseur: RequestHandler = async (req, res, next) => {
  try {
    const { params } = commandeIdParamSchema.parse({ params: req.params });
    const parsed = duplicateSchema.parse({ body: req.body ?? {} });
    const audit = buildAuditContext(req);
    res.status(201).json(await duplicateAsDraftSVC(params.id, parsed.body?.note, audit));
  } catch (err) {
    next(err);
  }
};
