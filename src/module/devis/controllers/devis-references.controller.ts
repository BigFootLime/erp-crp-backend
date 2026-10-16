import type { RequestHandler } from "express";
import { parseUuidRouteParam } from "../../../utils/routeParams";
import {
  getDevisClientReference,
  listDevisBillerReferences,
  listDevisClientAddresses,
  listDevisClientContacts,
  listDevisClientReferences,
  listDevisPaymentModeReferences,
  listDevisPieceTechniqueReferences,
} from "../services/devis-references.service";

function respond(operation: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    try {
      res.json(await operation(req));
    } catch (error) {
      next(error);
    }
  };
}

export const listDevisReferenceClients = respond((req) => listDevisClientReferences(req.query));
export const getDevisReferenceClient = respond((req) => getDevisClientReference(parseUuidRouteParam(req.params, "clientId")));
export const listDevisReferenceClientContacts = respond((req) => listDevisClientContacts(parseUuidRouteParam(req.params, "clientId")));
export const listDevisReferenceClientAddresses = respond((req) => listDevisClientAddresses(parseUuidRouteParam(req.params, "clientId")));
export const listDevisReferencePieceTechniques = respond((req) => listDevisPieceTechniqueReferences(req.query));
export const listDevisReferenceBillers = respond((req) => listDevisBillerReferences(req.query));
export const listDevisReferencePaymentModes = respond((req) => listDevisPaymentModeReferences(req.query));
