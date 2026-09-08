import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {commandMaterialTransfer} from './material-transfer.repository';
const tx={query:vi.fn(),release:vi.fn()};
const body={debitId:'debit',successorOperationId:'next',action:'RELEASE' as const,quantity:10,reason:'Bruts vérifiés au poste suivant',expectedVersion:'v',idempotencyKey:'key'};
let good=20,released=0,processed=0,status='READY',minimum=1;
beforeEach(()=>{vi.resetAllMocks();good=20;released=0;processed=0;status='READY';minimum=1;
  m.command.mockImplementation((_id,_type,_body,_audit,fn)=>withRealtimeOutboxTransaction(tx as never,fn));m.read.mockResolvedValue({version:'next'});
  tx.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT operation_id')?[{operation_id:'cut'}]:
    sql.startsWith('SELECT id::text,phase')?[{id:'cut',phase:10},{id:'next',phase:20}]:
    sql.startsWith('SELECT substring')?[{successor:'next',minimum}]:sql.startsWith('SELECT q.qty_good')?[{good,released,edge_released:released}]:
    sql.includes('INSERT INTO public.production_transfer_batches')?[{id:'batch'}]:sql.startsWith('SELECT o.status')?[{status,processed}]:
    sql.startsWith('SELECT id::text,released_quantity')?[{id:'batch',released}]:[]}));
});
it('releases previously retained WIP and writes its immutable event in the same transaction',async()=>{
  await commandMaterialTransfer(19,body,{user_id:1} as never);
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO public.production_material_transfer_events'),['batch','key',10,body.reason,1]);
  expect(tx.query).toHaveBeenCalledWith('COMMIT');
});
it('cannot spend the same ten pieces twice across successor transfers',async()=>{released=15;
  await expect(commandMaterialTransfer(19,body,{user_id:1} as never)).rejects.toMatchObject({code:'MATERIAL_TRANSFER_QUANTITY_EXCEEDED'});
  expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
});
it('enforces the minimum using the already released edge quantity',async()=>{minimum=25;
  await expect(commandMaterialTransfer(19,body,{user_id:1} as never)).rejects.toMatchObject({code:'MATERIAL_TRANSFER_MINIMUM'});
});
it('returns only WIP not yet used and preserves an immutable return event',async()=>{released=20;
  await commandMaterialTransfer(19,{...body,action:'RETURN'},{user_id:1} as never);
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('SET released_quantity=released_quantity-$2'),['batch',10]);
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining("'RETURN'"),['batch','key',10,body.reason,1]);
});
it.each([{state:'RUNNING',qty:0},{state:'READY',qty:1}])('blocks return after downstream use: $state/$qty',async({state,qty})=>{released=20;status=state;processed=qty;
  await expect(commandMaterialTransfer(19,{...body,action:'RETURN'},{user_id:1} as never)).rejects.toMatchObject({code:'MATERIAL_TRANSFER_ALREADY_USED'});
  expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
});
