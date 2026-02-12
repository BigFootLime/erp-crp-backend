import type {
  CreateMachineBodyDTO,
  CreateOfBodyDTO,
  CreatePosteBodyDTO,
  ListMachinesQueryDTO,
  ListOfQueryDTO,
  ListPostesQueryDTO,
  StartOfTimeLogBodyDTO,
  UpdateMachineBodyDTO,
  UpdateOfBodyDTO,
  UpdateOfOperationBodyDTO,
  UpdatePosteBodyDTO,
  StopOfTimeLogBodyDTO,
} from "../validators/production.validators";
import * as repo from "../repository/production.repository";

export const svcListMachines = (filters: ListMachinesQueryDTO) => repo.repoListMachines(filters);

export const svcGetMachine = (id: string) => repo.repoGetMachine(id);

export const svcCreateMachine = (params: {
  body: CreateMachineBodyDTO;
  image_path: string | null;
  audit: repo.AuditContext;
}) => repo.repoCreateMachine(params);

export const svcUpdateMachine = (params: {
  id: string;
  patch: UpdateMachineBodyDTO;
  image_path?: string | null;
  audit: repo.AuditContext;
}) => repo.repoUpdateMachine(params);

export const svcArchiveMachine = (params: { id: string; audit: repo.AuditContext }) => repo.repoArchiveMachine(params);

export const svcListPostes = (filters: ListPostesQueryDTO) => repo.repoListPostes(filters);

export const svcGetPoste = (id: string) => repo.repoGetPoste(id);

export const svcCreatePoste = (params: { body: CreatePosteBodyDTO; audit: repo.AuditContext }) =>
  repo.repoCreatePoste(params);

export const svcUpdatePoste = (params: { id: string; patch: UpdatePosteBodyDTO; audit: repo.AuditContext }) =>
  repo.repoUpdatePoste(params);

export const svcArchivePoste = (params: { id: string; audit: repo.AuditContext }) => repo.repoArchivePoste(params);

// Ordres de fabrication (OF)
export const svcListOrdresFabrication = (filters: ListOfQueryDTO) => repo.repoListOrdresFabrication(filters);

export const svcGetOrdreFabrication = (params: { id: number; user_id?: number }) =>
  repo.repoGetOrdreFabrication(params);

export const svcCreateOrdreFabrication = (params: { body: CreateOfBodyDTO; audit: repo.AuditContext }) =>
  repo.repoCreateOrdreFabrication(params);

export const svcUpdateOrdreFabrication = (params: { id: number; patch: UpdateOfBodyDTO; audit: repo.AuditContext }) =>
  repo.repoUpdateOrdreFabrication(params);

export const svcUpdateOrdreFabricationOperation = (params: {
  of_id: number;
  op_id: string;
  patch: UpdateOfOperationBodyDTO;
  audit: repo.AuditContext;
}) => repo.repoUpdateOrdreFabricationOperation(params);

export const svcStartOfOperationTimeLog = (params: {
  of_id: number;
  op_id: string;
  body: StartOfTimeLogBodyDTO;
  audit: repo.AuditContext;
}) => repo.repoStartOfOperationTimeLog(params);

export const svcStopOfOperationTimeLog = (params: {
  of_id: number;
  op_id: string;
  body: StopOfTimeLogBodyDTO;
  audit: repo.AuditContext;
}) => repo.repoStopOfOperationTimeLog(params);
