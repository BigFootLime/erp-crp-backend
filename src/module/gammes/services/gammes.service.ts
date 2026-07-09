// src/module/gammes/services/gammes.service.ts
// GPAO B2.2 — service gammes (logique fine dans le repository).
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository"
import {
  repoAddGammeOperation,
  repoCreateGamme,
  repoListGammeOperations,
  repoListGammesByVersion,
  repoReorderGammeOperations,
  repoUpdateGamme,
} from "../repository/gammes.repository"
import type {
  AddGammeOperationBodyDTO,
  CreateGammeBodyDTO,
  UpdateGammeBodyDTO,
} from "../validators/gammes.validators"

export const listGammesByVersionSVC = (versionId: string) => repoListGammesByVersion(versionId)
export const createGammeSVC = (versionId: string, body: CreateGammeBodyDTO, audit: AuditContext) =>
  repoCreateGamme(versionId, body, audit)
export const updateGammeSVC = (gammeId: string, body: UpdateGammeBodyDTO, audit: AuditContext) =>
  repoUpdateGamme(gammeId, body, audit)
export const listGammeOperationsSVC = (gammeId: string) => repoListGammeOperations(gammeId)
export const addGammeOperationSVC = (gammeId: string, body: AddGammeOperationBodyDTO, audit: AuditContext) =>
  repoAddGammeOperation(gammeId, body, audit)
export const reorderGammeOperationsSVC = (gammeId: string, order: string[], audit: AuditContext) =>
  repoReorderGammeOperations(gammeId, order, audit)
