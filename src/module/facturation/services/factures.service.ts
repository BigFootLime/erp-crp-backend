import type {
  CreateFactureBodyDTO,
  ListFacturesQueryDTO,
  UpdateFactureBodyDTO,
} from "../validators/factures.validators";
import {
  repoGetFacture,
  repoListFactures,
} from "../repository/factures.repository";
import { HttpError } from "../../../utils/httpError";

export const svcListFactures = (filters: ListFacturesQueryDTO) => repoListFactures(filters);

export const svcGetFacture = (id: number, include: string) => repoGetFacture(id, include);

export const svcCreateFacture = (_input: CreateFactureBodyDTO) => {
  throw new HttpError(
    409,
    "FACTURE_WORKFLOW_REQUIRED",
    "La création directe est désactivée. Utilisez l'aperçu puis la création explicite du workflow Finance."
  );
};

export const svcUpdateFacture = (_id: number, _input: UpdateFactureBodyDTO) => {
  throw new HttpError(
    409,
    "FACTURE_WORKFLOW_REQUIRED",
    "La modification directe est désactivée. Recréez l'aperçu dans le workflow Finance."
  );
};

export const svcDeleteFacture = (_id: number) => {
  throw new HttpError(
    409,
    "FACTURE_DELETE_FORBIDDEN",
    "Une facture ne se supprime pas. Un document émis se corrige par avoir."
  );
};
