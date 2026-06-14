import * as repo from "../repository/machine-intelligence.repository";
import type { ListMachineModelsQueryDTO } from "../validators/machine-intelligence.validators";

export const svcListMachineModels = (filters: ListMachineModelsQueryDTO) => repo.repoListMachineModels(filters);

export const svcGetMachineModel = (id: string) => repo.repoGetMachineModel(id);

export const svcGetMachineIntelligence = (machineId: string) => repo.repoGetMachineIntelligence(machineId);

export const svcListMachineCapabilities = (machineId: string) => repo.repoListMachineCapabilities(machineId);

export const svcListMachineDocuments = (machineId: string) => repo.repoListMachineDocuments(machineId);

export const svcListMachineModelCapabilities = (modelId: string) => repo.repoListMachineModelCapabilities(modelId);

export const svcListMachineModelDocuments = (modelId: string) => repo.repoListMachineModelDocuments(modelId);
