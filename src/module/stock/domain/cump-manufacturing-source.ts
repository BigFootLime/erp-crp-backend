import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from './cump-decimal';
import { readCumpPostingSource, type CumpJournalSource } from './cump-posting-source';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : null;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export type ManufacturingReceiptProof = { detected: boolean; issues: string[]; proof: {
  manufacturing_source_sha256: string | null; receipt_id?: string; of_id?: string;
  lot_id?: string; piece_technique_id?: string; piece_technique_version_id?: string;
  quantity_good?: string; actual_margin_snapshot_id?: string | null;
  actual_margin_reliability?: string | null; manufacturing_value_allocation_required?: boolean;
} };

/** Verify frozen physical origin only. A saved margin is not an inventory cost
 * approval, and neither selling price nor a later recalculation prices a receipt. */
export function readCumpManufacturingReceipt(row: CumpJournalSource, currency: string): ManufacturingReceiptProof {
  const root = object(row.source_snapshot), snapshot = object(row.manufacturing_snapshot);
  const detected = Boolean(snapshot || (root?.movement_type === 'IN' && root.source_document_type === 'OF' && root.reversal_of_id === null));
  const proof: ManufacturingReceiptProof['proof'] = { manufacturing_source_sha256: row.manufacturing_sha256 ?? null };
  const invalid = (reason: string): ManufacturingReceiptProof => ({ detected, issues: [reason], proof });
  if (!detected) return { detected: false, issues: [], proof };
  const posting = readCumpPostingSource(row, currency).posting;
  if (!snapshot || !row.manufacturing_valid || !/^[0-9a-f]{64}$/.test(row.manufacturing_sha256 ?? '')
    || snapshot.schema_version !== 1 || snapshot.movement_id !== row.movement_id
    || snapshot.article_id !== row.article_id || snapshot.stock_source_sha256 !== row.source_sha256
    || !posting || posting.kind !== 'RECEIPT' || posting.reversalOfId || posting.scopes.length !== 1)
    return invalid('MANUFACTURING_RECEIPT_PROOF_MISSING');
  if (!Array.isArray(snapshot.receipts) || snapshot.receipts.length !== 1 || !root
    || !Array.isArray(root.lines) || root.lines.length !== 1) return invalid('MANUFACTURING_RECEIPT_SOURCE_AMBIGUOUS');
  const receipt = object(snapshot.receipts[0]), line = object(root.lines[0]);
  const order = object(receipt?.of), lot = object(receipt?.lot);
  if (!receipt || !order || !lot || !line || !uuid(receipt.id) || !uuid(receipt.lot_id)
    || !uuid(order.piece_technique_id) || !uuid(order.piece_technique_version_id)
    || typeof receipt.of_id !== 'string' || !/^\d+$/.test(receipt.of_id)
    || order.id !== receipt.of_id || root.source_document_type !== 'OF' || root.source_document_id !== receipt.of_id
    || receipt.stock_movement_id !== row.movement_id || receipt.lot_id !== lot.id || receipt.lot_id !== line.lot_id
    || receipt.stock_level_id !== root.stock_level_id || receipt.stock_batch_id !== root.stock_batch_id
    || lot.article_id !== row.article_id || line.article_id !== row.article_id
    || (order.article_id !== null && order.article_id !== row.article_id)
    || lot.owner_client_id !== line.owner_client_id) return invalid('MANUFACTURING_RECEIPT_LINK_MISMATCH');
  try {
    const quantity = decimal(posting.scopes[0].quantity);
    if (typeof receipt.quantity_good !== 'string' || decimal(receipt.quantity_good) !== quantity
      || typeof snapshot.stock_quantity !== 'string' || decimal(snapshot.stock_quantity) !== quantity
      || canonicalizeStockUnitCode(typeof snapshot.stock_unit === 'string' ? snapshot.stock_unit : null) !== posting.scopes[0].scope.unit)
      return invalid('MANUFACTURING_RECEIPT_QUANTITY_MISMATCH');
    for (const field of ['quantity_scrap', 'quantity_rework'])
      if (typeof receipt[field] !== 'string') return invalid('MANUFACTURING_RECEIPT_QUANTITY_MISSING');
      else decimal(receipt[field] as string);
    const margin = object(snapshot.actual_margin), result = object(margin?.result_snapshot);
    const marginMatches = margin && margin.scope_type === 'OF' && margin.scope_ref === receipt.of_id && margin.basis === 'ACTUAL';
    Object.assign(proof, { receipt_id: receipt.id, of_id: receipt.of_id, lot_id: receipt.lot_id,
      piece_technique_id: order.piece_technique_id, piece_technique_version_id: order.piece_technique_version_id,
      quantity_good: text(quantity), actual_margin_snapshot_id: marginMatches && typeof margin.id === 'string' ? margin.id : null,
      actual_margin_reliability: marginMatches && typeof result?.reliability === 'string' ? result.reliability : null,
      manufacturing_value_allocation_required: true });
    const issues = [...(row.manufacturing_issues ?? []), 'MANUFACTURING_VALUE_ALLOCATION_REQUIRED'];
    if (!marginMatches || !result) issues.push('MANUFACTURING_ACTUAL_MARGIN_SOURCE_MISSING');
    else if (result.reliability !== 'ACTUAL') issues.push('MANUFACTURING_COST_BASIS_NOT_VERIFIED');
    return { detected: true, proof, issues: [...new Set(issues)] };
  } catch { return invalid('MANUFACTURING_RECEIPT_QUANTITY_INVALID'); }
}
