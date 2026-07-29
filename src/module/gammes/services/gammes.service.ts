// src/module/gammes/services/gammes.service.ts
// GPAO B2.2 — service gammes (logique fine dans les repositories).
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository"
import {
  repoCreateGammeOperation,
  repoDeleteGammeOperation,
  repoGammePublicationReadiness,
  repoListGammeOperations,
  repoNextPhase,
  repoPublishGamme,
  repoReorderGammeOperations,
  repoUpdateGammeOperation,
  type OperationWriteInput,
} from "../repository/gamme-operations.repository"
import {
  repoCreateGamme,
  repoListGammesByVersion,
  repoUpdateGamme,
} from "../repository/gammes.repository"
import type {
  CreateGammeBodyDTO,
  UpdateGammeBodyDTO,
} from "../validators/gammes.validators"

export const listGammesByVersionSVC = (versionId: string) => repoListGammesByVersion(versionId)
export const createGammeSVC = (versionId: string, body: CreateGammeBodyDTO, audit: AuditContext) =>
  repoCreateGamme(versionId, body, audit)
export const updateGammeSVC = (gammeId: string, body: UpdateGammeBodyDTO, audit: AuditContext) =>
  repoUpdateGamme(gammeId, body, audit)

export const listGammeOperationsSVC = (gammeId: string) => repoListGammeOperations(gammeId)
export const nextPhaseSVC = (gammeId: string, afterOperationId: string | null) =>
  repoNextPhase(gammeId, afterOperationId)
export const addGammeOperationSVC = (gammeId: string, body: OperationWriteInput, audit: AuditContext) =>
  repoCreateGammeOperation(gammeId, body, audit)
export const updateGammeOperationSVC = (
  gammeId: string,
  operationId: string,
  body: OperationWriteInput,
  audit: AuditContext
) => repoUpdateGammeOperation(gammeId, operationId, body, audit)
export const deleteGammeOperationSVC = (
  gammeId: string,
  operationId: string,
  expectedUpdatedAt: string,
  audit: AuditContext
) => repoDeleteGammeOperation(gammeId, operationId, expectedUpdatedAt, audit)
export const reorderGammeOperationsSVC = (gammeId: string, order: string[], audit: AuditContext) =>
  repoReorderGammeOperations(gammeId, order, audit)

export const gammePublicationReadinessSVC = (gammeId: string) => repoGammePublicationReadiness(gammeId)
export const publishGammeSVC = (gammeId: string, expectedUpdatedAt: string, audit: AuditContext) =>
  repoPublishGamme(gammeId, expectedUpdatedAt, audit)
