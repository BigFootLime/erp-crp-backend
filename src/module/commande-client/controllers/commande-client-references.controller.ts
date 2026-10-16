import type { RequestHandler } from "express";
import { parseUuidRouteParam } from "../../../utils/routeParams";
import {
  getCommandeClientReference,
  getCommandeReferencePiece as getCommandeReferencePieceService,
  listCommandeClientContacts,
  listCommandeClientContracts,
  listCommandeClientReferences,
  listCommandeReferenceArticleVersions as listCommandeReferenceArticleVersionsService,
} from "../services/commande-client-references.service";

function respond(operation: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    try {
      res.json(await operation(req));
    } catch (error) {
      next(error);
    }
  };
}

export const listCommandeReferenceClients = respond((req) => listCommandeClientReferences(req.query));
export const getCommandeReferenceClient = respond((req) => getCommandeClientReference(parseUuidRouteParam(req.params, "clientId")));
export const listCommandeReferenceClientContacts = respond((req) => listCommandeClientContacts(parseUuidRouteParam(req.params, "clientId")));
export const listCommandeReferenceClientContracts = respond((req) => listCommandeClientContracts(parseUuidRouteParam(req.params, "clientId"), req.query));
export const getCommandeReferencePiece = respond((req) => getCommandeReferencePieceService(parseUuidRouteParam(req.params, "pieceId")));
export const listCommandeReferenceArticleVersions = respond((req) => listCommandeReferenceArticleVersionsService(parseUuidRouteParam(req.params, "articleId"), req.query));