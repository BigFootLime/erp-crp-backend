import { describe,expect,it } from 'vitest';
import { readCumpMaterialReturnOriginal } from './cump-material-return-source';
import { applyCumpReturnAllocationDelta } from './cump-return-allocation';
import { allocateCumpLinkedReturn } from './cump-linked-return';
import type { CumpJournalSource } from './cump-posting-source';
import type { CumpScope } from './cump-valuation';

const id=(n: number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const scope: CumpScope={ articleId:id(1),owner:'COMPANY',unit:'u',currency:'EUR' };
const original={ movementRef:id(2),entryRef:'stock-entry:original',scope,quantity:'3',movementValue:'1',reliability:'VERIFIED' as const };
function materialReturn() {
  const source=(movement: string,type: string,quantity: string,lot: string)=>({ schema_version:1,movement_id:movement,
    article_id:scope.articleId,movement_type:type,quantity,stock_unit:'pc',stock_batch_id:null,batch_owner_client_id:null,
    reversal_of_id:null,document_type:'OF',document_id:'91',source_document_type:'OF',source_document_id:'91',
    lines:[{ article_id:scope.articleId,quantity,unit:'u',owner_client_id:null,direction:null,lot_id:lot }] });
  const link={ id:id(7),debit_id:id(8),source_reservation_id:id(9),lot_id:id(10),need_id:id(11),
    quantity:'1.000',unit:'pc',of_id:'91',compensates_id:null,source_actual_quantity:'3.000',original_movement_id:id(2),
    original_stock_source_sha256:'b'.repeat(64),original_stock_source:source(id(2),'OUT','3',id(12)) };
  const snapshot={ schema_version:1,movement_id:id(3),stock_source_sha256:'a'.repeat(64),reversal_of_id:null,remnants:[link] };
  const row: CumpJournalSource={ sequence:'3',movement_id:id(3),article_id:scope.articleId,source_valid:true,
    source_sha256:'a'.repeat(64),source_snapshot:source(id(3),'IN','1',id(10)),acquisition_snapshot:null,
    acquisition_sha256:null,acquisition_valid:null,return_snapshot:snapshot,return_sha256:'c'.repeat(64),return_valid:true };
  return { row,link };
}
describe('material return provenance — prepared for final acceptance',()=>{
  it('uses the frozen debit source rather than a new receipt price',()=>{
    const { row }=materialReturn();
    expect(readCumpMaterialReturnOriginal(row,'EUR')).toEqual({ detected:true,originalMovementId:id(2),issues:[] });
  });
  it('rejects a changed source hash, different OF or excessive remnant quantity',()=>{
    const { row,link }=materialReturn();
    row.return_valid=false;
    expect(readCumpMaterialReturnOriginal(row,'EUR').issues).toContain('MATERIAL_RETURN_PROOF_INVALID');
    row.return_valid=true; link.of_id='92';
    expect(readCumpMaterialReturnOriginal(row,'EUR').originalMovementId).toBeNull();
    link.of_id='91'; link.source_actual_quantity='0.5';
    expect(readCumpMaterialReturnOriginal(row,'EUR').issues).toContain('MATERIAL_RETURN_QUANTITY_UNIT_MISMATCH');
  });
  it('releases an older exact allocation without losing its rounding residual',()=>{
    const first=allocateCumpLinkedReturn(original,scope,'1',{ originalMovementRef:id(2),quantity:'0',value:'0' });
    const second=allocateCumpLinkedReturn(original,scope,'1',first.cursor);
    const cancelled=applyCumpReturnAllocationDelta(original,second.cursor,'-1','-0.333333333333');
    expect(cancelled).toMatchObject({ quantity:'1',value:'0.333333333334' });
    const remainder=allocateCumpLinkedReturn(original,scope,'2',cancelled);
    expect(remainder.cost.amount).toBe('0.666666666666');
    expect(remainder.cursor).toMatchObject({ quantity:'3',value:'1' });
  });
  it('rejects an allocation release beyond quantity or its exact final amount',()=>{
    const cursor={ originalMovementRef:id(2),quantity:'1',value:'0.333333333333' };
    expect(()=>applyCumpReturnAllocationDelta(original,cursor,'-2','-0.333333333333')).toThrow('CUMP_RETURN_QUANTITY_EXCEEDED');
    expect(()=>applyCumpReturnAllocationDelta(original,cursor,'-1','-0.3')).toThrow('CUMP_RETURN_CURSOR_MISMATCH');
  });
});
