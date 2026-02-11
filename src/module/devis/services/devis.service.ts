import type {
  CreateDevisBodyDTO,
  ListDevisQueryDTO,
  UpdateDevisBodyDTO,
} from "../validators/devis.validators";
import type { UploadedDocument } from "../types/devis.types";
import {
  repoCreateDevis,
  repoDeleteDevis,
  repoGetDevis,
  repoListDevis,
  repoUpdateDevis,
} from "../repository/devis.repository";

export const svcListDevis = (filters: ListDevisQueryDTO) => repoListDevis(filters);

export const svcGetDevis = (id: number, include: string) => repoGetDevis(id, include);

export const svcCreateDevis = (input: CreateDevisBodyDTO, userId: number, documents: UploadedDocument[]) =>
  repoCreateDevis(input, userId, documents);

export const svcUpdateDevis = (id: number, input: UpdateDevisBodyDTO, userId: number, documents: UploadedDocument[]) =>
  repoUpdateDevis(id, input, userId, documents);

export const svcDeleteDevis = (id: number) => repoDeleteDevis(id);
