import { expect,it,vi } from 'vitest';
import { assertConsumableScanTx } from './consumable-scan.repository';
import type { PoolClient } from 'pg';
const id='b869dd64-cad5-47bf-ab2c-23ec678b752f';
const expected={articleId:'article',lotId:'palette-1',legacyCodes:['LOT-001']};
function tx(label:unknown){return {query:vi.fn().mockResolvedValue({rows:label?[label]:[]})} as unknown as PoolClient;}
it('accepts a canonical active palette label',async()=>{
  await expect(assertConsumableScanTx(tx({status:'ACTIVE',entity_type:'STOCK_LOT',entity_id:'palette-1'}),`CERP:1:${id}`,expected)).resolves.toBeUndefined();
});
it.each(['INVALIDATED','REPLACED'])('rejects %s labels at the write boundary',async status=>{
  await expect(assertConsumableScanTx(tx({status,entity_type:'STOCK_LOT',entity_id:'palette-1'}),`CERP:1:${id}`,expected)).rejects.toMatchObject({code:'CONSUMABLE_LABEL_INACTIVE'});
});
it('rejects another palette from the same article',async()=>{
  await expect(assertConsumableScanTx(tx({status:'ACTIVE',entity_type:'STOCK_LOT',entity_id:'palette-2'}),`CERP:1:${id}`,expected)).rejects.toMatchObject({code:'CONSUMABLE_SCAN_MISMATCH'});
});
it('preserves existing readable lot codes without a label registry lookup',async()=>{
  const db=tx(null);await assertConsumableScanTx(db,'lot-001',expected);expect(db.query).not.toHaveBeenCalled();
});
