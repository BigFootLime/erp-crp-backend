import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AuditContext} from '../production/repository/production.repository';
import type {ExternalServicePreparation} from './subcontract-flow.types';
const mocks=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),forecast:vi.fn()}));
vi.mock('./subcontract-procurement.repository',()=>({readSubcontractProcurementTx:mocks.read}));
vi.mock('../production/repository/purchase-preparation.repository',()=>({savePurchasePreparationsTx:mocks.save}));
vi.mock('./subcontract-planning-preparation.repository',()=>({readExternalPreparationsTx:mocks.forecast}));
import {extendRecoverySupplierPreparationsTx} from './recovery-supplier-preparations.repository';
const tx={query:vi.fn()} as unknown as PoolClient,audit={user_id:1} as AuditContext;
const preparation=():ExternalServicePreparation=>({id:'prep',operationId:'op',purchaseId:'service',catalogueId:'offer',label:'Anodisation',
  supplierId:'supplier',supplierName:'Traitement',quantity:110,due:null,leadDays:3,orderLineIds:['line'],version:'old'});
const expected=()=>new Map([['op',{preparations:[preparation()],issues:[] as string[]}]]);
const current=()=>({version:'current',purchasePreparations:[{id:'prep',sourceRef:'service',supplierId:'supplier',
  service:{selection:{operationId:'op',catalogueId:'offer',due:null},forecastQuantity:110}}]});
beforeEach(()=>{vi.resetAllMocks();mocks.read.mockResolvedValue(current());
  mocks.forecast.mockResolvedValue(new Map([['op',{preparations:[{...preparation(),version:'new'}],issues:[]}]]));});
describe('persisting reviewed recovery supplier forecasts',()=>{
  it('updates the canonical preparation with a new history event, without creating or editing a purchase order',async()=>{
    expect(await extendRecoverySupplierPreparationsTx(tx,10,expected(),audit)).toEqual([{id:'prep',operation_id:'op',quantity:110,version:'new'}]);
    expect(mocks.save).toHaveBeenCalledWith(tx,current().purchasePreparations,'PRESTATION',10,'current',audit,{persistCovered:true});
    expect(tx.query).not.toHaveBeenCalled();
  });
  it.each(['supplier','quantity','catalogue'] as const)('rejects changed %s before recording the supplement',async changed=>{
    const value=current();if(changed==='supplier')value.purchasePreparations[0].supplierId='other';
    if(changed==='quantity')value.purchasePreparations[0].service.forecastQuantity=120;
    if(changed==='catalogue')value.purchasePreparations[0].service.selection.catalogueId='other';mocks.read.mockResolvedValue(value);
    await expect(extendRecoverySupplierPreparationsTx(tx,10,expected(),audit)).rejects.toMatchObject({code:'RECOVERY_SUPPLIER_PREPARATION_CHANGED'});
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('makes the caller roll back if the refreshed supplier delay differs from the reviewed proposal',async()=>{
    const value=expected();value.get('op')!.preparations[0].leadDays=7;mocks.forecast.mockResolvedValue(value);
    await expect(extendRecoverySupplierPreparationsTx(tx,10,expected(),audit)).rejects.toMatchObject({code:'RECOVERY_SUPPLIER_PREPARATION_CHANGED'});
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it('does not touch unrelated purchasing on an internal-only recovery',async()=>{
    expect(await extendRecoverySupplierPreparationsTx(tx,10,new Map(),audit)).toEqual([]);expect(mocks.read).not.toHaveBeenCalled();
  });
});
