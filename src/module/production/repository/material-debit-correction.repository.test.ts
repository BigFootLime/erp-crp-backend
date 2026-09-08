import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),compensate:vi.fn(),restore:vi.fn(),sync:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
vi.mock('./operation-readiness.repository',()=>({syncMaterialOfQuantitiesTx:m.sync}));
vi.mock('../../stock/repository/material-compensation.repository',()=>({compensateMaterialMovementTx:m.compensate,restoreMaterialReservationTx:m.restore}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {correctMaterialDebit} from './material-debit-correction.repository';
const tx={query:vi.fn(),release:vi.fn()},current={version:'v'};
const body={debitId:'debit',reason:'Erreur de saisie, stock vérifié au poste',expectedVersion:'v',idempotencyKey:'key'};
let transferred=false,eligible=true;
beforeEach(()=>{vi.resetAllMocks();transferred=false;eligible=true;m.read.mockResolvedValue(current);
  m.command.mockImplementation((_id,_type,_body,_audit,fn)=>withRealtimeOutboxTransaction(tx as never,client=>fn(client,current)));
  m.compensate.mockResolvedValue({movementId:'reverse',quantity:6});
  tx.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT d.id::text')?(eligible?[{id:'debit',declaration_id:'declaration',operation_id:'cut',technical_version_id:'tech'}]:[]):
    sql.startsWith('SELECT id FROM public.production_transfer_batches')?(transferred?[{id:'transfer'}]:[]):
    sql.startsWith('SELECT s.reservation_id')?[{reservation_id:'reservation',need_id:'need',stock_movement_id:'out',lot_id:'lot',actual:6,planned:4}]:
    sql.startsWith('SELECT stock_movement_id')?[{stock_movement_id:'in',lot_id:'remnant'}]:sql.startsWith('INSERT INTO public.production_quantity_declarations')?[{id:'negative-declaration'}]:[]}));
});
it('compensates remnants first, restores the original reservation and adds negative quantity/yield proofs',async()=>{
  await correctMaterialDebit(19,body,{user_id:1} as never);
  expect(m.compensate.mock.calls.map(c=>c[1].kind)).toEqual(['REMNANT','SOURCE']);
  expect(m.restore).toHaveBeenCalledWith(tx,{reservationId:'reservation',quantity:6,reason:body.reason},{user_id:1});
  const source=tx.query.mock.calls.find(c=>c[0].includes('INSERT INTO public.production_material_debit_sources'));
  expect(source?.[1].slice(-2)).toEqual([-4,-6]);expect(m.sync).toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('COMMIT');
});
it('rejects a debit that still has transferred pieces before touching stock',async()=>{transferred=true;
  await expect(correctMaterialDebit(19,body,{user_id:1} as never)).rejects.toMatchObject({code:'MATERIAL_DEBIT_TRANSFER_ACTIVE'});expect(m.compensate).not.toHaveBeenCalled();
});
it('rejects an already corrected or closed debit',async()=>{eligible=false;
  await expect(correctMaterialDebit(19,body,{user_id:1} as never)).rejects.toMatchObject({code:'MATERIAL_DEBIT_NOT_CORRECTABLE'});expect(m.compensate).not.toHaveBeenCalled();
});
it('rolls back the remnant reversal if restoring the source reservation fails',async()=>{m.restore.mockRejectedValue(new Error('reservation expired'));
  await expect(correctMaterialDebit(19,body,{user_id:1} as never)).rejects.toThrow('reservation expired');expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(tx.query).not.toHaveBeenCalledWith('COMMIT');expect(m.sync).not.toHaveBeenCalled();
});
