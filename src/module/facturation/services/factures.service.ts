import type {
  CreateFactureBodyDTO,
  ListFacturesQueryDTO,
  UpdateFactureBodyDTO,
} from "../validators/factures.validators";
import {
  repoCreateFacture,
  repoDeleteFacture,
  repoGetFacture,
  repoListFactures,
  repoUpdateFacture,
} from "../repository/factures.repository";

export const svcListFactures = (filters: ListFacturesQueryDTO) => repoListFactures(filters);

export const svcGetFacture = (id: number, include: string) => repoGetFacture(id, include);

export const svcCreateFacture = (input: CreateFactureBodyDTO) => repoCreateFacture(input);

export const svcUpdateFacture = (id: number, input: UpdateFactureBodyDTO) => repoUpdateFacture(id, input);

export const svcDeleteFacture = (id: number) => repoDeleteFacture(id);
