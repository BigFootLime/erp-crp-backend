import {
  CUMP_DECIMAL_SCALE,
  formatCumpDecimal,
  parseCumpDecimal,
} from "../../stock/domain/cump-decimal";

import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";

/**
 * Project good output from the immutable yield percentage and the current
 * gross launch. Piece units are floored to a whole piece; continuous units
 * are floored to a millesimal. The result is never greater than the physical
 * gross quantity left after definitive scrap.
 */
export function frozenYieldGoodOutput(input: {
  launched: string | number;
  yieldPercent: string | number;
  unit: string;
  scrap?: string | number;
}): bigint {
  const launched = parseCumpDecimal(String(input.launched));
  const scrap = parseCumpDecimal(String(input.scrap ?? 0));
  const yieldPercent = parseCumpDecimal(String(input.yieldPercent));
  if (
    launched < 0n ||
    scrap < 0n ||
    yieldPercent <= 0n ||
    yieldPercent > 100n * CUMP_DECIMAL_SCALE
  )
    throw new Error("FROZEN_YIELD_INVALID");
  const availableGross = launched > scrap ? launched - scrap : 0n;
  const projected = (launched * yieldPercent) / (100n * CUMP_DECIMAL_SCALE);
  const precision = canonicalizeStockUnitCode(input.unit) === "u"
    ? CUMP_DECIMAL_SCALE
    : CUMP_DECIMAL_SCALE / 1000n;
  const roundedDown = (projected / precision) * precision;
  return roundedDown < availableGross ? roundedDown : availableGross;
}

export function frozenYieldGoodOutputNumber(
  input: Parameters<typeof frozenYieldGoodOutput>[0],
) {
  return Number(formatCumpDecimal(frozenYieldGoodOutput(input)));
}
