import * as repository from "../repository/planning-references.repository";
import type { PlanningReferenceOfListQuery, PlanningReferenceClientQuery } from "../validators/planning-references.validators";
export const svcListPlanningReferenceClients = (query: PlanningReferenceClientQuery) => repository.repoListPlanningReferenceClients(query);
export const svcListPlanningReferenceOfs = (query: PlanningReferenceOfListQuery) => repository.repoListPlanningReferenceOfs(query);
export const svcGetPlanningReferenceOf = (id: number) => repository.repoGetPlanningReferenceOf(id);
