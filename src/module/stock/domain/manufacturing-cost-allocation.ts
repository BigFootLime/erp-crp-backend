import { parseCumpDecimal as decimal, formatCumpDecimal as text, roundCumpRatio } from './cump-decimal';

export type ManufacturingCostBudget = {
  quantity: string; value: string; allocatedQuantity: string; allocatedValue: string;
};
export type ManufacturingCostAllocation = {
  quantity: string; value: string; before: ManufacturingCostBudget; after: ManufacturingCostBudget;
};

function readBudget(budget: ManufacturingCostBudget) {
  const quantity=decimal(budget.quantity),value=decimal(budget.value);
  const allocatedQuantity=decimal(budget.allocatedQuantity),allocatedValue=decimal(budget.allocatedValue);
  if(quantity<=0n||allocatedQuantity>quantity||allocatedValue>value
    ||(allocatedQuantity===0n&&allocatedValue!==0n)
    ||(allocatedQuantity===quantity&&allocatedValue!==value)) throw new Error('MANUFACTURING_COST_BUDGET_INVALID');
  return {quantity,value,allocatedQuantity,allocatedValue};
}

/** Apply against remaining quantity/value. The last receipt receives the exact
 * residual; multiplying a rounded unit cost cannot preserve this invariant. */
export function allocateManufacturingCost(budget: ManufacturingCostBudget, receiptQuantity: string): ManufacturingCostAllocation {
  const b=readBudget(budget),quantity=decimal(receiptQuantity);
  const remainingQuantity=b.quantity-b.allocatedQuantity,remainingValue=b.value-b.allocatedValue;
  if(quantity<=0n||quantity>remainingQuantity) throw new Error('MANUFACTURING_COST_QUANTITY_EXCEEDED');
  const value=quantity===remainingQuantity?remainingValue:roundCumpRatio(remainingValue*quantity,remainingQuantity);
  return {quantity:text(quantity),value:text(value),before:{...budget},after:{...budget,
    allocatedQuantity:text(b.allocatedQuantity+quantity),allocatedValue:text(b.allocatedValue+value)}};
}

/** Restore the exact original net allocation. The persistent event ledger must
 * establish which event is being reversed and prevent a second application. */
export function reverseManufacturingCost(budget: ManufacturingCostBudget, allocation: Pick<ManufacturingCostAllocation,'quantity'|'value'>): ManufacturingCostAllocation {
  const b=readBudget(budget),quantity=decimal(allocation.quantity),value=decimal(allocation.value);
  if(quantity<=0n||quantity>b.allocatedQuantity||value>b.allocatedValue)
    throw new Error('MANUFACTURING_COST_REVERSAL_EXCEEDED');
  const after={...budget,allocatedQuantity:text(b.allocatedQuantity-quantity),allocatedValue:text(b.allocatedValue-value)};
  readBudget(after);
  return {quantity:text(quantity),value:text(value),before:{...budget},after};
}

/** An inverse of an inverse restores the original amount, not a new allocation
 * at a changed remaining unit cost. Its ancestry must be proven by the ledger. */
export function restoreManufacturingCost(budget: ManufacturingCostBudget, allocation: Pick<ManufacturingCostAllocation,'quantity'|'value'>): ManufacturingCostAllocation {
  const b=readBudget(budget),quantity=decimal(allocation.quantity),value=decimal(allocation.value);
  if(quantity<=0n||quantity>b.quantity-b.allocatedQuantity||value>b.value-b.allocatedValue)
    throw new Error('MANUFACTURING_COST_RESTORE_EXCEEDED');
  const after={...budget,allocatedQuantity:text(b.allocatedQuantity+quantity),allocatedValue:text(b.allocatedValue+value)};
  readBudget(after);
  return {quantity:text(quantity),value:text(value),before:{...budget},after};
}
