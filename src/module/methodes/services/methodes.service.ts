// Service Méthodes — orchestration fine, la logique reste dans le domaine et le
// repository. Le service porte les règles qui traversent PLUSIEURS référentiels.

import { HttpError } from "../../../utils/httpError";
import { assertFamilySelectable, type MachineFamilyRef } from "../domain/methodes-policy";
import {
  repoAddCostCenterRate,
  repoCreateCostCenter,
  repoCreateMachineFamily,
  repoGetCostCenter,
  repoGetMachineFamily,
  repoListCostCenterRates,
  repoListCostCenters,
  repoListMachineFamilies,
  repoListMachineOptions,
  repoUpdateCostCenter,
  repoUpdateMachineFamily,
  type AddCostCenterRateInput,
  type CreateCostCenterInput,
  type CreateMachineFamilyInput,
  type ListCostCentersParams,
  type ListMachineOptionsParams,
  type UpdateCostCenterInput,
  type UpdateMachineFamilyInput,
} from "../repository/methodes.repository";
import {
  repoGetMachineQualification,
  repoListMachinesForQualification,
  repoPreviewMachineQualification,
  repoQualifyMachine,
  type MachineQualificationDTO,
  type MachineQualificationImpactDTO,
  type QualifyMachineInput,
} from "../repository/machine-qualification.repository";
import type {
  AuditContext,
  CostCenterDTO,
  CostCenterRateDTO,
  MachineFamilyDTO,
  MachineOptionDTO,
} from "../types/methodes.types";

function toFamilyRef(family: MachineFamilyDTO): MachineFamilyRef {
  return {
    code: family.code,
    libelle: family.libelle,
    programme_requis: family.programme_requis,
    actif: family.actif,
  };
}

async function assertFamilyUsable(code: string | null | undefined): Promise<void> {
  if (code === null || code === undefined) return;
  const family = await repoGetMachineFamily(code);
  assertFamilySelectable(family ? toFamilyRef(family) : null, code);
}

export const listMachineFamiliesSVC = (includeInactive: boolean): Promise<MachineFamilyDTO[]> =>
  repoListMachineFamilies({ includeInactive });

export const createMachineFamilySVC = (input: CreateMachineFamilyInput, audit: AuditContext): Promise<MachineFamilyDTO> =>
  repoCreateMachineFamily(input, audit);

export const updateMachineFamilySVC = (
  code: string,
  input: UpdateMachineFamilyInput,
  audit: AuditContext
): Promise<MachineFamilyDTO | null> => repoUpdateMachineFamily(code, input, audit);

export const listCostCentersSVC = (params: ListCostCentersParams): Promise<CostCenterDTO[]> =>
  repoListCostCenters(params);

export const getCostCenterSVC = (cfId: string): Promise<CostCenterDTO | null> => repoGetCostCenter(cfId);

export async function createCostCenterSVC(input: CreateCostCenterInput, audit: AuditContext): Promise<CostCenterDTO> {
  await assertFamilyUsable(input.machine_family_code);
  return repoCreateCostCenter(input, audit);
}

export async function updateCostCenterSVC(
  cfId: string,
  input: UpdateCostCenterInput,
  audit: AuditContext
): Promise<CostCenterDTO | null> {
  await assertFamilyUsable(input.machine_family_code);
  return repoUpdateCostCenter(cfId, input, audit);
}

export const listCostCenterRatesSVC = (cfId: string): Promise<CostCenterRateDTO[]> => repoListCostCenterRates(cfId);

export async function addCostCenterRateSVC(
  cfId: string,
  input: AddCostCenterRateInput,
  audit: AuditContext
): Promise<CostCenterRateDTO[]> {
  const cf = await repoGetCostCenter(cfId);
  if (!cf) throw new HttpError(404, "NOT_FOUND", "Centre de frais introuvable");
  if (cf.statut === "ARCHIVE") {
    throw new HttpError(
      409,
      "COST_CENTER_ARCHIVED",
      "Un centre de frais archivé ne reçoit plus de tarif : réactivez-le d'abord."
    );
  }
  return repoAddCostCenterRate(cfId, input, audit);
}

export async function listMachineOptionsSVC(params: ListMachineOptionsParams): Promise<MachineOptionDTO[]> {
  await assertFamilyUsable(params.machine_family_code);
  return repoListMachineOptions(params);
}

/* -------------------------------------------------------------------------- */
/* Qualification du parc machine (#233)                                       */
/* -------------------------------------------------------------------------- */

export const listMachinesForQualificationSVC = (params: {
  search: string | null;
  only_unqualified: boolean;
  include_archived: boolean;
}): Promise<MachineQualificationDTO[]> => repoListMachinesForQualification(params);

export const getMachineQualificationSVC = (machineId: string): Promise<MachineQualificationDTO | null> =>
  repoGetMachineQualification(machineId);

export async function previewMachineQualificationSVC(
  machineId: string,
  candidateFamily: string | null
): Promise<MachineQualificationImpactDTO | null> {
  await assertFamilyUsable(candidateFamily);
  return repoPreviewMachineQualification(machineId, candidateFamily);
}

/**
 * La famille est revalidée ICI en plus du repository : le service voit le
 * référentiel complet (libellé, `programme_requis`) et rend un refus lisible
 * avant même d'ouvrir une transaction.
 */
export async function qualifyMachineSVC(
  machineId: string,
  input: QualifyMachineInput,
  audit: AuditContext
): Promise<MachineQualificationDTO | null> {
  await assertFamilyUsable(input.machine_family_code);
  return repoQualifyMachine(machineId, input, audit);
}
