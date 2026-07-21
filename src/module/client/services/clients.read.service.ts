// src/module/clients/services/clients.read.service.ts
import {
  repoGetClientById,
  repoListClientAddresses,
  repoListClients,
  type ClientReadOptions,
} from "../repository/clients.read.repository";

export const svcGetClientById = (id: string, options: ClientReadOptions = {}) =>
  repoGetClientById(id, options);
export const svcListClients   = (q: string, limit: number) => repoListClients(q, limit);
export const svcListClientAddresses = (clientId: string) => repoListClientAddresses(clientId);
