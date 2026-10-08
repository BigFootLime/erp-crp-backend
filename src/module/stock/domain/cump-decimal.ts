export const CUMP_DECIMAL_SCALE = 1_000_000_000_000n;
const DIGITS = 12;

/** PostgreSQL numeric text only. Financial input is never silently rounded. */
export function parseCumpDecimal(value: string, signed = false): bigint {
  if (typeof value !== 'string') throw new Error('CUMP_DECIMAL_TEXT_REQUIRED');
  const match = /^(-?)(\d{1,26})(?:\.(\d{1,12}))?$/.exec(value);
  if (!match || (!signed && match[1])) throw new Error('CUMP_DECIMAL_INVALID');
  const absolute = BigInt(match[2]) * CUMP_DECIMAL_SCALE + BigInt((match[3] ?? '').padEnd(DIGITS, '0'));
  return match[1] ? -absolute : absolute;
}
export function formatCumpDecimal(value: bigint): string {
  const negative = value < 0n, absolute = negative ? -value : value;
  const fraction = String(absolute % CUMP_DECIMAL_SCALE).padStart(DIGITS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / CUMP_DECIMAL_SCALE}${fraction ? '.' + fraction : ''}`;
}
export function roundCumpRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('CUMP_RATIO_INVALID');
  const result = numerator / denominator, remainder = numerator % denominator;
  return remainder * 2n >= denominator ? result + 1n : result;
}
