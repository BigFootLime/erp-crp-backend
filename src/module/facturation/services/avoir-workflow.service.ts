import {
  repoCreateAvoirDraft,
  repoIssueAvoir,
  repoListAvoirEligibleLines,
  repoPreviewAvoir,
  repoRequestAvoirValidation,
  repoValidateAvoir,
} from "../repository/avoir-workflow.repository";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import type {
  AvoirPreviewBodyDTO,
  CreateAvoirDraftBodyDTO,
  ValidationDecisionBodyDTO,
  WorkflowConfirmationBodyDTO,
} from "../validators/workflow.validators";
import { writeImmutableAvoirDocument } from "./avoir-document.service";
import { svcAutoQueueIssuedElectronicDocument } from "../electronic-invoicing/electronic-invoice.service";

export const svcPreviewAvoir = (input: AvoirPreviewBodyDTO) => repoPreviewAvoir(input);
export const svcListAvoirEligibleLines = (factureId: number) =>
  repoListAvoirEligibleLines(factureId);

export const svcCreateAvoirDraftWorkflow = (params: {
  input: CreateAvoirDraftBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoCreateAvoirDraft(params);

export const svcRequestAvoirValidation = (params: {
  avoirId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoRequestAvoirValidation(params);

export const svcValidateAvoirWorkflow = (params: {
  avoirId: number;
  input: ValidationDecisionBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoValidateAvoir(params);

export const svcIssueAvoirWorkflow = async (params: {
  avoirId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => {
  const result = await repoIssueAvoir({ ...params, writeDocument: writeImmutableAvoirDocument });
  await svcAutoQueueIssuedElectronicDocument({
    documentType: "CREDIT_NOTE",
    localId: result.id,
    rowVersion: result.row_version,
    actor: params.actor,
  });
  return result;
};
