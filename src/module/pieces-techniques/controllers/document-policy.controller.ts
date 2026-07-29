// src/module/pieces-techniques/controllers/document-policy.controller.ts
// Issue #227 — HTTP de la politique documentaire, du dossier de contrôle et des brouillons.
import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { CLIENT_DOCUMENT_POLICIES, CLIENT_DOCUMENT_POLICY_LABELS } from "../domain/document-policy";
import { describePieceTechniquePermissions } from "../pieces-techniques.permissions";
import {
  DraftInfrastructureMissing,
  repoAbandonDraft,
  repoCreateDraft,
  repoGetDraft,
  repoListDrafts,
  repoUpdateDraft,
} from "../repository/create-drafts.repository";
import type { AuditContext } from "../repository/pieces-techniques.repository";
import {
  buildPieceDocumentDossier,
  createDocumentTypeSVC,
  getClientDocumentPolicySVC,
  listDocumentTypesSVC,
  listFrozenRequirementsSVC,
  setClientDocumentPolicySVC,
  setPieceCritiqueSVC,
  updateDocumentTypeSVC,
} from "../services/document-policy.service";
import { renderPieceDocumentDossierPdf } from "../services/piece-document-dossier-pdf.service";
import {
  createDocumentTypeSchema,
  saveDraftSchema,
  setClientDocumentPolicySchema,
  setPieceCritiqueSchema,
  updateDocumentTypeSchema,
} from "../validators/document-policy.validators";

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

function requireUserId(req: Request): number {
  const id = req.user?.id;
  if (typeof id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return id;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", `Paramètre de route invalide : ${name}`);
  }
  return value;
}

/* ------------------------------ Référentiel ------------------------------ */

export const listDocumentTypes: RequestHandler = async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === "true" || req.query.include_inactive === "1";
    const items = await listDocumentTypesSVC(includeInactive);
    res.json({
      items,
      policies: CLIENT_DOCUMENT_POLICIES.map((value) => ({ value, label: CLIENT_DOCUMENT_POLICY_LABELS[value] })),
    });
  } catch (err) {
    next(err);
  }
};

export const createDocumentType: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body = createDocumentTypeSchema.parse({ body: req.body }).body;
    const created = await createDocumentTypeSVC(body, audit);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

export const updateDocumentType: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body = updateDocumentTypeSchema.parse({ body: req.body }).body;
    const updated = await updateDocumentTypeSVC(routeParam(req, "code"), body, audit);
    if (!updated) {
      res.status(404).json({ error: "Type de document introuvable" });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/* --------------------------- Politique client ---------------------------- */

export const getClientDocumentPolicy: RequestHandler = async (req, res, next) => {
  try {
    const record = await getClientDocumentPolicySVC(routeParam(req, "clientId"));
    if (!record) {
      res.status(404).json({ error: "Client introuvable" });
      return;
    }
    res.json({ ...record, policy_label: CLIENT_DOCUMENT_POLICY_LABELS[record.policy] });
  } catch (err) {
    next(err);
  }
};

export const setClientDocumentPolicy: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body = setClientDocumentPolicySchema.parse({ body: req.body }).body;
    const record = await setClientDocumentPolicySVC(
      routeParam(req, "clientId"),
      { policy: body.policy, selected_type_codes: body.selected_type_codes },
      audit
    );
    if (!record) {
      res.status(404).json({ error: "Client introuvable" });
      return;
    }
    res.json({ ...record, policy_label: CLIENT_DOCUMENT_POLICY_LABELS[record.policy] });
  } catch (err) {
    next(err);
  }
};

/* ---------------------- Dossier documentaire d'une pièce ------------------ */

export const getPieceDocumentDossier: RequestHandler = async (req, res, next) => {
  try {
    // La lecture des documents suit l'accès au module (gate #326, déjà appliqué en amont) :
    // arriver ici signifie que la lecture est permise. L'état FORBIDDEN reste modélisé pour
    // les intégrations qui construisent le dossier hors requête HTTP.
    const dossier = await buildPieceDocumentDossier({
      pieceTechniqueId: routeParam(req, "id"),
      canRead: true,
    });
    if (!dossier) {
      res.status(404).json({ error: "Pièce technique introuvable" });
      return;
    }
    res.json({ ...dossier, permissions: describePieceTechniquePermissions(req.user) });
  } catch (err) {
    next(err);
  }
};

