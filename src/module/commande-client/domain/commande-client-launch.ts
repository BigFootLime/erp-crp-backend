export type CustomerOrderLaunchMode =
  | "STOCK_ONLY"
  | "PRODUCTION_WITH_PLANNING"
  | "PRODUCTION_WITHOUT_PLANNING";

/**
 * Planning is meaningful only when at least one generated OF operation can be
 * scheduled. An empty gamme remains traceable through its OF but must not trap
 * the customer order on an impossible planning checkpoint.
 */
export function resolveCustomerOrderLaunchMode(params: {
  needsProduction: boolean;
  generatedOperationsCount: number;
}): CustomerOrderLaunchMode {
  if (!params.needsProduction) return "STOCK_ONLY";
  return params.generatedOperationsCount > 0
    ? "PRODUCTION_WITH_PLANNING"
    : "PRODUCTION_WITHOUT_PLANNING";
}
