import {
  repoActivateFinanceConfiguration,
  repoCreateFinanceSequences,
  repoGetFinanceConfigurationReadiness,
} from "../repository/finance-configuration.repository";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import type {
  ActivateFinanceConfigurationBodyDTO,
  CreateFinanceSequencesBodyDTO,
  FinanceConfigurationReadinessQueryDTO,
} from "../validators/finance-configuration.validators";

export const svcGetFinanceConfigurationReadiness = (query: FinanceConfigurationReadinessQueryDTO) =>
  repoGetFinanceConfigurationReadiness(query);

export const svcActivateFinanceConfiguration = (params: {
  input: ActivateFinanceConfigurationBodyDTO;
  actor: FinanceActorContext;
}) => repoActivateFinanceConfiguration(params);

export const svcCreateFinanceSequences = (params: {
  input: CreateFinanceSequencesBodyDTO;
  actor: FinanceActorContext;
}) => repoCreateFinanceSequences(params);
