import type { CreateAvoirBodyDTO, ListAvoirsQueryDTO, UpdateAvoirBodyDTO } from "../validators/avoirs.validators";
import { repoGetAvoir, repoListAvoirs } from "../repository/avoirs.repository";
import { HttpError } from "../../../utils/httpError";

export const svcListAvoirs = (filters: ListAvoirsQueryDTO) => repoListAvoirs(filters);

export const svcGetAvoir = (id: number, include: string) => repoGetAvoir(id, include);

export const svcCreateAvoir = (_input: CreateAvoirBodyDTO) => {
  throw new HttpError(
    409,
    "AVOIR_WORKFLOW_REQUIRED",
    "La création directe est désactivée. Utilisez l'aperçu puis le workflow d'avoir."
  );
};

export const svcUpdateAvoir = (_id: number, _input: UpdateAvoirBodyDTO) => {
  throw new HttpError(
    409,
    "AVOIR_WORKFLOW_REQUIRED",
    "La modification directe est désactivée. Recréez l'aperçu dans le workflow d'avoir."
  );
};

export const svcDeleteAvoir = (_id: number) => {
  throw new HttpError(
    409,
    "AVOIR_DELETE_FORBIDDEN",
    "Un avoir financier ne se supprime pas."
  );
};
