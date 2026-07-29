// GED centrale CERP (ADR-0037) — contrôleurs HTTP.

import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../../../utils/httpError";
import { gedRoleKeys } from "../domain/ged-policy";
import * as service from "../services/ged.service";
import type { GedAccessScope } from "../types/ged.types";
import {
  accessScopeQuerySchema,
  listQuerySchema,
  newVersionBodySchema,
  transitionBodySchema,
  uploadDocumentBodySchema,
  uuidParamSchema,
} from "../validators/ged.validators";

function actorFrom(req: Request): service.GedActor {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return { id: user.id, role_keys: gedRoleKeys(user) };
}

function parseUuid(value: unknown, label: string): string {
  const parsed = uuidParamSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_ERROR", `${label} invalide.`);
  }
  return parsed.data;
}

/**
 * Un multipart transporte tout en texte. Les champs sont donc reparsés ici,
 * jamais consommés bruts.
 */
function parseMultipartBody(req: Request) {
  const parsed = uploadDocumentBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "Champs invalides.", parsed.error.flatten());
  }
  return parsed.data;
}

function scopeFrom(value: {
  entity_type?: string | null;
  entity_id?: string | null;
}): GedAccessScope | null {
  return value.entity_type && value.entity_id
    ? { entity_type: value.entity_type, entity_id: value.entity_id }
    : null;
}

function parseAccessScope(req: Request): GedAccessScope | null {
  const parsed = accessScopeQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "Périmètre documentaire invalide.",
      parsed.error.flatten()
    );
  }
  return scopeFrom(parsed.data);
}

export async function getClasses(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.listClasses(actorFrom(req)) });
  } catch (err) {
    next(err);
  }
}

export async function getTree(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.getTree(actorFrom(req)) });
  } catch (err) {
    next(err);
  }
}

export async function getVaultStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.getVaultStatus(actorFrom(req)) });
  } catch (err) {
    next(err);
  }
}

export async function listDocuments(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Filtres invalides.", parsed.error.flatten());
    }
    const q = parsed.data;
    const result = await service.listDocuments(actorFrom(req), {
      q: q.q ?? null,
      class_key: q.class_key ?? null,
      domain: q.domain ?? null,
      status: q.status ?? null,
      entity_type: q.entity_type ?? null,
      entity_id: q.entity_id ?? null,
      include_archived: Boolean(q.include_archived),
      page: q.page,
      page_size: q.page_size,
    });
    res.json({ data: result.items, meta: { total: result.total, page: result.page, page_size: result.page_size } });
  } catch (err) {
    next(err);
  }
}

export async function getDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseUuid(req.params.id, "Identifiant de document");
    res.json({ data: await service.getDocument(actorFrom(req), id, parseAccessScope(req)) });
  } catch (err) {
    next(err);
  }
}

export async function getDocumentHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseUuid(req.params.id, "Identifiant de document");
    res.json({
      data: await service.listDocumentHistory(actorFrom(req), id, parseAccessScope(req)),
    });
  } catch (err) {
    next(err);
  }
}

export async function postDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseMultipartBody(req);
    const link =
      body.entity_type && body.entity_id
        ? { entity_type: body.entity_type, entity_id: body.entity_id, link_role: body.link_role ?? null }
        : null;

    const detail = await service.uploadDocument(
      actorFrom(req),
      {
        class_key: body.class_key,
        title: body.title,
        description: body.description ?? null,
        change_reason: body.change_reason ?? null,
        link,
      },
      req.file
    );
    res.status(201).json({ data: detail });
  } catch (err) {
    next(err);
  }
}

export async function postDocumentVersion(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseUuid(req.params.id, "Identifiant de document");
    const parsed = newVersionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Un motif de révision est requis.", parsed.error.flatten());
    }
    const detail = await service.uploadNewVersion(
      actorFrom(req),
      id,
      { change_reason: parsed.data.change_reason },
      req.file,
      scopeFrom(parsed.data)
    );
    res.status(201).json({ data: detail });
  } catch (err) {
    next(err);
  }
}

function transitionHandler(
  action: (
    actor: service.GedActor,
    versionId: string,
    comment: string | null,
    scope: GedAccessScope | null
  ) => Promise<unknown>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const versionId = parseUuid(req.params.versionId, "Identifiant de version");
      const parsed = transitionBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "Commentaire invalide.", parsed.error.flatten());
      }
      res.json({
        data: await action(
          actorFrom(req),
          versionId,
          parsed.data.comment ?? null,
          scopeFrom(parsed.data)
        ),
      });
    } catch (err) {
      next(err);
    }
  };
}

export const submitVersion = transitionHandler((a, v, c, s) => service.submitVersion(a, v, c, s));
export const approveVersion = transitionHandler((a, v, c, s) => service.approveVersion(a, v, c, s));
export const obsoleteVersion = transitionHandler((a, v, c, s) => service.obsoleteVersion(a, v, c, s));

export async function publishVersion(req: Request, res: Response, next: NextFunction) {
  try {
    const versionId = parseUuid(req.params.versionId, "Identifiant de version");
    const parsed = transitionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Périmètre documentaire invalide.",
        parsed.error.flatten()
      );
    }
    res.json({
      data: await service.publishVersion(actorFrom(req), versionId, scopeFrom(parsed.data)),
    });
  } catch (err) {
    next(err);
  }
}

export async function downloadVersion(req: Request, res: Response, next: NextFunction) {
  try {
    const versionId = parseUuid(req.params.versionId, "Identifiant de version");
    const result = await service.downloadVersion(
      actorFrom(req),
      versionId,
      parseAccessScope(req)
    );

    // `attachment` + `nosniff` : un document n'est jamais interprété par le
    // navigateur, quel que soit son type déclaré.
    res.setHeader("Content-Type", result.mime_type);
    res.setHeader("Content-Length", String(result.buffer.byteLength));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("X-CERP-Document-SHA256", result.sha256);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.original_name.replace(/"/g, "")}"`
    );
    res.send(result.buffer);
  } catch (err) {
    next(err);
  }
}
