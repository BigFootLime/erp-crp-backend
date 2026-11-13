import { createHash } from 'node:crypto';
import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { CUMP_DECIMAL_SCALE as SCALE, parseCumpDecimal as decimal,
  formatCumpDecimal as text, roundCumpRatio as ratio } from './cump-decimal';
import type { ReceiptAcquisitionFacts } from './receipt-acquisition-value';

type Order = NonNullable<ReceiptAcquisitionFacts['order']>;
type Result = { amount: string | null; sourceSha256: string | null; issues: string[] };
type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (v: unknown): Json | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null;
const money = (v: unknown): bigint => { if (typeof v !== 'string') throw Error('Decimal text required'); return decimal(v); };
const id = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw Error('UUID required'); return v; };

/** All order lines come from one immutable receipt snapshot. Quantity units may
 * differ: monetary net values, never cross-unit quantities, weight transport.
 * The normalized hash excludes receipt dates/statuses but includes every fact
 * that changes the allocation. No mutable order lookup or catalogue fallback. */
export function resolveReceiptOrderTransport(order: Order): Result {
  let transport: bigint;
  try { transport = money(order.transportFees); }
  catch { return { amount: null, sourceSha256: null, issues: ['ORDER_TRANSPORT_ALLOCATION_REQUIRED'] }; }
  if (transport === 0n) return { amount: '0', sourceSha256: null, issues: [] };
  const source = object(order.transportBasis);
  if (!source) return { amount: null, sourceSha256: null, issues: ['ORDER_TRANSPORT_ALLOCATION_REQUIRED'] };
  try {
    if (source.schema_version !== 1 || source.method !== 'PROPORTIONAL_NET_V1'
      || source.order_id !== order.id || source.supplier_id !== order.supplierId
      || source.currency !== order.currency?.trim().toUpperCase() || money(source.transport_fees) !== transport
      || source.lines_complete !== true || !Array.isArray(source.lines) || !source.lines.length
      || source.lines.length > 500 || source.active_line_count !== source.lines.length) throw Error('Incomplete order scope');
    const seen = new Set<string>();
    const lines = source.lines.map(raw => {
      const line = object(raw);
      if (!line) throw Error('Line required');
      const lineId = id(line.line_id), articleId = id(line.article_id), unit = canonicalizeStockUnitCode(typeof line.unit === 'string' ? line.unit : null);
      const quantity = money(line.quantity), price = money(line.unit_price), discount = money(line.discount_percent), fees = money(line.additional_fees);
      if (seen.has(lineId) || !unit || quantity <= 0n || discount > 100n * SCALE) throw Error('Invalid line basis');
      seen.add(lineId);
      const net = ratio(quantity * price * (100n * SCALE - discount), 100n * SCALE * SCALE) + fees;
      decimal(text(net));
      return { lineId, articleId, unit, quantity: text(quantity), price: text(price), discount: text(discount), fees: text(fees), net: text(net) };
    }).sort((a, b) => a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
    const selected = lines.find(line => line.lineId === order.lineId);
    if (!selected || selected.articleId !== order.articleId || selected.unit !== canonicalizeStockUnitCode(order.unit)
      || selected.quantity !== text(money(order.quantity)) || selected.price !== text(money(order.unitPrice))
      || selected.discount !== text(money(order.discountPercent)) || selected.fees !== text(money(order.additionalFees))) throw Error('Line scope mismatch');
    const total = lines.reduce((sum, line) => sum + decimal(line.net), 0n);
    decimal(text(total));
    if (total <= 0n) throw Error('Positive net basis required');
    let cumulative = 0n, amount = 0n;
    for (const line of lines) {
      const next = cumulative + decimal(line.net);
      if (line.lineId === order.lineId) amount = ratio(transport * next, total) - ratio(transport * cumulative, total);
      cumulative = next;
    }
    const normalized = { schemaVersion: 1, method: 'PROPORTIONAL_NET_V1', orderId: id(order.id),
      supplierId: id(order.supplierId), currency: source.currency, transportFees: text(transport), lines };
    return { amount: text(amount), sourceSha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), issues: [] };
  } catch {
    return { amount: null, sourceSha256: null, issues: ['ORDER_TRANSPORT_BASIS_INVALID'] };
  }
}
