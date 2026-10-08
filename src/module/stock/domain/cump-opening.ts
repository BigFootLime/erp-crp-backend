import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from './cump-decimal';
import type { CumpScope, CumpState } from './cump-valuation';

export type CumpOpeningRow = { id: string; stock_level_id: string; stock_batch_id: string | null;
  article_id: string; source_snapshot: unknown; source_valid: boolean };
export type CumpOpeningIssue = { articleId: string; stockLevelId: string; code: string };
export type CumpOpening = { state: CumpState; openingIds: string[] };
type Observation = { row: CumpOpeningRow; total: bigint; depreciated: bigint; unit: string; owner: CumpScope['owner'] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function read(row: CumpOpeningRow): Observation | null {
  const raw = row.source_snapshot;
  if (!row.source_valid || !UUID.test(row.id) || !UUID.test(row.stock_level_id) || !UUID.test(row.article_id)
    || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.schema_version !== 1 || s.article_id !== row.article_id || s.stock_level_id !== row.stock_level_id
    || s.stock_batch_id !== row.stock_batch_id || s.kind !== (row.stock_batch_id === null ? 'LEVEL' : 'BATCH')) return null;
  const unit = canonicalizeStockUnitCode(typeof s.stock_unit === 'string' ? s.stock_unit : null);
  if (!unit || typeof s.quantity_total !== 'string' || typeof s.quantity_depreciated !== 'string') return null;
  const client = s.owner_client_id;
  if (client !== null && (typeof client !== 'string' || !client || client !== client.trim()
    || client.length > 255 || /[\u0000-\u001f\u007f]/.test(client))) return null;
  if (row.stock_batch_id === null && client !== null) return null;
  if (row.stock_batch_id !== null && !UUID.test(row.stock_batch_id)) return null;
  try {
    const total = decimal(s.quantity_total,true), depreciated = decimal(s.quantity_depreciated);
    return { row,total,depreciated,unit,owner: client === null ? 'COMPANY' : `CLIENT:${client}` };
  } catch { return null; }
}

/** LEVEL already includes BATCH. Company stock is the level minus client-owned
 * batches, not level plus company batches. Reservations do not reduce value.
 * Broken observations block the affected article; no opening price is guessed. */
export function reconcileCumpOpenings(rows: CumpOpeningRow[], reportingCurrency: string): {
  openings: CumpOpening[]; issues: CumpOpeningIssue[]; blockedArticleIds: string[];
} {
  const currency = reportingCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('CUMP_CURRENCY_INVALID');
  const issues: CumpOpeningIssue[] = [], blocked = new Set<string>(), ids = new Set<string>();
  const levels = new Map<string, Observation>(), batches = new Map<string, Observation[]>();
  const issue = (row: CumpOpeningRow, code: string) => {
    issues.push({ articleId: row.article_id,stockLevelId: row.stock_level_id,code }); blocked.add(row.article_id);
  };
  for (const row of rows) {
    const observation = read(row);
    if (!observation || ids.has(row.id)) { issue(row,'OPENING_SOURCE_INVALID'); continue; }
    ids.add(row.id);
    if (row.stock_batch_id === null) {
      if (levels.has(row.stock_level_id)) issue(row,'OPENING_LEVEL_DUPLICATE');
      else levels.set(row.stock_level_id,observation);
    } else {
      const children = batches.get(row.stock_level_id) ?? [];
      if (children.some(b => b.row.stock_batch_id === row.stock_batch_id)) issue(row,'OPENING_BATCH_DUPLICATE');
      else { children.push(observation); batches.set(row.stock_level_id,children); }
    }
  }
  const balances = new Map<string, { scope: CumpScope; quantity: bigint; ids: Set<string> }>();
  const add = (level: Observation, owner: CumpScope['owner'], quantity: bigint, proofIds: string[]) => {
    const scope: CumpScope = { articleId: level.row.article_id,owner,unit: level.unit,currency };
    const key = JSON.stringify(scope), balance = balances.get(key) ?? { scope,quantity: 0n,ids: new Set<string>() };
    balance.quantity += quantity; proofIds.forEach(id => balance.ids.add(id)); balances.set(key,balance);
  };
  for (const [levelId, children] of batches) if (!levels.has(levelId)) {
    children.forEach(child => issue(child.row,'OPENING_LEVEL_MISSING'));
  }
  for (const level of levels.values()) {
    const children = batches.get(level.row.stock_level_id) ?? [];
    if (children.some(child => child.row.article_id !== level.row.article_id || child.unit !== level.unit)) {
      issue(level.row,'OPENING_BATCH_SCOPE_MISMATCH'); children.forEach(child => issue(child.row,'OPENING_BATCH_SCOPE_MISMATCH')); continue;
    }
    const total = children.reduce((sum,child) => sum + child.total,0n);
    const depreciated = children.reduce((sum,child) => sum + child.depreciated,0n);
    const unbatchedTotal = level.total - total, unbatchedDepreciated = level.depreciated - depreciated;
    // With batches, a negative unexplained remainder is not an owner allocation.
    // A negative unbatched level itself remains a known negative quantity.
    if (children.length && (unbatchedTotal < 0n || unbatchedDepreciated < 0n || unbatchedDepreciated > unbatchedTotal))
      issue(level.row,'OPENING_BATCH_QUANTITY_MISMATCH');
    let clientQuantity = 0n;
    for (const child of children.filter(child => child.owner !== 'COMPANY')) {
      const quantity = child.total - child.depreciated; clientQuantity += quantity;
      add(level,child.owner,quantity,[level.row.id,child.row.id]);
    }
    add(level,'COMPANY',level.total - level.depreciated - clientQuantity,[level.row.id,...children.map(child => child.row.id)]);
  }
  const openings = [...balances.values()].map(balance => ({
    openingIds: [...balance.ids].sort(),
    state: { scope: balance.scope,quantity: text(balance.quantity),
      value: balance.quantity === 0n && !blocked.has(balance.scope.articleId) ? '0' : null,
      reliability: balance.quantity === 0n && !blocked.has(balance.scope.articleId) ? 'VERIFIED' as const : 'UNKNOWN' as const,
      sourceRef: `stock-opening:${balance.scope.articleId}:${balance.scope.owner}:${balance.scope.unit}:${currency}` },
  }));
  for (const opening of openings) {
    try { decimal(opening.state.quantity,true); }
    catch {
      blocked.add(opening.state.scope.articleId);
      issues.push({ articleId: opening.state.scope.articleId,stockLevelId: 'aggregate',code: 'OPENING_QUANTITY_PRECISION_UNSUPPORTED' });
    }
  }
  return { openings,issues,blockedArticleIds: [...blocked].sort() };
}
