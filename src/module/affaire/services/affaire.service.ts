import type { CreateAffaireBodyDTO, ListAffairesQueryDTO, UpdateAffaireBodyDTO } from "../validators/affaire.validators";
import {
  repoCreateAffaire,
  repoDeleteAffaire,
  repoGetAffaire,
  repoListAffaires,
  repoUpdateAffaire,
} from "../repository/affaire.repository";

export const svcListAffaires = (filters: ListAffairesQueryDTO) => repoListAffaires(filters);

export const svcGetAffaire = (id: number, include: string) => repoGetAffaire(id, include);

export const svcCreateAffaire = (input: CreateAffaireBodyDTO) => repoCreateAffaire(input);

export const svcUpdateAffaire = (id: number, input: UpdateAffaireBodyDTO) => repoUpdateAffaire(id, input);

export const svcDeleteAffaire = (id: number) => repoDeleteAffaire(id);
