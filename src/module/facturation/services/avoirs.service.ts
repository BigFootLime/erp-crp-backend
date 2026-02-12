import type { CreateAvoirBodyDTO, ListAvoirsQueryDTO, UpdateAvoirBodyDTO } from "../validators/avoirs.validators";
import { repoCreateAvoir, repoDeleteAvoir, repoGetAvoir, repoListAvoirs, repoUpdateAvoir } from "../repository/avoirs.repository";

export const svcListAvoirs = (filters: ListAvoirsQueryDTO) => repoListAvoirs(filters);

export const svcGetAvoir = (id: number, include: string) => repoGetAvoir(id, include);

export const svcCreateAvoir = (input: CreateAvoirBodyDTO) => repoCreateAvoir(input);

export const svcUpdateAvoir = (id: number, input: UpdateAvoirBodyDTO) => repoUpdateAvoir(id, input);

export const svcDeleteAvoir = (id: number) => repoDeleteAvoir(id);
