import { expect, it, vi } from 'vitest';
import { resolveCumpAcquisitionTx } from './cump-projection.repository';
import * as sql from './cump-projection.sql';
import type { CumpJournalSource } from '../domain/cump-posting-source';

const id = '0491c5c8-8500-4d88-a94f-177054c6677c';
const article = '985c0e4c-ec2e-4a55-bb21-64d6beea5a96';
const snapshot = { schema_version: 1, movement_id: id, article_id: article, stock_quantity: '3', stock_unit: 'u', owner_client_id: null,
  source_document_id: id, stock_lines: [{ article_id: article, quantity: '3', unit: 'u', owner_client_id: null }], portions: [],
  receipts: [{ receipt_stock_id: id, receipt_line_id: id, reception_id: id, line_reception_id: id,
    receipt_quantity: '3', stock_article_id: article, receipt_article_id: article, stock_unit: 'u', receipt_unit: 'u', conversion_coefficient: '1',
    receipt_order_id: id, receipt_supplier_id: id, order: { id, line_id: id, article_id: article, status: 'ACCUSE_RECU', line_status: 'ACTIVE', unit: 'u', currency: 'EUR',
      quantity: '9', unit_price: '1', discount_percent: '0', additional_fees: '0', transport_fees: '0', supplier_id: id } }] };

it('poisons a cursor when a formerly positive transport basis disappears; never silently drops its allocation', async () => {
  const query = vi.fn(async (statement: string) => {
    if (statement === sql.CUMP_FEE_CURSOR_SQL) return { rows: [{ quantity: '3', basis_snapshot: { quantity: '9', additionalFees: '0', unit: 'u', currency: 'EUR',
      transportFees: '1', transportBasisSha256: 'a'.repeat(64), transportLineAmount: '1' }, poisoned: false, source_valid: true }] };
    if (statement === sql.CUMP_FEE_HISTORY_GAP_SQL) return { rows: [{ missing: false }] };
    return { rows: [] };
  });
  const row: CumpJournalSource = { sequence: '2', movement_id: id, article_id: article, source_snapshot: {}, source_sha256: 'a'.repeat(64), source_valid: true,
    acquisition_snapshot: snapshot, acquisition_sha256: 'b'.repeat(64), acquisition_valid: true };
  const result = await resolveCumpAcquisitionTx({ query } as unknown as Parameters<typeof resolveCumpAcquisitionTx>[0], row, 'EUR');
  expect(result.cost.amount).toBeNull();
  expect(result.issues).toContain('ACQUISITION_FEE_BASE_CHANGED');
  expect(query).toHaveBeenCalledWith(sql.CUMP_STORE_FEE_CURSOR_SQL, [id, '6', expect.any(String), true]);
});
