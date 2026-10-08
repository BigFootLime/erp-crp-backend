import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateManufacturingCost, reverseManufacturingCost, restoreManufacturingCost } from './manufacturing-cost-allocation';

// Prepared for the final combined acceptance; not run during this increment.
test('partial receipts preserve the exact original cost including final residual',()=>{
  const initial={quantity:'3',value:'1',allocatedQuantity:'0',allocatedValue:'0'};
  const a=allocateManufacturingCost(initial,'1'),b=allocateManufacturingCost(a.after,'1');
  const c=allocateManufacturingCost(b.after,'1');
  assert.equal(a.value,'0.333333333333');assert.equal(b.value,'0.333333333334');
  assert.equal(c.value,'0.333333333333');assert.equal(c.after.allocatedValue,'1');
  assert.equal(c.after.allocatedQuantity,'3');assert.deepEqual(initial,{quantity:'3',value:'1',allocatedQuantity:'0',allocatedValue:'0'});
});
test('out of order cancellation restores its exact amount and makes it reallocatable',()=>{
  const initial={quantity:'3',value:'1',allocatedQuantity:'0',allocatedValue:'0'};
  const a=allocateManufacturingCost(initial,'1'),b=allocateManufacturingCost(a.after,'1');
  const reversed=reverseManufacturingCost(b.after,a);
  assert.equal(reversed.after.allocatedQuantity,'1');assert.equal(reversed.after.allocatedValue,b.value);
  const replacement=allocateManufacturingCost(reversed.after,'2');
  assert.equal(replacement.after.allocatedValue,'1');assert.equal(replacement.value,'0.666666666666');
  const inverseOfInverse=restoreManufacturingCost(reversed.after,a);
  assert.deepEqual(inverseOfInverse.after,b.after);assert.equal(inverseOfInverse.value,a.value);
});
test('zero cost requires an explicit known zero budget and remains exactly zero',()=>{
  const a=allocateManufacturingCost({quantity:'100',value:'0',allocatedQuantity:'0',allocatedValue:'0'},'30');
  assert.equal(a.value,'0');assert.equal(allocateManufacturingCost(a.after,'70').after.allocatedValue,'0');
});
test('invalid, excessive, rounded and inconsistent inputs are rejected',()=>{
  const budget={quantity:'3',value:'1',allocatedQuantity:'0',allocatedValue:'0'};
  for(const quantity of ['0','-1','4','1.0000000000001','NaN'])
    assert.throws(()=>allocateManufacturingCost(budget,quantity));
  assert.throws(()=>allocateManufacturingCost({...budget,quantity:'0'},'1'));
  assert.throws(()=>allocateManufacturingCost({...budget,allocatedValue:'0.1'},'1'));
  assert.throws(()=>reverseManufacturingCost({...budget,allocatedQuantity:'1',allocatedValue:'0.2'},{quantity:'1',value:'0.3'}));
  assert.throws(()=>reverseManufacturingCost({...budget,allocatedQuantity:'1',allocatedValue:'0.2'},{quantity:'1',value:'0.1'}));
  assert.throws(()=>restoreManufacturingCost({...budget,allocatedQuantity:'2',allocatedValue:'0.8'},{quantity:'1',value:'0.1'}));
});
