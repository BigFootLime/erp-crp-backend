import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({lock:vi.fn(),prepare:vi.fn()}));
vi.mock('./material-bar-receipt.repository',()=>({lockMaterialBarReceiptLotTx:mocks.lock}));
vi.mock('./material-bar-movement.repository',()=>({prepareMaterialBarMovementTx:mocks.prepare}));
import { lockMaterialBarPostingScopeTx,prepareMaterialBarPostingTx } from './material-bar-posting.repository';
import { createMaterialBarPostingOwner } from './material-bar-posting-owner';
import { postMovementSchema } from '../validators/stock.validators';

const tx={query:vi.fn()};
const movement={id:'move',batchId:'batch',type:'IN',quantity:3000,reversalOf:null};
const command={kind:'RECEIVE' as const,expectedVersion:'a'.repeat(64),bars:[{lengthMm:3000,count:1}]};
const base={scope:{enabled:true,required:true},movement,externalTransaction:false};
beforeEach(()=>{vi.resetAllMocks();tx.query.mockResolvedValue({rows:[{tracked:false}]});mocks.prepare.mockResolvedValue({prepared:true});});
describe('canonical stock posting physical boundary',()=>{
  it('preserves non-bar stock and rejects explicit bars on incompatible units',async()=>{
    tx.query.mockResolvedValue({rows:[{millimetres:false,required:false}]});
    expect(await lockMaterialBarPostingScopeTx(tx,{articleId:'article',lotIds:[],explicit:false})).toEqual({enabled:false,required:false});
    await expect(lockMaterialBarPostingScopeTx(tx,{articleId:'article',lotIds:[],explicit:true})).rejects.toMatchObject({code:'MATERIAL_BAR_UNIT_REQUIRED'});
  });
  it('refuses a partially installed schema before any lot write',async()=>{
    tx.query.mockResolvedValueOnce({rows:[{millimetres:true,required:false}]}).mockResolvedValueOnce({rows:[{installed:true,ready:false}]});
    await expect(lockMaterialBarPostingScopeTx(tx,{articleId:'article',lotIds:['b','a'],explicit:false})).rejects.toMatchObject({code:'MATERIAL_BARS_NOT_INSTALLED'});expect(mocks.lock).not.toHaveBeenCalled();
  });
  it('takes lot/reservation locks once in a stable order before stock',async()=>{
    tx.query.mockResolvedValueOnce({rows:[{millimetres:true,required:true}]}).mockResolvedValueOnce({rows:[{installed:true,ready:true}]});
    expect(await lockMaterialBarPostingScopeTx(tx,{articleId:'article',lotIds:['b','a','b'],explicit:false})).toEqual({enabled:true,required:true});
    expect(mocks.lock.mock.calls.map(c=>c[1])).toEqual(['a','b']);
  });
  it('does not silently skip geometry on required or already tracked stock',async()=>{
    await expect(prepareMaterialBarPostingTx(tx,base)).rejects.toMatchObject({code:'MATERIAL_BAR_MOVEMENT_REQUIRED'});
    tx.query.mockResolvedValue({rows:[{tracked:true}]});
    await expect(prepareMaterialBarPostingTx(tx,{...base,scope:{enabled:true,required:false}})).rejects.toMatchObject({code:'MATERIAL_BAR_MOVEMENT_REQUIRED'});
  });
  it('cannot use an external client as a tracking bypass',async()=>{
    await expect(prepareMaterialBarPostingTx(tx,{...base,externalTransaction:true})).rejects.toMatchObject({code:'MATERIAL_BAR_MOVEMENT_REQUIRED'});
  });
  it('requires an explicit lot and transfer destination',async()=>{
    await expect(prepareMaterialBarPostingTx(tx,{...base,movement:{...movement,batchId:null},command})).rejects.toMatchObject({code:'MATERIAL_BAR_BATCH_REQUIRED'});
    await expect(prepareMaterialBarPostingTx(tx,{...base,movement:{...movement,type:'TRANSFER'},command})).rejects.toMatchObject({code:'MATERIAL_BAR_BATCH_REQUIRED'});
  });
  it('passes the requested geometry to the real movement preparer',async()=>{
    expect(await prepareMaterialBarPostingTx(tx,{...base,command})).toEqual({prepared:true});
    expect(mocks.prepare).toHaveBeenCalledWith(tx,{movementId:'move',sourceBatchId:'batch',destinationBatchId:undefined,command});
  });
  it('lets a managed receipt finish once in its outer transaction',async()=>{
    const owner=createMaterialBarPostingOwner(tx,'RECEIPT',{movementId:'move',batchId:'batch',type:'IN',quantityMm:3000});
    expect(await prepareMaterialBarPostingTx(tx,{...base,owner,externalTransaction:true})).toBeNull();expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('rejects mixed managed and generic geometry and a missing outer transaction',async()=>{
    const owner=createMaterialBarPostingOwner(tx,'RECEIPT',{movementId:'move',batchId:'batch',type:'IN',quantityMm:3000});
    for(const input of [{...base,owner},{...base,owner,command,externalTransaction:true}])
      await expect(prepareMaterialBarPostingTx(tx,input)).rejects.toMatchObject({code:'MATERIAL_BAR_POST_OWNER_INVALID'});
  });
  it('accepts the new HTTP geometry without exposing server ownership',()=>{
    expect(postMovementSchema.parse({body:{material_bars:command}}).body.material_bars).toEqual(command);
    expect(postMovementSchema.safeParse({body:{physicalBarOwner:{kind:'RECEIPT'},material_bars:command}}).success).toBe(false);
  });
});
