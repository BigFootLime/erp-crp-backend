import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  repoApproveReminder,
  repoCancelReminder,
  repoCreateReminderPolicy,
  repoGetReminderReadiness,
  repoGetReminderClientPreference,
  repoListReminderHistory,
  repoListReminderPolicies,
  repoListReminderSuggestions,
  repoRetireReminderPolicy,
  repoRetryReminder,
  repoUpsertReminderClientPreference,
  repoValidateReminderPolicy,
} from "../repository/reminders.repository";
import type {
  ApproveReminderDTO,
  CancelReminderDTO,
  CreateReminderPolicyDTO,
  ListReminderSuggestionsDTO,
  ReminderClientPreferenceDTO,
  RetireReminderPolicyDTO,
  RetryReminderDTO,
  ValidateReminderPolicyDTO,
} from "../validators/reminders.validators";

export const svcListReminderPolicies = () => repoListReminderPolicies();
export const svcGetReminderReadiness = () => repoGetReminderReadiness();
export const svcCreateReminderPolicy = (input: CreateReminderPolicyDTO, actor: FinanceActorContext) =>
  repoCreateReminderPolicy(input, actor);
export const svcValidateReminderPolicy = (params: {
  policyId: string;
  input: ValidateReminderPolicyDTO;
  actor: FinanceActorContext;
}) => repoValidateReminderPolicy(params);
export const svcRetireReminderPolicy = (params: {
  policyId: string;
  input: RetireReminderPolicyDTO;
  actor: FinanceActorContext;
}) => repoRetireReminderPolicy(params);
export const svcListReminderSuggestions = (filters: ListReminderSuggestionsDTO) =>
  repoListReminderSuggestions(filters);
export const svcApproveReminder = (params: {
  suggestionId: string;
  input: ApproveReminderDTO;
  actor: FinanceActorContext;
}) => repoApproveReminder(params);
export const svcRetryReminder = (params: {
  suggestionId: string;
  input: RetryReminderDTO;
  actor: FinanceActorContext;
}) => repoRetryReminder(params);
export const svcCancelReminder = (params: {
  suggestionId: string;
  input: CancelReminderDTO;
  actor: FinanceActorContext;
}) => repoCancelReminder(params);
export const svcListInvoiceReminderHistory = (factureId: number, limit: number) =>
  repoListReminderHistory({ factureId, limit });
export const svcListClientReminderHistory = (clientId: string, limit: number) =>
  repoListReminderHistory({ clientId, limit });
export const svcUpsertReminderClientPreference = (params: {
  clientId: string;
  input: ReminderClientPreferenceDTO;
  actor: FinanceActorContext;
}) => repoUpsertReminderClientPreference(params);
export const svcGetReminderClientPreference = (clientId: string) =>
  repoGetReminderClientPreference(clientId);
