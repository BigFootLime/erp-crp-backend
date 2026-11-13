import type { ClientContractArticle } from './client-contract.types';
import type { ContractReplenishmentMonth } from '../domain/client-contract-replenishment';

export type CoveragePeriod = { month: string; target_date: string; end_date: string };
export type ContractCoverageDemand = {
  id: string; kind: 'FIRM' | 'FORECAST'; article_id: string; unit: string;
  contract_id: string | null; contract_line_id: string | null;
  order_line_id: string | null; allocation_id: string | null;
  quantity: string; due_date: string; month: string; target_date: string;
};
export type ContractCoverageSupply = {
  id: string; kind: 'RESERVED' | 'FREE' | 'PRODUCTION'; article_id: string; unit: string;
  quantity: string; available_date: string | null;
  order_line_id: string | null; allocation_id: string | null;
  reference_id: string; label: string;
};
export type ContractCoverageAllocation = {
  demand_id: string; source_id: string; kind: ContractCoverageSupply['kind']; quantity: string;
};
export type ContractCoverageMonth = CoveragePeriod & {
  forecast_quantity: string; firm_quantity: string; reserved_quantity: string;
  free_quantity: string; production_quantity: string; missing_quantity: string;
  cumulative_demand: string; cumulative_covered: string; cumulative_missing: string;
  target_overdue: boolean;
};
export type ContractCoverageLine = {
  contract_line_id: string; replenishment_qty: string; article: ClientContractArticle;
  months: ContractCoverageMonth[];
  replenishment_projection: ContractReplenishmentMonth[];
};
export type ContractCoverageIssue = { code: string; message: string; reference_id?: string };
export type ContractCoverageResult = {
  contract_id: string; contract_version: number; generated_at: string; planning_revision: string | null;
  start_month: string; months: number; readonly: true; snapshot_hash: string;
  lines: ContractCoverageLine[]; demands: ContractCoverageDemand[];
  sources: ContractCoverageSupply[]; allocations: ContractCoverageAllocation[];
  issues: ContractCoverageIssue[];
};
