export type CustomerOrderLaunchMode =
  | "STOCK_ONLY"
  | "PRODUCTION_WITH_PLANNING";

/**
 * Every generated OF requires an explicit planning validation. An empty gamme
 * is allowed, but it must remain visible to planning instead of silently moving
 * the customer order to AR preparation.
 */
export function resolveCustomerOrderLaunchMode(params: {
  needsProduction: boolean;
  generatedOperationsCount: number;
}): CustomerOrderLaunchMode {
  if (!params.needsProduction) return "STOCK_ONLY";
  return "PRODUCTION_WITH_PLANNING";
}
