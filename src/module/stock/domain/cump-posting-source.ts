import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from './cump-decimal';
import { normalizeCumpScope, type CumpScope } from './cump-valuation';

export type CumpJournalSource = { sequence: string; movement_id: string; article_id: string;
  source_snapshot: unknown; source_sha256: string; source_valid: boolean;
  acquisition_snapshot: unknown | null; acquisition_sha256: string | null; acquisition_valid: boolean | null;
  return_snapshot?: unknown | null; return_sha256?: string | null; return_valid?: boolean | null;
  manufacturing_snapshot?: unknown | null; manufacturing_sha256?: string | null;
  manufacturing_valid?: boolean | null; manufacturing_issues?: string[] | null };
export type CumpPostingScope = { scope: CumpScope; quantity: string };
export type CumpPostingSource = { movementId: string; articleId: string; sequence: string; sourceSha256: string;
  kind: 'RECEIPT' | 'ISSUE' | 'SCRAP' | 'TRANSFER' | 'ZERO'; scopes: CumpPostingScope[];
  reversalOfId: string | null; transferId: string | null; internalTransferLeg: boolean;
  acquisitionSnapshot: unknown | null; issues: string[] };
type ObjectValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const absolute = (value: bigint) => value < 0n ? -value : value;

/** Physical quantities come from the immutable Stock posting, never a purchase
 * order. Incomplete ownership/units fail closed for valuation, not for posting. */
