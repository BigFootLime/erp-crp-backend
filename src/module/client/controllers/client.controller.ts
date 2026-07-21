// src/module/client/controllers/client.controller.ts
import { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { stripQueryFromUrl } from "../../../utils/logPath";

import * as clientService from "../services/client.service"; // ✅ namespace import
import { svcGetClientById, svcListClientAddresses } from "../services/clients.read.service";
import {
  createClientSchema,
  createClientContactBodySchema,
  clientPatchSchema,
  duplicateCheckSchema,
  setPrimaryContactSchema,
} from "../validators/client.validators";
import {
  type AuditContext,
  repoArchiveClient,
  repoCheckDuplicates,
  repoCreateClient,
  repoCreateClientContact,
  repoDeleteClient,
  repoPatchClient,
  repoSetPrimaryContact,
} from "../repository/client.repository";
import { canViewClientFinance } from "../client.permissions";

// Upload logo désactivé (CA-APP-05) : la route et ce handler restent commentés
// tant qu'un upload sécurisé (auth + RBAC + sniffing MIME + taille max + nom
// serveur) n'est pas spécifié. Réactiver imposera de réimporter node:path,
// LOGO_BASE_DIR et updateClientLogoPath.
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
//     const absolutePath = file.path;
//     let relativePath = path.relative(LOGO_BASE_DIR, absolutePath);
//     relativePath = relativePath.replace(/\\/g, "/");
//     await updateClientLogoPath(clientId, relativePath);
//     return res.status(200).json({ client_id: clientId, logo_path: relativePath });
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
    // Sans query string : les recherches mettent des PII en query (?q=email),
    // le contexte d'audit n'a besoin que du chemin + page_key.
    path: stripQueryFromUrl(req.originalUrl),
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value === "string" && value.length > 0) return value;
  throw new HttpError(400, "INVALID_ROUTE_PARAM", `${name} must be a string`);
}

/**
 * Le code visible est généré côté serveur et immuable (ADR-0013). Toute valeur
 * non vide fournie par le client est rejetée explicitement — aucune ambiguïté,
 * pas d'écrasement silencieux. Les chaînes vides des anciens payloads restent
 * tolérées (elles signifiaient déjà « laisse le serveur générer »).
 */
function rejectClientCodeInBody(body: unknown, code: string, message: string) {
  if (!body || typeof body !== "object") return;
  const value = (body as Record<string, unknown>).client_code;
  if (typeof value === "string" && value.trim() === "") return;
  if (value === undefined || value === null) return;
  throw new HttpError(400, code, message);
}

export const getClientById: RequestHandler = async (req, res, next) => {
  try {
    const includeSensitiveFinance = canViewClientFinance(req.user?.role);
    const row = await svcGetClientById(routeParam(req, "id"), { includeSensitiveFinance });
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
    const clientId = routeParam(req, "clientId");
    const rows = await clientService.listClientContacts(clientId, {
      includePersonalPhone: canViewClientFinance(req.user?.role),
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
};

export const postClientContact: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const clientId = routeParam(req, "clientId");
    const dto = createClientContactBodySchema.parse(req.body);
    const created = await repoCreateClientContact(clientId, dto, audit);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
};

export const listClientAddresses: RequestHandler = async (req, res, next) => {
  try {
    const clientId = routeParam(req, "clientId");
    const rows = await svcListClientAddresses(clientId);
    res.json(rows);
  } catch (e) {
    next(e);
  }
};

const uuidHeaderRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const postClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    rejectClientCodeInBody(
      req.body,
      "CLIENT_CODE_READONLY",
      "Le code client est généré automatiquement par le serveur."
    );

    // Rejeu sûr (double clic / retry réseau) : même clé -> même fiche, 200.
    const idempotencyHeader = req.headers["idempotency-key"];
    const idempotencyKey = typeof idempotencyHeader === "string" ? idempotencyHeader.trim() : "";
    if (idempotencyKey && !uuidHeaderRe.test(idempotencyKey)) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key doit être un UUID.");
    }

    const dto = createClientSchema.parse(req.body);
    const { replayed, ...created } = await repoCreateClient(dto, audit, idempotencyKey || null);
    res.status(replayed ? 200 : 201).json(created); // { client_id, client_code }
  } catch (e) {
    next(e);
  }
};

export const checkClientDuplicates: RequestHandler = async (req, res, next) => {
  try {
    const criteria = duplicateCheckSchema.parse(req.body);
    const candidates = await repoCheckDuplicates(criteria);
    res.json({ candidates });
  } catch (e) {
    next(e);
  }
};

export const patchClientPrimaryContact: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const clientId = routeParam(req, "id");
    const { contact_id } = setPrimaryContactSchema.parse(req.body);
    // Appartenance au client + affectation + audit sous une même transaction.
    await repoSetPrimaryContact(clientId, contact_id, audit);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const patchClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const id = routeParam(req, "id");

    rejectClientCodeInBody(
      req.body,
      "CLIENT_CODE_IMMUTABLE",
      "Le code client est immuable : il ne peut pas être modifié."
    );

    // Vrai PATCH partiel : on valide avec un schéma partiel (validateurs par champ préservés),
    // puis on ne conserve que les champs RÉELLEMENT présents dans le body (les .default() du
    // schéma réinjectent des tableaux vides qu'il ne faut pas appliquer -> risque d'écrasement).
    const provided = new Set(Object.keys((req.body ?? {}) as Record<string, unknown>));
    const dto = clientPatchSchema.parse(req.body);
    const fields = new Set([...provided].filter((k) => k in dto));

    if (fields.size === 0) {
      throw new HttpError(400, "EMPTY_PATCH", "Aucun champ à mettre à jour");
    }

    await repoPatchClient(id, dto, fields, audit);

    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const deleteClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const id = routeParam(req, "id");

    // Archivage logique — aucune suppression physique (voir repoDeleteClient).
    await repoDeleteClient(id, audit);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const archiveClient: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const id = routeParam(req, "id");

    await repoArchiveClient(id, audit);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};
