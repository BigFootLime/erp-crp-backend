import type { RequestHandler } from "express";
import { crmClientIdSchema } from "../../client/validators/client-crm.validators";
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
const clientId = (req: Parameters<RequestHandler>[0]) => crmClientIdSchema.parse(req.params.clientId);

export const getDevisReferenceClient = respond((req) => getDevisClientReference(clientId(req)));
export const listDevisReferenceClientContacts = respond((req) => listDevisClientContacts(clientId(req)));
export const listDevisReferenceClientAddresses = respond((req) => listDevisClientAddresses(clientId(req)));
export const listDevisReferencePieceTechniques = respond((req) => listDevisPieceTechniqueReferences(req.query));
export const listDevisReferenceBillers = respond((req) => listDevisBillerReferences(req.query));
export const listDevisReferencePaymentModes = respond((req) => listDevisPaymentModeReferences(req.query));
