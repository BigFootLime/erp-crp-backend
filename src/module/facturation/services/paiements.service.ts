import type { CreatePaiementBodyDTO, ListPaiementsQueryDTO, UpdatePaiementBodyDTO } from "../validators/paiements.validators";
import {
  repoCreatePaiement,
  repoDeletePaiement,
  repoGetPaiement,
  repoListPaiements,
  repoUpdatePaiement,
} from "../repository/paiements.repository";

export const svcListPaiements = (filters: ListPaiementsQueryDTO) => repoListPaiements(filters);

export const svcGetPaiement = (id: number, include: string) => repoGetPaiement(id, include);

export const svcCreatePaiement = (input: CreatePaiementBodyDTO) => repoCreatePaiement(input);

export const svcUpdatePaiement = (id: number, input: UpdatePaiementBodyDTO) => repoUpdatePaiement(id, input);

export const svcDeletePaiement = (id: number) => repoDeletePaiement(id);
