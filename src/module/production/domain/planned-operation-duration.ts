export type PlannedOperationDurationInput = Readonly<{
  setupHours: number;
  unitHours: number;
  baseQuantity: number;
  launchedQuantity: number;
  coefficient: number;
}>;

function finiteNonNegative(value: number, field: keyof PlannedOperationDurationInput): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

/**
 * Canonical scheduling load:
 * setup + unit time × gamme base quantity × OF launched quantity × coefficient.
 * Inputs are decimal hours; the output is rounded once to whole minutes.
 */
export function computePlannedOperationDurationMinutes(input: PlannedOperationDurationInput): number {
  const setupHours = finiteNonNegative(input.setupHours, "setupHours");
  const unitHours = finiteNonNegative(input.unitHours, "unitHours");
  const baseQuantity = finiteNonNegative(input.baseQuantity, "baseQuantity");
  const launchedQuantity = finiteNonNegative(input.launchedQuantity, "launchedQuantity");
  const coefficient = finiteNonNegative(input.coefficient, "coefficient");
  return Math.round((setupHours + unitHours * baseQuantity * launchedQuantity * coefficient) * 60);
}

/** Same canonical formula for PostgreSQL reads. Aliases are fixed by repository code. */
export const PLANNED_OPERATION_DURATION_MINUTES_SQL = `
  ROUND(GREATEST(0,
    op.tp
    + op.tf_unit
      * op.qte
      * o.quantite_lancee
      * op.coef
  ) * 60)::int
`;
