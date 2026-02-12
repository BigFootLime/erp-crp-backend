import type {
  CreateTarificationClientBodyDTO,
  ListTarificationClientsQueryDTO,
  UpdateTarificationClientBodyDTO,
} from "../validators/tarification.validators";
import {
  repoCreateTarificationClient,
  repoDeleteTarificationClient,
  repoGetTarificationClient,
  repoListTarificationClients,
  repoUpdateTarificationClient,
} from "../repository/tarification.repository";

export const svcListTarificationClients = (filters: ListTarificationClientsQueryDTO) => repoListTarificationClients(filters);

export const svcGetTarificationClient = (id: number, include: string) => repoGetTarificationClient(id, include);

export const svcCreateTarificationClient = (input: CreateTarificationClientBodyDTO) => repoCreateTarificationClient(input);

export const svcUpdateTarificationClient = (id: number, input: UpdateTarificationClientBodyDTO) => repoUpdateTarificationClient(id, input);

export const svcDeleteTarificationClient = (id: number) => repoDeleteTarificationClient(id);
