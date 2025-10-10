// src/module/clients/services/clients.read.service.ts
import { repoGetClientById, repoListClients } from "../repository/clients.read.repository";

export const svcGetClientById = (id: string) => repoGetClientById(id);
export const svcListClients   = (q: string, limit: number) => repoListClients(q, limit);
