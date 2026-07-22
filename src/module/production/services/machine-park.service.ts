import * as repo from "../repository/machine-park.repository";

export const svcGetMachineParkContext = repo.repoGetMachineParkContext;
export const svcListMachineUnavailability = repo.repoListMachineUnavailability;
export const svcCreateMachineUnavailability = repo.repoCreateMachineUnavailability;
export const svcArchiveMachineUnavailability = repo.repoArchiveMachineUnavailability;
export const svcListMachineMaintenancePlans = repo.repoListMachineMaintenancePlans;
export const svcCreateMachineMaintenancePlan = repo.repoCreateMachineMaintenancePlan;
export const svcUpdateMachineMaintenancePlan = repo.repoUpdateMachineMaintenancePlan;
export const svcListMachineMaintenanceEvents = repo.repoListMachineMaintenanceEvents;
export const svcCreateMachineMaintenanceEvent = repo.repoCreateMachineMaintenanceEvent;
export const svcReactivateMachine = repo.repoReactivateMachine;
export const svcCreateMachineDocument = repo.repoCreateMachineDocument;
export const svcUploadMachineDocument = repo.repoUploadMachineDocument;
export const svcGetMachineDocumentForDownload = repo.repoGetMachineDocumentForDownload;
export const svcRemoveMachineDocument = repo.repoRemoveMachineDocument;
