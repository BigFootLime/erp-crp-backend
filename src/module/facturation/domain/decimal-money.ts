import { HttpError } from "../../../utils/httpError";

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

export function parseDecimal(value: string, scale: number, label: string): bigint {
  const normalized = value.trim();
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new HttpError(422, "DECIMAL_INVALID", `${label} doit être un nombre décimal exact.`);
  }
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > scale) {
    throw new HttpError(
      422,
      "DECIMAL_PRECISION_EXCEEDED",
      `${label} accepte au maximum ${scale} décimales.`
    );
  }
  const units = BigInt(whole) * pow10(scale) + BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -units : units;
}

export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = pow10(scale);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole.toString()}${scale ? `.${fraction}` : ""}`;
}

export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export type ExactLineInput = {
  quantity: string;
  unitPriceExTax: string;
  discountPercent: string;
  taxRatePercent: string;
};

export type ExactLineTotals = {
  totalExTax: string;
  taxAmount: string;
  totalInclTax: string;
};

const QUANTITY_SCALE = 3;
const PRICE_SCALE = 4;
const PERCENT_SCALE = 4;
const MONEY_SCALE = 2;
const PERCENT_DENOMINATOR = 100n * pow10(PERCENT_SCALE);

function assertPercent(value: bigint, label: string): void {
  if (value < 0n || value > PERCENT_DENOMINATOR) {
    throw new HttpError(422, "PERCENT_OUT_OF_RANGE", `${label} doit être compris entre 0 et 100.`);
  }
}

function roundScale(value: bigint, fromScale: number, toScale: number): bigint {
  if (fromScale === toScale) return value;
  if (fromScale < toScale) return value * pow10(toScale - fromScale);
  return divideHalfUp(value, pow10(fromScale - toScale));
}

export function computeExactLineTotals(line: ExactLineInput): ExactLineTotals {
  const quantity = parseDecimal(line.quantity, QUANTITY_SCALE, "Quantité");
  const price = parseDecimal(line.unitPriceExTax, PRICE_SCALE, "Prix unitaire HT");
  const discount = parseDecimal(line.discountPercent, PERCENT_SCALE, "Remise");
  const taxRate = parseDecimal(line.taxRatePercent, PERCENT_SCALE, "Taux de taxe");
  if (quantity <= 0n) throw new HttpError(422, "QUANTITY_INVALID", "La quantité doit être strictement positive.");
  if (price < 0n) throw new HttpError(422, "PRICE_INVALID", "Le prix unitaire ne peut pas être négatif.");
  assertPercent(discount, "Remise");
  assertPercent(taxRate, "Taux de taxe");

  const rawExTax = divideHalfUp(
    quantity * price * (PERCENT_DENOMINATOR - discount),
    PERCENT_DENOMINATOR
  );
  const totalExTaxCents = roundScale(rawExTax, QUANTITY_SCALE + PRICE_SCALE, MONEY_SCALE);
  const taxCents = divideHalfUp(totalExTaxCents * taxRate, PERCENT_DENOMINATOR);
  return {
    totalExTax: formatDecimal(totalExTaxCents, MONEY_SCALE),
    taxAmount: formatDecimal(taxCents, MONEY_SCALE),
    totalInclTax: formatDecimal(totalExTaxCents + taxCents, MONEY_SCALE),
  };
}

export type ExactDocumentTotals = {
  subtotalExTax: string;
  discountPercent: string;
  discountAmount: string;
  totalExTax: string;
  totalTax: string;
  totalInclTax: string;
};

export function computeExactDocumentTotals(
  lines: readonly ExactLineInput[],
  globalDiscountPercent: string
): ExactDocumentTotals {
  const discount = parseDecimal(globalDiscountPercent, PERCENT_SCALE, "Remise globale");
  assertPercent(discount, "Remise globale");
  const lineTotals = lines.map(computeExactLineTotals);
  const subtotalCents = lineTotals.reduce(
    (sum, line) => sum + parseDecimal(line.totalExTax, MONEY_SCALE, "Total HT"),
    0n
  );
  const taxBeforeDiscountCents = lineTotals.reduce(
    (sum, line) => sum + parseDecimal(line.taxAmount, MONEY_SCALE, "Taxe"),
    0n
  );
  const totalExTaxCents = divideHalfUp(
    subtotalCents * (PERCENT_DENOMINATOR - discount),
    PERCENT_DENOMINATOR
  );
  const totalTaxCents = divideHalfUp(
    taxBeforeDiscountCents * (PERCENT_DENOMINATOR - discount),
    PERCENT_DENOMINATOR
  );
  return {
    subtotalExTax: formatDecimal(subtotalCents, MONEY_SCALE),
    discountPercent: formatDecimal(discount, PERCENT_SCALE),
    discountAmount: formatDecimal(subtotalCents - totalExTaxCents, MONEY_SCALE),
    totalExTax: formatDecimal(totalExTaxCents, MONEY_SCALE),
    totalTax: formatDecimal(totalTaxCents, MONEY_SCALE),
    totalInclTax: formatDecimal(totalExTaxCents + totalTaxCents, MONEY_SCALE),
  };
}

export function moneyToCents(value: string, label = "Montant"): bigint {
  return parseDecimal(value, MONEY_SCALE, label);
}
