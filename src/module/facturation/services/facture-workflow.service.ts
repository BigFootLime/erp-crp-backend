import {
  repoCreateFactureDraft,
  repoIssueFacture,
  repoListEligibleFactureSources,
  repoPreviewFacture,
  repoRequestFactureValidation,
  repoValidateFacture,
} from "../repository/facture-workflow.repository";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import type {
  CreateFactureDraftBodyDTO,
  EligibleSourcesQueryDTO,
  FacturePreviewBodyDTO,
  ValidationDecisionBodyDTO,
  WorkflowConfirmationBodyDTO,
} from "../validators/workflow.validators";
import { writeImmutableFactureDocument } from "./finance-document.service";

export const svcListEligibleFactureSources = (filters: EligibleSourcesQueryDTO) =>
  repoListEligibleFactureSources(filters);

export const svcPreviewFacture = (input: FacturePreviewBodyDTO) => repoPreviewFacture(input);

export const svcCreateFactureDraft = (params: {
  input: CreateFactureDraftBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoCreateFactureDraft(params);

export const svcRequestFactureValidation = (params: {
  factureId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoRequestFactureValidation(params);

export const svcValidateFacture = (params: {
  factureId: number;
  input: ValidationDecisionBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoValidateFacture(params);

export const svcIssueFacture = (params: {
  factureId: number;
  input: WorkflowConfirmationBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) =>
  repoIssueFacture({
    ...params,
    writeDocument: writeImmutableFactureDocument,
  });
