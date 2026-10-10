import type { ClientContractArticle } from './client-contract.types';
import type { ContractCoverageResult } from './client-contract-coverage.types';

export type ReplenishmentPlanLaunchLink = {
  proposal_id: string; lot_index?: number | null; root_of_id: number; number: string; status: string; quantity: string; target_date: string;
};

/** Preparation evidence only; these quantities never increase physical coverage. */
export type PreparedContractReplenishmentProposal = {
  id: string; plan_id: string; contract_line_id: string; article: ClientContractArticle;
  month: string; target_date: string; target_overdue: boolean;
  lot_quantity: string; lot_count: string; proposed_quantity: string; surplus_quantity: string;
};
export type PreparedContractReplenishmentPlan = {
  id: string; contract_id: string; contract_version: number; status: 'CURRENT' | 'SUPERSEDED';
  purpose: 'PREPARATION_ONLY'; fingerprint: string; coverage_snapshot_hash: string;
  start_month: string; months: number; as_of_date: string; created_at: string;
  created_by: number; actor_label: string; proposals: PreparedContractReplenishmentProposal[];
};
export type PreparedContractReplenishmentResult = {
  event_id: string; unchanged: boolean; plan: PreparedContractReplenishmentPlan;
};
export type ContractReplenishmentPreparation = {
  fingerprint: string; report: ContractCoverageResult; as_of_date: string;
  proposals: Omit<PreparedContractReplenishmentProposal, 'id' | 'plan_id'>[];
};
