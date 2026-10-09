import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readCumpManufacturingReceipt } from './cump-manufacturing-source';
import type { CumpJournalSource } from './cump-posting-source';

// Pure source-proof fixtures; database acceptance is tracked separately.
const ARTICLE = '00000000-0000-0000-0000-000000000001';
const MOVEMENT = '00000000-0000-0000-0000-000000000002';
const LOT = '00000000-0000-0000-0000-000000000003';
const LEVEL = '00000000-0000-0000-0000-000000000004';
const BATCH = '00000000-0000-0000-0000-000000000005';
const PT = '00000000-0000-0000-0000-000000000006';
const VERSION = '00000000-0000-0000-0000-000000000007';
const RECEIPT = '00000000-0000-0000-0000-000000000008';
function row(): CumpJournalSource {
  return { movement_id: MOVEMENT, article_id: ARTICLE, sequence: '10', source_sha256: 'a'.repeat(64), source_valid: true,
    acquisition_snapshot: null, acquisition_sha256: null, acquisition_valid: null,
    manufacturing_sha256: 'b'.repeat(64), manufacturing_valid: true, manufacturing_issues: [],
    source_snapshot: { schema_version: 1, movement_id: MOVEMENT, article_id: ARTICLE, movement_type: 'IN',
      quantity: '10', stock_unit: 'u', stock_level_id: LEVEL, stock_batch_id: BATCH, batch_owner_client_id: null,
      reversal_of_id: null, source_document_type: 'OF', source_document_id: '91', document_type: null, document_id: null,
      lines: [{ article_id: ARTICLE, lot_id: LOT, quantity: '10', unit: 'u', owner_client_id: null }] },
    manufacturing_snapshot: { schema_version: 1, movement_id: MOVEMENT, article_id: ARTICLE,
      stock_source_sha256: 'a'.repeat(64), stock_quantity: '10', stock_unit: 'u', operations: [], quantity_declarations: [],
      receipts: [{ id: RECEIPT, of_id: '91', stock_movement_id: MOVEMENT, stock_level_id: LEVEL,
        stock_batch_id: BATCH, lot_id: LOT, quantity_good: '10', quantity_scrap: '0', quantity_rework: '0',
        quality_status: 'LIBERE', of: { id: '91', article_id: ARTICLE, piece_technique_id: PT, piece_technique_version_id: VERSION },
        lot: { id: LOT, article_id: ARTICLE, owner_client_id: null } }], actual_margin: null },
  };
}
const snapshot = (source: CumpJournalSource) => source.manufacturing_snapshot as Record<string, unknown>;
const receipt = (source: CumpJournalSource) => (snapshot(source).receipts as Record<string, unknown>[])[0];

test('valid physical manufacturing proof remains explicitly unvalued until allocation is justified', () => {
  const result = readCumpManufacturingReceipt(row(), 'EUR');
  assert.equal(result.detected, true);
  assert.equal(result.proof.receipt_id, RECEIPT);
  assert.equal(result.proof.of_id, '91');
  assert.equal(result.proof.quantity_good, '10');
  assert.equal(result.proof.manufacturing_value_allocation_required, true);
  assert.ok(result.issues.includes('MANUFACTURING_VALUE_ALLOCATION_REQUIRED'));
  assert.ok(result.issues.includes('MANUFACTURING_ACTUAL_MARGIN_SOURCE_MISSING'));
  assert.equal('amount' in result.proof, false);
});

test('estimated saved margin does not become a verified inventory cost', () => {
  const source = row();
  snapshot(source).actual_margin = { id: 'margin-1', scope_type: 'OF', scope_ref: '91', basis: 'ACTUAL',
    result_snapshot: { reliability: 'ESTIMATED', cost_total_ht: '100', revenue_ht: '500' } };
  const result = readCumpManufacturingReceipt(source, 'EUR');
  assert.equal(result.proof.actual_margin_snapshot_id, 'margin-1');
  assert.equal(result.proof.actual_margin_reliability, 'ESTIMATED');
  assert.ok(result.issues.includes('MANUFACTURING_COST_BASIS_NOT_VERIFIED'));
  assert.ok(result.issues.includes('MANUFACTURING_VALUE_ALLOCATION_REQUIRED'));
});

test('invalid hash, source linkage, quantity and technical version never provide physical proof', () => {
  const invalids: CumpJournalSource[] = [];
  const hash = row(); hash.manufacturing_valid = false; invalids.push(hash);
  const link = row(); receipt(link).of_id = '92'; invalids.push(link);
  const quantity = row(); receipt(quantity).quantity_good = '9'; invalids.push(quantity);
  const version = row(); (receipt(version).of as Record<string, unknown>).piece_technique_version_id = null; invalids.push(version);
  const lot = row(); (receipt(lot).lot as Record<string, unknown>).article_id = PT; invalids.push(lot);
  for (const source of invalids) {
    const result = readCumpManufacturingReceipt(source, 'EUR');
    assert.equal(result.detected, true);
    assert.equal(result.proof.receipt_id, undefined);
    assert.ok(result.issues.length > 0);
  }
});

test('missing old capture remains unknown and a purchase receipt is not a manufacturing source', () => {
  const old = row(); old.manufacturing_snapshot = null; old.manufacturing_valid = null;
  assert.deepEqual(readCumpManufacturingReceipt(old, 'EUR').issues, ['MANUFACTURING_RECEIPT_PROOF_MISSING']);
  const purchase = row(); purchase.manufacturing_snapshot = null;
  (purchase.source_snapshot as Record<string, unknown>).source_document_type = 'RECEPTION';
  assert.equal(readCumpManufacturingReceipt(purchase, 'EUR').detected, false);
});
