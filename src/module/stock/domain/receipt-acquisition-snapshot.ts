import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { parseCumpDecimal } from './cump-decimal';
import { resolveReceiptAcquisitionValue, type AcquisitionFeeAllocation,
  type ReceiptAcquisitionFacts, type ReceiptAcquisitionValue } from './receipt-acquisition-value';

type JsonObject = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function identifier(value: unknown): string | null {
  const text = string(value); return text && UUID.test(text) ? text : null;
}
function quantity(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  try { const parsed = parseCumpDecimal(value); return parsed > 0n ? parsed : null; } catch { return null; }
}
function sameUnit(left: unknown, right: unknown): boolean {
  const unit = canonicalizeStockUnitCode(string(left));
  return unit !== null && unit === canonicalizeStockUnitCode(string(right));
}

/** Read the immutable journal format, never today's order or article price.
 * A structurally incomplete source is a financial UNKNOWN, not a stock error.
 * Portion quantities corroborate the receipt link; they are not added to it. */
export function readReceiptAcquisitionFacts(snapshot: unknown): { facts: ReceiptAcquisitionFacts | null; issues: string[] } {
  const s = object(snapshot), issues: string[] = [];
  const invalid = (issue: string) => ({ facts: null, issues: [issue] });
  if (!s || s.schema_version !== 1) return invalid('ACQUISITION_SCHEMA_UNSUPPORTED');
  const movementId = identifier(s.movement_id), articleId = identifier(s.article_id), stocked = quantity(s.stock_quantity);
  if (!movementId || !articleId || stocked === null || !Object.prototype.hasOwnProperty.call(s,'owner_client_id')
    || (s.owner_client_id !== null && typeof s.owner_client_id !== 'string')) return invalid('ACQUISITION_STOCK_SCOPE_MISSING');
  if (!Array.isArray(s.receipts) || s.receipts.length !== 1 || !Array.isArray(s.portions)) return invalid('RECEIPT_SOURCE_CARDINALITY');
  const receipt = object(s.receipts[0]);
  if (!receipt || !identifier(receipt.receipt_stock_id) || !identifier(receipt.receipt_line_id)
    || !identifier(receipt.reception_id) || receipt.line_reception_id !== receipt.reception_id
    || s.source_document_id !== receipt.reception_id) return invalid('RECEIPT_LINK_SCOPE_MISMATCH');
  if ((receipt.stock_article_id ?? receipt.receipt_article_id) !== articleId) issues.push('RECEIPT_STOCK_ARTICLE_MISMATCH');
  if (!sameUnit(receipt.stock_unit,s.stock_unit)) issues.push('RECEIPT_STOCK_UNIT_MISMATCH');
  const received = quantity(receipt.receipt_quantity);
  if (received === null) issues.push('RECEIPT_QUANTITY_MISSING');
  if (!Array.isArray(s.stock_lines) || !s.stock_lines.length) return invalid('MOVEMENT_LINES_MISSING');
  let lineQuantity = 0n;
  for (const raw of s.stock_lines) {
    const line = object(raw), qty = line ? quantity(line.quantity) : null;
    if (!line || qty === null || line.article_id !== articleId || line.owner_client_id !== s.owner_client_id
      || !sameUnit(line.unit,s.stock_unit)) return invalid('ACQUISITION_MOVEMENT_LINE_SCOPE_MISMATCH');
    lineQuantity += qty;
  }
  if (lineQuantity !== stocked) issues.push('HEADER_LINE_QUANTITY_MISMATCH');
  if (s.portions.length) {
    let receiptQuantity = 0n, stockQuantity = 0n;
    for (const raw of s.portions) {
      const portion = object(raw), receiptQty = portion ? quantity(portion.receipt_quantity) : null;
      const stockQty = portion ? quantity(portion.stock_quantity) : null;
      if (!portion || !identifier(portion.id) || portion.receipt_line_id !== receipt.receipt_line_id
        || receiptQty === null || stockQty === null) return invalid('RECEIPT_PORTION_SCOPE_MISMATCH');
      receiptQuantity += receiptQty; stockQuantity += stockQty;
    }
    if (receiptQuantity !== received || stockQuantity !== stocked) issues.push('RECEIPT_PORTION_QUANTITY_MISMATCH');
  }
  const order = object(receipt.order);
  if (order && (!identifier(order.id) || !identifier(order.line_id)
    || order.id !== receipt.receipt_order_id || !identifier(order.supplier_id)
    || order.supplier_id !== receipt.receipt_supplier_id)) issues.push('PURCHASE_ORDER_RECEIPT_SCOPE_MISMATCH');
  if (issues.length) return { facts: null,issues };
  return { issues,facts: { sourceRef: `stock-acquisition:${movementId}`,articleId,
    ownerClientId: s.owner_client_id as string | null,stockQuantity: s.stock_quantity as string,
    stockUnit: string(s.stock_unit),receiptQuantity: receipt.receipt_quantity as string,
    receiptUnit: string(receipt.receipt_unit),conversionCoefficient: string(receipt.conversion_coefficient),
    order: order ? { id: order.id as string,lineId: order.line_id as string,articleId: string(order.article_id) ?? '',
      status: string(order.status) ?? '',lineStatus: string(order.line_status) ?? '',unit: string(order.unit),
      currency: string(order.currency),quantity: string(order.quantity),unitPrice: string(order.unit_price),
      discountPercent: string(order.discount_percent),additionalFees: string(order.additional_fees),
      transportFees: string(order.transport_fees),supplierId: string(order.supplier_id),transportBasis: order.transport_basis } : null } };
}

export function resolveCapturedReceiptAcquisitionValue(snapshot: unknown, currency: string,
  allocation?: AcquisitionFeeAllocation): ReceiptAcquisitionValue {
  const parsed = readReceiptAcquisitionFacts(snapshot);
  if (parsed.facts) return resolveReceiptAcquisitionValue(parsed.facts,currency,allocation);
  return { amount: null,reliability: 'UNKNOWN',sourceRef: null,currency,
    stockUnit: null,unitCost: null,priceAmount: null,feesAmount: null,transportAmount: null,issues: parsed.issues };
}
