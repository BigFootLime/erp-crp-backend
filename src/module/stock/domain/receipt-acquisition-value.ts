import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { CUMP_DECIMAL_SCALE as SCALE, parseCumpDecimal as decimal,
  formatCumpDecimal as text, roundCumpRatio as ratio } from './cump-decimal';
import type { CumpCostEvidence } from './cump-valuation';
import { resolveReceiptOrderTransport } from './receipt-order-transport';

/** Server-owned facts frozen with a receipt. They are not an HTTP cost input. */
export type ReceiptAcquisitionFacts = {
  sourceRef: string; articleId: string; ownerClientId: string | null;
  stockQuantity: string; stockUnit: string | null;
  receiptQuantity: string; receiptUnit: string | null; conversionCoefficient: string | null;
  order: null | {
    id: string; lineId: string; articleId: string; status: string; lineStatus: string;
    unit: string | null; currency: string | null; quantity: string | null;
    unitPrice: string | null; discountPercent: string | null; additionalFees: string | null;
    transportFees: string | null;
    supplierId?: string | null; transportBasis?: unknown;
  };
};
/** Cumulative quantity is supplied only by the transactional Stock projector's
 * purchase-line allocation cursor. Reading mutable totals is not this proof. */
export type AcquisitionFeeAllocation = { orderLineId: string; beforeQuantity: string; sourceRef: string };
export type ReceiptAcquisitionValue = CumpCostEvidence & { currency: string; stockUnit: string | null;
  unitCost: string | null; priceAmount: string | null; feesAmount: string | null; transportAmount: string | null; issues: string[] };

const CONFIRMED_ORDER_STATES = new Set(['ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE','RECUE','CLOTUREE']);
function known(value: string | null): bigint | null {
  if (value === null) return null;
  try { return decimal(value); } catch { return null; }
}
function sameUnit(left: string | null, right: string | null): boolean {
  const unit = canonicalizeStockUnitCode(left);
  return unit !== null && unit === canonicalizeStockUnitCode(right);
}

/** Resolve a DECLARED purchase value. Invoice approval/zero-price evidence is a
 * separate owner integration; neither is inferred from the purchase catalogue.
 * Invalid or incomplete financial facts leave stock posting unaffected. */
export function resolveReceiptAcquisitionValue(facts: ReceiptAcquisitionFacts, reportingCurrency: string,
  allocation?: AcquisitionFeeAllocation): ReceiptAcquisitionValue {
  const currency = reportingCurrency.trim().toUpperCase(), stockUnit = canonicalizeStockUnitCode(facts.stockUnit);
  const issues: string[] = [];
  const unknown = (): ReceiptAcquisitionValue => ({ amount: null,reliability: 'UNKNOWN',sourceRef: facts.sourceRef || null,
    currency,stockUnit,unitCost: null,priceAmount: null,feesAmount: null,transportAmount: null,issues });
  if (!/^[A-Z]{3}$/.test(currency)) { issues.push('VALUATION_CURRENCY_MISSING'); return unknown(); }
  if (!facts.sourceRef.trim()) { issues.push('RECEIPT_SOURCE_MISSING'); return unknown(); }
  if (facts.ownerClientId !== null) { issues.push('CLIENT_OWNED_ACQUISITION_UNRESOLVED'); return unknown(); }
  const order = facts.order;
  if (!order) { issues.push('PURCHASE_ORDER_SOURCE_MISSING'); return unknown(); }
  if (!CONFIRMED_ORDER_STATES.has(order.status) || order.lineStatus !== 'ACTIVE') issues.push('PURCHASE_ORDER_NOT_CONFIRMED');
  if (order.articleId !== facts.articleId) issues.push('PURCHASE_ARTICLE_SCOPE_MISMATCH');
  if (order.currency?.trim().toUpperCase() !== currency) issues.push('ACQUISITION_FX_EVIDENCE_REQUIRED');
  if (!stockUnit || !sameUnit(facts.receiptUnit,order.unit)) issues.push('PURCHASE_UNIT_MISMATCH');
  const stocked = known(facts.stockQuantity), received = known(facts.receiptQuantity), coefficient = known(facts.conversionCoefficient);
  const ordered = known(order.quantity), price = known(order.unitPrice), discount = known(order.discountPercent), fees = known(order.additionalFees);
  const transport = resolveReceiptOrderTransport(order);
  issues.push(...transport.issues);
  if (stocked === null || stocked <= 0n || received === null || received <= 0n || coefficient === null || coefficient <= 0n) issues.push('RECEIPT_QUANTITY_CONVERSION_MISSING');
  else {
    // Reception permits a 1e-8 conversion residual when rounding physical
    // quantities to three decimals. Keep its actual stock quantity authoritative.
    const residual = received * coefficient - stocked * SCALE;
    if ((residual < 0n ? -residual : residual) > 10_000_000_000_000_000n) issues.push('RECEIPT_STOCK_QUANTITY_MISMATCH');
    if (sameUnit(facts.receiptUnit,facts.stockUnit) && coefficient !== SCALE) issues.push('SAME_UNIT_CONVERSION_MISMATCH');
  }
  if (ordered === null || ordered <= 0n) issues.push('PURCHASE_QUANTITY_MISSING');
  if (price === null || fees === null || discount === null || discount > 100n * SCALE) issues.push('PURCHASE_PRICE_FACTS_MISSING');
  // Existing order fields default to zero. They do not prove a genuinely free
  // receipt. A matched approved invoice may establish zero in its own adapter.
  if (price === 0n && fees === 0n) issues.push('ZERO_PRICE_EVIDENCE_REQUIRED');
  if (issues.length || stocked === null || received === null || price === null || fees === null || discount === null || ordered === null) return unknown();
  let feeAmount = 0n, transportAmount = 0n;
  const lineTransport = known(transport.amount);
  if (lineTransport === null) { issues.push('ORDER_TRANSPORT_ALLOCATION_REQUIRED'); return unknown(); }
  if (fees > 0n || (known(order.transportFees) ?? 0n) > 0n) {
    const before = allocation ? known(allocation.beforeQuantity) : null;
    if (!allocation || allocation.orderLineId !== order.lineId || !allocation.sourceRef.trim() || before === null) {
      issues.push('ACQUISITION_FEE_ALLOCATION_REQUIRED'); return unknown();
    }
    const clippedBefore = before < ordered ? before : ordered;
    const after = before + received, clippedAfter = after < ordered ? after : ordered;
    // Incremental difference of cumulative allocations preserves the exact
    // residual and caps the total flat fee at the order amount, even overreceipt.
    feeAmount = ratio(fees * clippedAfter,ordered) - ratio(fees * clippedBefore,ordered);
    transportAmount = ratio(lineTransport * clippedAfter,ordered) - ratio(lineTransport * clippedBefore,ordered);
  }
  const priceAmount = ratio(received * price * (100n * SCALE - discount),100n * SCALE * SCALE);
  const amount = text(priceAmount + feeAmount + transportAmount);
  if (known(amount) === null) { issues.push('ACQUISITION_AMOUNT_PRECISION_UNSUPPORTED'); return unknown(); }
  const unitCost = text(ratio((priceAmount + feeAmount + transportAmount) * SCALE,stocked));
  if (known(unitCost) === null) issues.push('UNIT_COST_DISPLAY_PRECISION_UNSUPPORTED');
  return { amount,reliability: 'DECLARED',sourceRef: facts.sourceRef,currency,stockUnit,
    unitCost: known(unitCost) === null ? null : unitCost,priceAmount: text(priceAmount),feesAmount: text(feeAmount),transportAmount: text(transportAmount),issues };
}
