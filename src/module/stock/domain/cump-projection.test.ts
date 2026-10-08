import { describe, expect, it } from 'vitest';
import { reconcileCumpOpenings, type CumpOpeningRow } from './cump-opening';
import { readCumpPostingSource, checkCumpTransferGroup, type CumpJournalSource } from './cump-posting-source';
import { allocateCumpLinkedReturn } from './cump-linked-return';
import { applyCumpTransition, type CumpScope } from './cump-valuation';

const article = '985c0e4c-ec2e-4a55-bb21-64d6beea5a96';
const level = '0491c5c8-8500-4d88-a94f-177054c6677c';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const scope: CumpScope = { articleId: article,owner: 'COMPANY',unit: 'u',currency: 'EUR' };
const opening = (n: number,total: string,batch: number | null = null,owner: string | null = null): CumpOpeningRow => ({
  id: id(n),stock_level_id: level,stock_batch_id: batch===null ? null : id(batch),article_id: article,source_valid: true,
  source_snapshot: { schema_version: 1,kind: batch===null ? 'LEVEL' : 'BATCH',stock_level_id: level,
    stock_batch_id: batch===null ? null : id(batch),article_id: article,stock_unit: 'pc',
    quantity_total: total,quantity_reserved: '30',quantity_depreciated: '0',owner_client_id: owner } });
const journal = (n: number,type: string,qty = '10',parent: string | null = null): CumpJournalSource => ({
  sequence: String(n),movement_id: id(n),article_id: article,source_valid: true,source_sha256: 'a'.repeat(64),
  acquisition_snapshot: null,acquisition_sha256: null,acquisition_valid: null,
  source_snapshot: { schema_version: 1,movement_id: id(n),article_id: article,movement_type: type,
    quantity: qty,stock_unit: 'pc',stock_batch_id: null,batch_owner_client_id: null,reversal_of_id: null,
    document_type: parent ? 'STOCK_TRANSFER_INTERNAL' : null,document_id: parent,
    lines: [{ article_id: article,quantity: qty,unit: 'u',owner_client_id: null,direction: null }] } });

