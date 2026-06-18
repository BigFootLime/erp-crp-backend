import type {
  CreateAffaireBodyDTO,
  ListAffairesCommandCenterQueryDTO,
  ListAffairesQueryDTO,
  UpdateAffaireBodyDTO,
} from "../validators/affaire.validators";
import type { AuditContext } from "../types/affaire.types";
import {
  repoCreateAffaire,
  repoDeleteAffaire,
  repoGetAffaireOperations,
  repoGetAffaire,
  repoListAffairesCommandCenter,
  repoListAffaires,
  repoUpdateAffaire,
} from "../repository/affaire.repository";

export const svcListAffaires = (filters: ListAffairesQueryDTO) => repoListAffaires(filters);

export const svcListAffairesCommandCenter = (filters: ListAffairesCommandCenterQueryDTO) =>
  repoListAffairesCommandCenter(filters);

export const svcGetAffaire = (id: number, include: string) => repoGetAffaire(id, include);

export const svcGetAffaireOperations = (id: number) => repoGetAffaireOperations(id);

export const svcCreateAffaire = (input: CreateAffaireBodyDTO, audit?: AuditContext) => repoCreateAffaire(input, audit);

export const svcUpdateAffaire = (id: number, input: UpdateAffaireBodyDTO, audit?: AuditContext) =>
  repoUpdateAffaire(id, input, audit);

export const svcDeleteAffaire = (id: number, audit?: AuditContext) => repoDeleteAffaire(id, audit);
