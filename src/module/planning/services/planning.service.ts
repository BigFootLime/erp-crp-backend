import type {
  Paginated,
  PlanningEventComment,
  PlanningEventDetail,
  PlanningEventDocument,
  PlanningEventListItem,
  PlanningResources,
} from "../types/planning.types";
import type {
  CreatePlanningEventBodyDTO,
  CreatePlanningEventCommentBodyDTO,
  ListPlanningEventsQueryDTO,
  ListPlanningResourcesQueryDTO,
  PatchPlanningEventBodyDTO,
} from "../validators/planning.validators";
import type { AuditContext } from "../repository/planning.repository";
import {
  repoArchivePlanningEvent,
  repoCreatePlanningEvent,
  repoCreatePlanningEventComment,
  repoGetPlanningEventDetail,
  repoGetPlanningEventDocumentFileMeta,
  repoListPlanningEvents,
  repoListPlanningResources,
  repoPatchPlanningEvent,
  repoUploadPlanningEventDocuments,
} from "../repository/planning.repository";

export async function svcListPlanningResources(query: ListPlanningResourcesQueryDTO): Promise<PlanningResources> {
  return repoListPlanningResources(query);
}

export async function svcListPlanningEvents(query: ListPlanningEventsQueryDTO): Promise<Paginated<PlanningEventListItem>> {
  return repoListPlanningEvents(query);
}

export async function svcGetPlanningEventDetail(id: string): Promise<PlanningEventDetail | null> {
  return repoGetPlanningEventDetail(id);
}

export async function svcCreatePlanningEvent(params: {
  body: CreatePlanningEventBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventListItem> {
  return repoCreatePlanningEvent(params);
}

export async function svcPatchPlanningEvent(params: {
  id: string;
  patch: PatchPlanningEventBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventListItem | null> {
  return repoPatchPlanningEvent(params);
}

export async function svcArchivePlanningEvent(params: { id: string; audit: AuditContext }): Promise<boolean | null> {
  return repoArchivePlanningEvent(params);
}

export async function svcCreatePlanningEventComment(params: {
  event_id: string;
  body: CreatePlanningEventCommentBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventComment> {
  return repoCreatePlanningEventComment(params);
}

export async function svcUploadPlanningEventDocuments(params: {
  event_id: string;
  documents: { originalname: string; path: string; mimetype: string; size?: number }[];
  audit: AuditContext;
}): Promise<PlanningEventDocument[]> {
  return repoUploadPlanningEventDocuments(params);
}

export async function svcGetPlanningEventDocumentFileMeta(params: {
  event_id: string;
  document_id: string;
}) {
  return repoGetPlanningEventDocumentFileMeta(params);
}
