import type { CreatePaiementBodyDTO, ListPaiementsQueryDTO, UpdatePaiementBodyDTO } from "../validators/paiements.validators";
import {
  repoGetPaiement,
  repoListPaiements,
} from "../repository/paiements.repository";
import { HttpError } from "../../../utils/httpError";

export const svcListPaiements = (filters: ListPaiementsQueryDTO) => repoListPaiements(filters);

export const svcGetPaiement = (id: number, include: string) => repoGetPaiement(id, include);

export const svcCreatePaiement = (_input: CreatePaiementBodyDTO) => {
  throw new HttpError(
    409,
    "PAYMENT_WORKFLOW_REQUIRED",
    "La création directe est désactivée. Utilisez l'enregistrement idempotent du workflow Finance."
  );
};

export const svcUpdatePaiement = (_id: number, _input: UpdatePaiementBodyDTO) => {
  throw new HttpError(
    409,
    "PAYMENT_WORKFLOW_REQUIRED",
    "La modification directe est désactivée. Utilisez une commande Finance compensatoire."
  );
};

export const svcDeletePaiement = (_id: number) => {
  throw new HttpError(
    409,
    "PAYMENT_DELETE_FORBIDDEN",
    "Un paiement enregistré ne se supprime pas."
  );
};
