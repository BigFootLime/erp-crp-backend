import type { AuditContext } from "../repository/production.repository";
import type {
  CreateProductionGroupBodyDTO,
  LinkProductionGroupBodyDTO,
  ListProductionGroupsQueryDTO,
  UnlinkProductionGroupBodyDTO,
  UpdateProductionGroupBodyDTO,
} from "../validators/production-groups.validators";

import {
  repoCreateProductionGroup,
  repoGetProductionGroup,
  repoLinkProductionGroup,
  repoListProductionGroups,
  repoUnlinkProductionGroup,
  repoUpdateProductionGroup,
} from "../repository/production-groups.repository";

export const svcListProductionGroups = (query: ListProductionGroupsQueryDTO) => repoListProductionGroups(query);

export const svcGetProductionGroup = (id: string) => repoGetProductionGroup(id);

export const svcCreateProductionGroup = (params: { body: CreateProductionGroupBodyDTO; audit: AuditContext }) =>
  repoCreateProductionGroup(params);

export const svcUpdateProductionGroup = (params: { id: string; patch: UpdateProductionGroupBodyDTO; audit: AuditContext }) =>
  repoUpdateProductionGroup(params);

export const svcLinkProductionGroup = (params: { id: string; body: LinkProductionGroupBodyDTO; audit: AuditContext }) =>
  repoLinkProductionGroup(params);

export const svcUnlinkProductionGroup = (params: { id: string; body: UnlinkProductionGroupBodyDTO; audit: AuditContext }) =>
  repoUnlinkProductionGroup(params);