export const downloadPieceDocumentDossierPdf: RequestHandler = async (req, res, next) => {
  try {
    const dossier = await buildPieceDocumentDossier({
      pieceTechniqueId: routeParam(req, "id"),
      canRead: true,
    });
    if (!dossier) {
      res.status(404).json({ error: "Pièce technique introuvable" });
      return;
    }
    const who = req.user?.username ?? req.user?.email ?? `utilisateur #${req.user?.id ?? "?"}`;
    const pdf = await renderPieceDocumentDossierPdf({ dossier, generatedBy: who });

    const safeCode = (dossier.piece.code_piece || "piece").replace(/[^A-Za-z0-9._-]+/g, "_");
    const indice = dossier.version.indice ? `_${dossier.version.indice.replace(/[^A-Za-z0-9]+/g, "")}` : "";
    const filename = `dossier-documentaire_${safeCode}${indice}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdf.length));
    // `inline` : l'impression se fait depuis le visualiseur, sans détour par le disque.
    res.setHeader(
      "Content-Disposition",
      `${req.query.download === "true" ? "attachment" : "inline"}; filename="${filename}"`
    );
    res.end(pdf);
  } catch (err) {
    next(err);
  }
};

export const setPieceCritique: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body = setPieceCritiqueSchema.parse({ body: req.body }).body;
    const updated = await setPieceCritiqueSVC(routeParam(req, "id"), body, audit);
    if (!updated) {
      res.status(404).json({ error: "Pièce technique introuvable" });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

export const listVersionFrozenRequirements: RequestHandler = async (req, res, next) => {
  try {
    const items = await listFrozenRequirementsSVC(routeParam(req, "versionId"));
    res.json({ items });
  } catch (err) {
    next(err);
  }
};

/* ------------------------------ Brouillons ------------------------------- */

function draftUnavailable(err: unknown): HttpError | null {
  return err instanceof DraftInfrastructureMissing
    ? new HttpError(
        503,
        "DRAFTS_UNAVAILABLE",
        "Les brouillons ne sont pas disponibles sur cette base : le référentiel n'est pas installé."
      )
    : null;
}

export const listPieceDrafts: RequestHandler = async (req, res, next) => {
  try {
    res.json({ items: await repoListDrafts(requireUserId(req)) });
  } catch (err) {
    next(draftUnavailable(err) ?? err);
  }
};

export const getPieceDraft: RequestHandler = async (req, res, next) => {
  try {
    const draft = await repoGetDraft(routeParam(req, "draftId"), requireUserId(req));
    if (!draft) {
      // 404 et non 403 : révéler l'existence du brouillon d'un autre compte serait déjà
      // une fuite. Le brouillon d'autrui est simplement inexistant pour cet utilisateur.
      res.status(404).json({ error: "Brouillon introuvable" });
      return;
    }
    res.json(draft);
  } catch (err) {
    next(draftUnavailable(err) ?? err);
  }
};

export const createPieceDraft: RequestHandler = async (req, res, next) => {
  try {
    const body = saveDraftSchema.parse({ body: req.body }).body;
    const draft = await repoCreateDraft(requireUserId(req), {
      title: body.title ?? null,
      payload: body.payload,
      current_step: body.current_step ?? null,
    });
    res.status(201).json(draft);
  } catch (err) {
    next(draftUnavailable(err) ?? err);
  }
};

export const updatePieceDraft: RequestHandler = async (req, res, next) => {
  try {
    const body = saveDraftSchema.parse({ body: req.body }).body;
    const draft = await repoUpdateDraft(routeParam(req, "draftId"), requireUserId(req), {
      title: body.title ?? null,
      payload: body.payload,
      current_step: body.current_step ?? null,
    });
    if (!draft) {
      res.status(404).json({ error: "Brouillon introuvable" });
      return;
    }
    res.json(draft);
  } catch (err) {
    next(draftUnavailable(err) ?? err);
  }
};

export const abandonPieceDraft: RequestHandler = async (req, res, next) => {
  try {
    const ok = await repoAbandonDraft(routeParam(req, "draftId"), requireUserId(req));
    if (!ok) {
      res.status(404).json({ error: "Brouillon introuvable" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(draftUnavailable(err) ?? err);
  }
};

/* ------------------------------ Capacités -------------------------------- */

export const getPieceTechniquePermissions: RequestHandler = (req, res) => {
  res.json(describePieceTechniquePermissions(req.user));
};
