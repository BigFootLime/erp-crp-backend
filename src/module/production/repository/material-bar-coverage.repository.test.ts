import { describe, expect, it, vi } from 'vitest';
import { readMaterialBarCoverageTx } from './material-bar-coverage.repository';

const batch = { id:'batch', unit:'mm', physicalMm:400, reservedMm:200, revision:1, recordedMovements:'1', currentMovements:'1' };
const bars = [{id:'bar1',batchId:'batch',lengthMm:200,version:1},{id:'bar2',batchId:'batch',lengthMm:200,version:1}];
const reservations = [{id:'r',batchId:'batch',remainingMm:200,version:1}];
const holds = [{batchId:'batch',barId:'bar1',reservationId:'r',remainingMm:200}];
function db(change={}, inventoryBars=bars) {
  const query=vi.fn();
  for(const rows of [[{installed:true}],[{...batch,...change}],inventoryBars,reservations,holds])query.mockResolvedValueOnce({rows});
  return {query};
}
describe('OF physical bar inventory read model',()=>{
  it('loads a consistent inventory in five queries for the whole OF, independent of the batch count',async()=>{
    const tx=db(),result=await readMaterialBarCoverageTx(tx,['batch','other']);
    expect(result.batch).toMatchObject({status:'CONFIRMED',warning:null,bars,holds});
    expect(tx.query).toHaveBeenCalledTimes(5);
    for(const [,args] of tx.query.mock.calls.slice(1))expect(args).toEqual([['batch','other']]);
  });
  it.each([
    [{revision:null,recordedMovements:null},'UNCONFIRMED',/Confirmez/],
    [{currentMovements:'3'},'REVIEW_REQUIRED',/mouvement/],
    [{unit:'kg'},'REVIEW_REQUIRED',/millimètres/],
    [{physicalMm:500},'REVIEW_REQUIRED',/longueurs/],
    [{reservedMm:201},'REVIEW_REQUIRED',/réservations/],
  ])('rejects unknown, stale or mismatched geometry: %j',async(change,status,warning)=>{
    const result=await readMaterialBarCoverageTx(db(change),['batch']);
    expect(result.batch.status).toBe(status);expect(result.batch.warning).toMatch(warning as RegExp);
  });
  it('changes the version after a bar changes even when canonical balances remain equal',async()=>{
    const before=await readMaterialBarCoverageTx(db(),['batch']);
    const after=await readMaterialBarCoverageTx(db({},bars.map(b=>({...b,version:2}))),['batch']);
    expect(after.batch.status).toBe('CONFIRMED');expect(after.batch.version).not.toBe(before.batch.version);
  });
  it('does not query absent geometry tables or request geometry for an empty scope',async()=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[{installed:false}]})};
    expect(await readMaterialBarCoverageTx(tx,[])).toEqual({});expect(tx.query).not.toHaveBeenCalled();
    expect(await readMaterialBarCoverageTx(tx,['batch'])).toEqual({});expect(tx.query).toHaveBeenCalledTimes(1);
  });
});