export function readCumpPostingSource(row: CumpJournalSource, currency: string): {
  posting: CumpPostingSource | null; issues: string[];
} {
  const invalid = (code: string) => ({ posting: null,issues: [code] });
  const s = object(row.source_snapshot);
  if (!row.source_valid || !s || s.schema_version !== 1 || !UUID.test(row.movement_id)
    || !UUID.test(row.article_id) || s.movement_id !== row.movement_id || s.article_id !== row.article_id
    || !/^[0-9a-f]{64}$/.test(row.source_sha256) || !/^\d+$/.test(row.sequence)) return invalid('STOCK_JOURNAL_SOURCE_INVALID');
  const unit = canonicalizeStockUnitCode(typeof s.stock_unit === 'string' ? s.stock_unit : null);
  if (!unit || typeof s.quantity !== 'string' || !Array.isArray(s.lines)) return invalid('STOCK_POSTING_SCOPE_MISSING');
  let quantity: bigint;
  try { quantity = decimal(s.quantity,true); } catch { return invalid('STOCK_POSTING_QUANTITY_INVALID'); }
  let kind: CumpPostingSource['kind'];
  switch (s.movement_type) {
    case 'IN': if (quantity < 0n) return invalid('STOCK_POSTING_SIGN_INVALID'); kind = 'RECEIPT'; break;
    case 'OUT': if (quantity < 0n) return invalid('STOCK_POSTING_SIGN_INVALID'); kind = 'ISSUE'; break;
    case 'SCRAP': case 'DEPRECIATE': if (quantity < 0n) return invalid('STOCK_POSTING_SIGN_INVALID'); kind = 'SCRAP'; break;
    case 'ADJUST': case 'ADJUSTMENT': kind = quantity < 0n ? 'ISSUE' : 'RECEIPT'; break;
    case 'TRANSFER': if (quantity < 0n) return invalid('STOCK_POSTING_SIGN_INVALID'); kind = 'TRANSFER'; break;
    default: return invalid('STOCK_POSTING_TYPE_UNSUPPORTED');
  }
  const scopes = new Map<string, { scope: CumpScope; quantity: bigint }>();
  let lineQuantity = 0n;
  for (const raw of s.lines) {
    const line = object(raw);
    if (!line || line.article_id !== row.article_id || typeof line.quantity !== 'string'
      || canonicalizeStockUnitCode(typeof line.unit === 'string' ? line.unit : null) !== unit
      || !Object.prototype.hasOwnProperty.call(line,'owner_client_id')) return invalid('STOCK_POSTING_LINE_SCOPE_MISMATCH');
    const client = line.owner_client_id;
    if (client !== null && typeof client !== 'string') return invalid('STOCK_POSTING_OWNER_MISSING');
    if (s.stock_batch_id !== null && s.batch_owner_client_id !== client) return invalid('STOCK_POSTING_BATCH_OWNER_MISMATCH');
    let scope: CumpScope, moved: bigint;
    try {
      scope = normalizeCumpScope({ articleId: row.article_id,owner: client === null ? 'COMPANY' : `CLIENT:${client}`,unit,currency });
      const signed = decimal(line.quantity,true);
      let effective = signed;
      if (s.movement_type==='ADJUST' || s.movement_type==='ADJUSTMENT') {
        // Standard Stock and inventory write a positive line magnitude plus
        // direction, while the header is signed. A legacy signed line without
        // direction may be read only when it agrees with the signed header.
        if (!Object.prototype.hasOwnProperty.call(line,'direction')) return invalid('STOCK_ADJUSTMENT_LINE_DIRECTION_MISSING');
        if (line.direction==='IN' || line.direction==='OUT') {
          if (signed<0n) return invalid('STOCK_ADJUSTMENT_LINE_SIGN_AMBIGUOUS');
          effective = line.direction==='OUT' ? -signed : signed;
        } else if (line.direction!==null) return invalid('STOCK_ADJUSTMENT_LINE_DIRECTION_INVALID');
        if ((quantity<0n && effective>0n) || (quantity>0n && effective<0n)) return invalid('STOCK_POSTING_LINE_SIGN_MISMATCH');
      } else if (signed<0n) return invalid('STOCK_POSTING_LINE_SIGN_MISMATCH');
      moved = absolute(effective);
    } catch { return invalid('STOCK_POSTING_LINE_SCOPE_MISMATCH'); }
    const key = JSON.stringify(scope), group = scopes.get(key) ?? { scope,quantity: 0n };
    group.quantity += moved; lineQuantity += moved; scopes.set(key,group);
  }
  if (lineQuantity !== absolute(quantity) || (quantity !== 0n && !s.lines.length)) return invalid('HEADER_LINE_QUANTITY_MISMATCH');
  const reversalOfId = s.reversal_of_id === null ? null : typeof s.reversal_of_id === 'string' && UUID.test(s.reversal_of_id) ? s.reversal_of_id : null;
  if (s.reversal_of_id !== null && !reversalOfId) return invalid('STOCK_REVERSAL_SOURCE_INVALID');
  const internalTransferLeg = s.document_type === 'STOCK_TRANSFER_INTERNAL';
  const transferId = kind === 'TRANSFER' ? row.movement_id : internalTransferLeg && typeof s.document_id === 'string' && UUID.test(s.document_id) ? s.document_id : null;
  if (internalTransferLeg && !transferId) return invalid('STOCK_TRANSFER_PARENT_MISSING');
  const issues: string[] = [];
  if (row.acquisition_snapshot !== null && !row.acquisition_valid) issues.push('ACQUISITION_SOURCE_HASH_INVALID');
  return { issues,posting: { movementId: row.movement_id,articleId: row.article_id,sequence: row.sequence,
    sourceSha256: row.source_sha256,kind: quantity === 0n ? 'ZERO' : kind,
    scopes: [...scopes.values()].filter(group => group.quantity > 0n).map(group => ({ scope: group.scope,quantity: text(group.quantity) })),
    reversalOfId,transferId,internalTransferLeg,
    acquisitionSnapshot: row.acquisition_valid ? row.acquisition_snapshot : null,issues } };
}

/** Check all three immutable transfer postings before declaring neutrality.
 * Sequence pagination must not replace a complete transfer-group lookup. */
export function checkCumpTransferGroup(posting: CumpPostingSource, group: CumpPostingSource[]): boolean {
  if (!posting.transferId || group.length !== 3 || new Set(group.map(item => item.movementId)).size !== 3) return false;
  const parent = group.find(item => item.movementId === posting.transferId && item.kind === 'TRANSFER' && !item.internalTransferLeg);
  const out = group.find(item => item.kind === 'ISSUE' && item.internalTransferLeg && item.transferId === posting.transferId);
  const incoming = group.find(item => item.kind === 'RECEIPT' && item.internalTransferLeg && item.transferId === posting.transferId);
  if (!parent || !out || !incoming || group.some(item => item.articleId !== posting.articleId || item.reversalOfId)) return false;
  const signature = (item: CumpPostingSource) => JSON.stringify(item.scopes.map(scope =>
    [JSON.stringify(scope.scope),scope.quantity]).sort((a,b) => a[0].localeCompare(b[0])));
  return signature(parent) === signature(out) && signature(out) === signature(incoming);
}
