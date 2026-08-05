import type {
  Paginated,
  ProgrammationRescheduleCancelResult,
  ProgrammationRescheduleCommitResult,
  ProgrammationReschedulePreview,
  ProgrammationTaskListItem,
} from "../types/programmation.types";
import type {
  CancelProgrammationRescheduleBodyDTO,
  CommitProgrammationRescheduleBodyDTO,
  ListProgrammationsQueryDTO,
  PreviewProgrammationRescheduleBodyDTO,
} from "../validators/programmation.validators";
import {
  repoCancelProgrammationReschedule,
  repoCommitProgrammationReschedule,
  repoListProgrammations,
  repoPreviewProgrammationReschedule,
} from "../repository/programmation.repository";
import type { AuditContext } from "../../planning/repository/planning.repository";

export async function svcListProgrammations(query: ListProgrammationsQueryDTO): Promise<Paginated<ProgrammationTaskListItem>> {
  return repoListProgrammations(query);
}

export function svcPreviewProgrammationReschedule(params: {
  id: string;
  body: PreviewProgrammationRescheduleBodyDTO;
}): Promise<ProgrammationReschedulePreview> {
  return repoPreviewProgrammationReschedule(params);
}

export function svcCommitProgrammationReschedule(params: {
  id: string;
  body: CommitProgrammationRescheduleBodyDTO;
  audit: AuditContext;
}): Promise<ProgrammationRescheduleCommitResult> {
  return repoCommitProgrammationReschedule(params);
}

export function svcCancelProgrammationReschedule(params: {
  id: string;
  operationId: string;
  body: CancelProgrammationRescheduleBodyDTO;
  audit: AuditContext;
}): Promise<ProgrammationRescheduleCancelResult> {
  return repoCancelProgrammationReschedule(params);
}
