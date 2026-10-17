import type { RequestHandler } from "express";
import { parseUuidRouteParam } from "../../../utils/routeParams";
import { crmClientIdSchema } from "../../client/validators/client-crm.validators";
import {
  getCommandeClientReference as getCommandeClientReferenceService,
  getCommandeClientContract as getCommandeClientContractService,
  getCommandeClientContractForecast as getCommandeClientContractForecastService,
  getCommandeReferenceArticle as getCommandeReferenceArticleService,
  getCommandeReferencePiece as getCommandeReferencePieceService,
  listCommandeClientContacts as listCommandeClientContactsService,
  listCommandeClientContracts as listCommandeClientContractsService,
  listCommandeClientContractCalls as listCommandeClientContractCallsService,
  listCommandeClientContractForecasts as listCommandeClientContractForecastsService,
  listCommandeClientReferences as listCommandeClientReferencesService,
  listCommandeReferenceArticleVersions as listCommandeReferenceArticleVersionsService,
  listCommandeReferenceArticles as listCommandeReferenceArticlesService,
  listCommandeReferenceEmplacements as listCommandeReferenceEmplacementsService,
  listCommandeReferenceMagasins as listCommandeReferenceMagasinsService,
  listCommandeReferencePieceVersions as listCommandeReferencePieceVersionsService,
} from "../services/commande-client-references.service";

function respond(operation: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => { try { res.json(await operation(req)); } catch (error) { next(error); } };
}
const clientId = (req: Parameters<RequestHandler>[0]) => crmClientIdSchema.parse(req.params.clientId);

export const listCommandeReferenceClients = respond((req) => listCommandeClientReferencesService(req.query));
export const getCommandeReferenceClient = respond((req) => getCommandeClientReferenceService(clientId(req)));
export const listCommandeReferenceClientContacts = respond((req) => listCommandeClientContactsService(clientId(req)));
export const listCommandeReferenceClientContracts = respond((req) => listCommandeClientContractsService(clientId(req), req.query));
export const getCommandeReferenceClientContract = respond((req) => getCommandeClientContractService(clientId(req), parseUuidRouteParam(req.params, "contractId"), req.query));
export const listCommandeReferenceClientContractCalls = respond((req) => listCommandeClientContractCallsService(clientId(req), parseUuidRouteParam(req.params, "contractId"), req.query));
export const listCommandeReferenceClientContractForecasts = respond((req) => listCommandeClientContractForecastsService(clientId(req), parseUuidRouteParam(req.params, "contractId"), req.query));
export const getCommandeReferenceClientContractForecast = respond((req) => getCommandeClientContractForecastService(clientId(req), parseUuidRouteParam(req.params, "contractId"), parseUuidRouteParam(req.params, "forecastId"), req.query));
export const getCommandeReferencePiece = respond((req) => getCommandeReferencePieceService(parseUuidRouteParam(req.params, "pieceId")));
export const listCommandeReferencePieceVersions = respond((req) => listCommandeReferencePieceVersionsService(parseUuidRouteParam(req.params, "pieceId")));
export const listCommandeReferenceArticleVersions = respond((req) => listCommandeReferenceArticleVersionsService(parseUuidRouteParam(req.params, "articleId"), req.query));
export const listCommandeReferenceArticles = respond((req) => listCommandeReferenceArticlesService(req.query));
export const getCommandeReferenceArticle = respond((req) => getCommandeReferenceArticleService(parseUuidRouteParam(req.params, "articleId")));
export const listCommandeReferenceMagasins = respond((req) => listCommandeReferenceMagasinsService(req.query));
export const listCommandeReferenceEmplacements = respond((req) => listCommandeReferenceEmplacementsService(req.query));
