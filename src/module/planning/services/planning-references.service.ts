import * as repository from "../repository/planning-references.repository";
import type { PlanningReferenceOfListQuery } from "../validators/planning-references.validators";
export const svcListPlanningReferenceOfs = (query: PlanningReferenceOfListQuery) => repository.repoListPlanningReferenceOfs(query);
export const svcGetPlanningReferenceOf = (id: number) => repository.repoGetPlanningReferenceOf(id);
