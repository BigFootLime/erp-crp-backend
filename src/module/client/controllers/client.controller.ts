// src/module/client/controllers/client.controller.ts
import { Request, RequestHandler, Response } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

import * as clientService from "../services/client.service"; // ✅ namespace import
import { svcGetClientById, svcListClientAddresses } from "../services/clients.read.service";
import { createClientSchema } from "../validators/client.validators";
import { type AuditContext, repoArchiveClient, repoCreateClient, repoDeleteClient, repoUpdateClient } from "../repository/client.repository";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import path from "node:path";
// import { LOGO_BASE_DIR } from "../upload/client-logo-upload";
import { updateClientLogoPath } from "../services/client.service";


// export const uploadClientLogo: RequestHandler = async (req, res, next) => {
//   try {
//     const clientId = req.params.id;

//     if (!clientId) {
//       return res.status(400).json({ message: "client_id manquant dans l'URL" });
//     }

//     const file = (req as any).file as Express.Multer.File | undefined;

//     if (!file) {
//       return res.status(400).json({ message: "Aucun fichier 'logo' reçu" });
//     }

//     // chemin absolu sur le VPS (ex: /mnt/crp/CLIENTS/005/LOGOS/005_111225_LOGO.png)
//     const absolutePath = file.path;

//     // ➜ chemin relatif par rapport à LOGO_BASE_DIR (CLIENTS)
//     // Exemple: "005/LOGOS/005_111225_LOGO.png"
//     let relativePath = path.relative(LOGO_BASE_DIR, absolutePath);

//     // normalisation pour éviter les "\" en DB
//     relativePath = relativePath.replace(/\\/g, "/");

//     // update BDD
//     await updateClientLogoPath(clientId, relativePath);

//     return res.status(200).json({
//       client_id: clientId,
//       logo_path: relativePath, // ce qui est stocké en DB
//     });
//   } catch (e) {
//     next(e);
//   }
// };


function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }

  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const ip = getClientIp(req);
  const device = parseDevice(userAgent);

  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip,
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

export const getClientById: RequestHandler = async (req, res, next) => {
  try {
    const row = await svcGetClientById(req.params.id);
    if (!row) {
      res.status(404).json({ message: "Client not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    next(e);
  }
};

export const listClients: RequestHandler = async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";

    const limitCandidateRaw =
      typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : typeof req.query.limit === "number"
          ? req.query.limit
          : NaN;

    const limitCandidate = Number.isFinite(limitCandidateRaw) ? limitCandidateRaw : 25;
    const limit = Math.min(Math.max(limitCandidate, 1), 100);

    const rows = await clientService.listClients(q, limit);
    res.json(rows);
  } catch (e) {
    next(e);
  }
};

export const listClientContacts: RequestHandler = async (req, res, next) => {
  try {
    const clientId = req.params.clientId;
    const rows = await clientService.listClientContacts(clientId);
    res.json(rows);
  } catch (e) {
    next(e);
  }
};

export const listClientAddresses: RequestHandler = async (req, res, next) => {
  try {
    const clientId = req.params.clientId;
    const rows = await svcListClientAddresses(clientId);
    res.json(rows);
  } catch (e) {
    next(e);
  }
};

export const postClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const dto = createClientSchema.parse(req.body);
    const created = await repoCreateClient(dto, audit);
    res.status(201).json(created); // { client_id }
  } catch (e) {
    next(e);
  }
};

export const patchClientPrimaryContact: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const clientId = req.params.id;
    const { contact_id } = req.body as { contact_id: string };
    await clientService.updateClientPrimaryContact(clientId, contact_id);

    await repoInsertAuditLog({
      user_id: audit.user_id,
      body: {
        event_type: "ACTION",
        action: "CLIENT_PRIMARY_CONTACT_SET",
        page_key: audit.page_key,
        entity_type: "client",
        entity_id: clientId,
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: { contact_id },
      },
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
    });

    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const patchClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const id = req.params.id;

    // on réutilise le même schéma que pour la création
    const dto = createClientSchema.parse(req.body);

    await repoUpdateClient(id, dto, audit);

    // pas besoin de body, le frontend n'en attend pas
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const deleteClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const id = req.params.id;
    if (!id) throw new HttpError(400, "CLIENT_ID_REQUIRED", "client_id is required");

    await repoDeleteClient(id, audit);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const archiveClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const id = req.params.id;
    if (!id) throw new HttpError(400, "CLIENT_ID_REQUIRED", "client_id is required");

    await repoArchiveClient(id, audit);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

