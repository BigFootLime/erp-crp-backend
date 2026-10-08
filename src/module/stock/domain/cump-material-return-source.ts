import { parseCumpDecimal as decimal } from './cump-decimal';
import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { readCumpPostingSource, type CumpJournalSource } from './cump-posting-source';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string,unknown> | null => value!==null && typeof value==='object' && !Array.isArray(value)
  ? value as Record<string,unknown> : null;

/** Remnant provenance is frozen by Stock at commit. Never rebuild a missing
 * historical link by reading today's mutable reservation or lot records. */
export function readCumpMaterialReturnOriginal(row: CumpJournalSource,currency: string): {
  detected: boolean; originalMovementId: string | null; issues: string[];
} {
  const raw = object(row.return_snapshot);
  if (!raw) return { detected: false,originalMovementId: null,issues: [] };
  const invalid = (code: string) => ({ detected: true,originalMovementId: null,issues: [code] });
  if (!row.return_valid || raw.schema_version!==1 || raw.movement_id!==row.movement_id
    || raw.stock_source_sha256!==row.source_sha256 || !row.return_sha256 || !/^[0-9a-f]{64}$/.test(row.return_sha256))
    return invalid('MATERIAL_RETURN_PROOF_INVALID');
  if (raw.reversal_of_id!==null || !Array.isArray(raw.remnants) || raw.remnants.length!==1)
    return invalid('MATERIAL_RETURN_SOURCE_CARDINALITY');
  const link = object(raw.remnants[0]),current = readCumpPostingSource(row,currency).posting;
  if (!link || !current || current.kind!=='RECEIPT' || current.scopes.length!==1 || link.compensates_id!==null)
    return invalid('MATERIAL_RETURN_SOURCE_SCOPE_INVALID');
  for (const key of ['id','debit_id','source_reservation_id','lot_id','need_id','original_movement_id'])
    if (typeof link[key]!=='string' || !UUID.test(link[key] as string)) return invalid('MATERIAL_RETURN_LINK_INCOMPLETE');
  const originalMovementId = link.original_movement_id as string,originalSource = object(link.original_stock_source);
  if (!originalSource || typeof link.original_stock_source_sha256!=='string') return invalid('MATERIAL_RETURN_ORIGINAL_SOURCE_MISSING');
  const original = readCumpPostingSource({ sequence: '0',movement_id: originalMovementId,article_id: row.article_id,
    source_snapshot: originalSource,source_sha256: link.original_stock_source_sha256,source_valid: row.return_valid,
    acquisition_snapshot: null,acquisition_sha256: null,acquisition_valid: null },currency).posting;
  if (!original || original.kind!=='ISSUE' || originalSource.movement_type!=='OUT' || original.scopes.length!==1
    || JSON.stringify(original.scopes[0].scope)!==JSON.stringify(current.scopes[0].scope)) return invalid('MATERIAL_RETURN_ORIGINAL_SCOPE_MISMATCH');
  const stock = object(row.source_snapshot);
  if (!stock || stock.source_document_type!=='OF' || originalSource.source_document_type!=='OF'
    || typeof link.of_id!=='string' || !/^\d+$/.test(link.of_id)
    || stock.source_document_id!==link.of_id || originalSource.source_document_id!==link.of_id
    || !Array.isArray(stock.lines) || !stock.lines.every(line=>object(line)?.lot_id===link.lot_id))
    return invalid('MATERIAL_RETURN_DEBIT_OWNER_MISMATCH');
  try {
    if (typeof link.quantity!=='string' || typeof link.source_actual_quantity!=='string'
      || canonicalizeStockUnitCode(typeof link.unit==='string' ? link.unit : null)!==current.scopes[0].scope.unit
      || decimal(link.quantity)!==decimal(current.scopes[0].quantity)
      || decimal(link.source_actual_quantity)!==decimal(original.scopes[0].quantity)
      || decimal(current.scopes[0].quantity)>decimal(original.scopes[0].quantity))
      return invalid('MATERIAL_RETURN_QUANTITY_UNIT_MISMATCH');
  } catch { return invalid('MATERIAL_RETURN_QUANTITY_UNIT_MISMATCH'); }
  return { detected: true,originalMovementId,issues: [] };
}
