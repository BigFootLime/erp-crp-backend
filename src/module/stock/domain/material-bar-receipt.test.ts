import { describe, expect, it } from 'vitest';
import { receivedMaterialBarLengths, proposeReceivedMaterialBars } from './material-bar-receipt';
import { stockReceiptSchema } from '../../receptions/validators/receptions.validators';
import { stockProcessingSchema } from '../../receptions/validators/receipt-processing.validators';
const proposal = { required:true,receiptUnit:'barre',stockUnit:'mm',coefficient:3000,quantity:2,sourceLengthMm:6000 };

describe('received physical bars', () => {
  it('retains separate bars even when all lengths have the same total', () => {
    expect(receivedMaterialBarLengths([{lengthMm:3000,count:2}],6000)).toEqual([3000,3000]);
    expect(receivedMaterialBarLengths([{lengthMm:2000,count:2},{lengthMm:1000,count:2}],6000)).toEqual([2000,2000,1000,1000]);
  });
  it('uses exact thousandths for mixed measured lengths', () => {
    expect(receivedMaterialBarLengths([{lengthMm:110.501,count:3},{lengthMm:.007,count:1}],331.51)).toEqual([110.501,110.501,110.501,.007]);
  });
  it.each([
    [[],3000], [[{lengthMm:3000,count:1}],6000], [[{lengthMm:3000,count:3}],6000],
    [[{lengthMm:3000,count:1.5}],4500], [[{lengthMm:0,count:1}],1], [[{lengthMm:NaN,count:1}],1],
    [[{lengthMm:100.0001,count:1}],100], [[{lengthMm:1,count:1001}],1001],
    [[{lengthMm:1,count:600},{lengthMm:1,count:401}],1001], [[{lengthMm:1e9,count:1000}],1e12],
  ])('rejects missing, partial, imprecise or unbounded geometry %#', (groups,total) => {
    expect(() => receivedMaterialBarLengths(groups as never,total as number)).toThrow();
  });
  it('suggests the snapshotted purchase length before the current article default', () => {
    expect(proposeReceivedMaterialBars(proposal)).toEqual({required:true,groups:[{lengthMm:3000,count:2}],source:'PURCHASE_CONVERSION'});
  });
  it('uses a known article source length for purchases in millimetres', () => {
    expect(proposeReceivedMaterialBars({...proposal,receiptUnit:'mm',coefficient:1,quantity:6000,sourceLengthMm:3000})).toEqual({required:true,groups:[{lengthMm:3000,count:2}],source:'ARTICLE'});
  });
  it.each([{quantity:1.5},{coefficient:0},{quantity:1001},{required:false},{stockUnit:'u'},
    {receiptUnit:'mm',coefficient:1,quantity:6500,sourceLengthMm:3000},
    {receiptUnit:'mm',coefficient:1,quantity:6000,sourceLengthMm:null}])('never invents a remnant or missing configuration: %j', (input) => {
    expect(proposeReceivedMaterialBars({...proposal,...input}).groups).toBeNull();
  });
  it('accepts the same strict groups through standard and tablet stock APIs', () => {
    const id='11111111-1111-4111-8111-111111111111',bars=[{lengthMm:3000,count:2}];
    const standard={body:{qty:2,dst_magasin_id:id,dst_emplacement_id:1,material_bars:bars}};
    const tablet={quantity:2,magasinId:id,emplacementId:1,expectedVersion:1,idempotencyKey:id,materialBars:bars};
    expect(stockReceiptSchema.parse(standard).body.material_bars).toEqual(bars);
    expect(stockProcessingSchema.parse(tablet).materialBars).toEqual(bars);
    expect(stockProcessingSchema.safeParse({...tablet,materialBars:[{lengthMm:3000,count:2,overrideQuality:true}]}).success).toBe(false);
    expect(stockProcessingSchema.safeParse({...tablet,materialBars:[{lengthMm:3000,count:'2'}]}).success).toBe(false);
  });
});
