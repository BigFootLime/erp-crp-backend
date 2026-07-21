import type {
  CreateAffaireBodyDTO,
  ListAffairesCommandCenterQueryDTO,
  ListAffairesQueryDTO,
  UpdateAffaireBodyDTO,
  TransitionAffaireBodyDTO,
  ArchiveAffaireBodyDTO,
  PreviewAffaireBodyDTO,
} from "../validators/affaire.validators";
import type { AuditContext } from "../types/affaire.types";
import {
  repoArchiveAffaire,
  repoCreateAffaire,
  repoGetAffaireOperations,
  repoGetAffaire,
  repoListAffairesCommandCenter,
  repoListAffaires,
  repoPreviewAffaire,
  repoTransitionAffaire,
  repoUpdateAffaire,
} from "../repository/affaire.repository";

export const svcListAffaires = (filters: ListAffairesQueryDTO) => repoListAffaires(filters);

export const svcListAffairesCommandCenter = (filters: ListAffairesCommandCenterQueryDTO) =>
  repoListAffairesCommandCenter(filters);

export const svcGetAffaire = (id: number, include: string) => repoGetAffaire(id, include);

export const svcGetAffaireOperations = (id: number) => repoGetAffaireOperations(id);

export const svcPreviewAffaire = (input: PreviewAffaireBodyDTO) => repoPreviewAffaire(input);

export const svcCreateAffaire = (input: CreateAffaireBodyDTO, audit?: AuditContext) => repoCreateAffaire(input, audit);

export const svcUpdateAffaire = (id: number, input: UpdateAffaireBodyDTO, audit?: AuditContext) =>
  repoUpdateAffaire(id, input, audit);

export const svcTransitionAffaire = (id: number, input: TransitionAffaireBodyDTO, audit?: AuditContext) =>
  repoTransitionAffaire(id, input, audit);

export const svcArchiveAffaire = (id: number, input: ArchiveAffaireBodyDTO, audit?: AuditContext) =>
  repoArchiveAffaire(id, input, audit);