describe('CUMP projection proofs — prepared for the final combined recipe',()=>{
  it('does not add LEVEL to BATCH or deduct reserved quantities from value',()=>{
    const result = reconcileCumpOpenings([opening(1,'100'),opening(2,'60',20),opening(3,'40',21,'CLI-001')],'EUR');
    expect(result.blockedArticleIds).toEqual([]);
    expect(result.openings.map(item=>[item.state.scope.owner,item.state.quantity,item.state.value]).sort()).toEqual([
      ['CLIENT:CLI-001','40',null],['COMPANY','60',null] ]);
  });
  it('blocks the article when batch quantities exceed their level instead of inventing company value',()=>{
    expect(reconcileCumpOpenings([opening(1,'20'),opening(2,'30',20)],'EUR').blockedArticleIds).toEqual([article]);
    expect(reconcileCumpOpenings([opening(2,'30',20)],'EUR').issues[0].code).toBe('OPENING_LEVEL_MISSING');
  });
  it('preserves negative usable opening quantities with unknown value',()=>{
    const result = reconcileCumpOpenings([opening(1,'-2')],'EUR');
    expect(result.openings[0].state).toMatchObject({ quantity: '-2',value: null,reliability: 'UNKNOWN' });
  });
  it('keeps owner codes and rejects folding opposite adjustment signs into one quantity',()=>{
    const row = journal(4,'ADJUSTMENT','10');
    (row.source_snapshot as { lines: unknown[] }).lines = [
      { article_id: article,quantity: '6',unit: 'u',owner_client_id: 'CLI-001',direction: 'IN' },
      { article_id: article,quantity: '4',unit: 'u',owner_client_id: null,direction: 'OUT' } ];
    expect(readCumpPostingSource(row,'EUR').issues).toContain('STOCK_POSTING_LINE_SIGN_MISMATCH');
    expect(readCumpPostingSource(journal(5,'IN'),'EUR').posting?.scopes[0].quantity).toBe('10');
  });
  it('reads a negative adjustment header with its real positive OUT line',()=>{
    const row = journal(6,'ADJUSTMENT','-10');
    (row.source_snapshot as { lines: unknown[] }).lines = [
      { article_id: article,quantity: '10',unit: 'u',owner_client_id: null,direction: 'OUT' } ];
    expect(readCumpPostingSource(row,'EUR').posting).toMatchObject({ kind: 'ISSUE',scopes: [{ quantity: '10' }] });
    (row.source_snapshot as { lines: unknown[] }).lines = [
      { article_id: article,quantity: '10',unit: 'u',owner_client_id: null,direction: 'IN' } ];
    expect(readCumpPostingSource(row,'EUR').posting).toBeNull();
  });
  it('requires the whole parent/out/in bundle before declaring an internal transfer neutral',()=>{
    const rows = [journal(10,'TRANSFER'),journal(11,'OUT','10',id(10)),journal(12,'IN','10',id(10))];
    const group = rows.map(row=>readCumpPostingSource(row,'EUR').posting!);
    expect(checkCumpTransferGroup(group[1],group)).toBe(true);
    expect(checkCumpTransferGroup(group[1],group.slice(0,2))).toBe(false);
    expect(checkCumpTransferGroup(group[1],[...group.slice(0,2),{ ...group[2],scopes: [{ scope,quantity: '9' }] }])).toBe(false);
  });
  it('allocates the exact original return value with a final rounding residual and a cumulative cap',()=>{
    const original = { movementRef: id(20),entryRef: 'stock-entry:original',scope,quantity: '3',movementValue: '1',reliability: 'VERIFIED' as const };
    const first = allocateCumpLinkedReturn(original,scope,'1',{ originalMovementRef: id(20),quantity: '0',value: '0' });
    const second = allocateCumpLinkedReturn(original,scope,'1',first.cursor);
    const last = allocateCumpLinkedReturn(original,scope,'1',second.cursor);
    expect([first.cost.amount,second.cost.amount,last.cost.amount]).toEqual(['0.333333333333','0.333333333334','0.333333333333']);
    expect(last.cursor).toMatchObject({ quantity: '3',value: '1' });
    expect(()=>allocateCumpLinkedReturn(original,scope,'1',last.cursor)).toThrow('CUMP_RETURN_QUANTITY_EXCEEDED');
    expect(()=>allocateCumpLinkedReturn(original,scope,'1',{ ...first.cursor,value: '1.1' })).toThrow('CUMP_RETURN_CURSOR_MISMATCH');
  });
  it('retains exact value after an older return is cancelled out of order',()=>{
    const original = { movementRef: id(20),entryRef: 'stock-entry:original',scope,quantity: '3',movementValue: '1',reliability: 'VERIFIED' as const };
    const next = allocateCumpLinkedReturn(original,scope,'1',{
      originalMovementRef: id(20),quantity: '1',value: '0.333333333334' });
    expect(next.cost.amount).toBe('0.333333333333');
    expect(allocateCumpLinkedReturn(original,scope,'1',next.cursor).cursor).toMatchObject({ quantity: '3',value: '1' });
  });
  it('reverses a receipt using its original value rather than today’s average',()=>{
    const result = applyCumpTransition({ scope,quantity: '20',value: '100',reliability: 'DECLARED',sourceRef: 'entry:mixed' },
      { scope,kind: 'RECEIPT_REVERSAL',quantity: '5',movementRef: 'entry:reverse',originalMovementRef: 'receipt:old',
        cost: { amount: '10',reliability: 'DECLARED',sourceRef: 'entry:original' } });
    expect(result).toMatchObject({ quantityDelta: '-5',valueDelta: '-10',movementValue: '10',after: { quantity: '15',value: '90' } });
  });
  it('does not publish an impossible negative value after a receipt reversal',()=>{
    expect(applyCumpTransition({ scope,quantity: '5',value: '10',reliability: 'DECLARED',sourceRef: 'entry:prior' },
      { scope,kind: 'RECEIPT_REVERSAL',quantity: '1',movementRef: 'entry:reverse',originalMovementRef: 'receipt:old',
        cost: { amount: '20',reliability: 'DECLARED',sourceRef: 'entry:original' } })).toMatchObject({
      after: { quantity: '4',value: null,reliability: 'UNKNOWN' },issues: ['NEGATIVE_STOCK_VALUE'] });
  });
});
