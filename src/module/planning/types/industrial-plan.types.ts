export type IndustrialKind = "MAKE" | "BUY" | "SUBCONTRACT";
export type IndustrialArticle = {
  id: string;
  code: string;
  unit: string;
  family: string;
  kind: IndustrialKind;
  leadDays: number | null;
  lot: string | null;
  cost: string | null;
  yieldPercent: string | null;
  minStock: string;
  targetStock: string;
  technicalIssues: string[];
};
export type IndustrialBom = { parent: string; child: string; factor: string };
export type IndustrialDemand = {
  id: string;
  article: string;
  unit: string;
  contractLine: string | null;
  orderLine: string | null;
  orderUpdatedAt?: string;
  allocation: string | null;
  kind: "FIRM" | "FORECAST" | "INTERNAL";
  quantity: string;
  due: string;
  priceEur: string | null;
  buildForStock?: boolean;
  historical?: boolean;
};
export type IndustrialSource = {
  id: string;
  article: string;
  unit: string;
  quantity: string;
  available: string;
  orderLine: string | null;
  allocation: string | null;
  contractLine: string | null;
  kind: "STOCK" | "OF" | "OA";
};
export type IndustrialContractRule = {
  id: string;
  clientId: string;
  article: string;
  reserve: string;
  target: string;
  forecastCommitted: boolean;
  useHistory?: boolean;
  riskEur: string | null;
};
export type IndustrialInput = {
  start: string;
  today: string;
  months: number;
  weeks: number;
  frozenDays: number;
  clientId: string;
  clientRisk: string | null;
  openingExposure: string | null;
  articles: IndustrialArticle[];
  bom: IndustrialBom[];
  demand: IndustrialDemand[];
  supplies: IndustrialSource[];
  rules: IndustrialContractRule[];
  workdays: string[];
  issues: string[];
};
export type IndustrialCell = {
  firm: number;
  forecast: number;
  authorized_forecast: number;
  planned: number;
  historical_forecast: number;
  shortage: number;
  projected_stock: number;
  internal: number;
  revenue_eur: number | null;
};
export type IndustrialProposal = {
  article_id: string;
  article: string;
  unit: string;
  kind: IndustrialKind;
  quantity: number;
  order_line_id?: string;
  order_updated_at?: string;
  /** Sizing evidence on new MAKE proposals. Older runs may not contain it. */
  required_good_quantity?: number;
  expected_good_quantity?: number;
  yield_percent?: number;
  due: string;
  release: string | null;
  source_ids: string[];
  issues: string[];
  contract_line_id: string | null;
};
export type IndustrialResult = {
  pic: (IndustrialCell & { month: string; family: string; unit: string })[];
  pdp: (IndustrialCell & {
    week: string;
    article_id: string;
    article: string;
    unit: string;
  })[];
  proposals: IndustrialProposal[];
  allocations: { demand_id: string; source_id: string; quantity: number }[];
  issues: string[];
  forecast_exposure_eur: number | null;
};

/**
 * A strictly read-only recovery suggestion for an overdue monthly contract
 * target. It deliberately is not an executable industrial proposal: the
 * pilot must never create an OF, an OA, a reservation or an AR from it.
 */
export type IndustrialContractTargetRecovery = {
  proposal_id: string;
  mode: "PROPOSAL_ONLY";
  contract_line_id: string;
  article_id: string;
  article: string;
  unit: string;
  target_month: string;
  target_date: string;
  need_date: string;
  quantity_needed: number;
  reserved_quantity: number;
  open_supply_quantity: number;
  proposed_quantity: number;
  earliest_safe_date: string | null;
  proposed_start_date: string | null;
  projected_finish_date: string | null;
  estimated_receipt_date: string | null;
  frozen_until: string;
  status: "PROPOSED" | "ARBITRATION_REQUIRED";
  risks: string[];
  freshness_digest: string;
};

export type IndustrialPlanTargetRecoverySource = {
  contract_line_id: string;
  article_id: string;
  article: string;
  unit: string;
  month: string;
  target_date: string;
  target_overdue: boolean;
  proposed_quantity: number;
};
