import {quantity} from './of-material';

/** All arguments use the stock unit, including older purchase-unit allocations.
 * A receipt fulfils an allocation; it is never subtracted a second time. */
export function futureSupplyBalance(input:{ordered:number;cancelled:number;coefficient:number;assigned:number;received:number;allocationEnd?:number}){
  if([input.ordered,input.cancelled,input.coefficient,input.assigned,input.received,input.allocationEnd??input.assigned].some(n=>!Number.isFinite(n)||n<0)||input.coefficient<=0||input.cancelled>input.ordered)
    throw new Error('Invalid future supply quantities');
  const capacity=quantity((input.ordered-input.cancelled)*input.coefficient);
  return {capacity,available:Math.max(0,quantity(capacity-Math.max(input.allocationEnd??input.assigned,input.received))),
    unassignedReceived:Math.max(0,quantity(input.received-input.assigned))};
}

/** Intersect a receipt's physical quantity interval with a promised interval.
 * A prior quarantined receipt must not consume a later recipient's entitlement. */
export function receivedAllocationQuantity(receiptStart:number,receiptQuantity:number,allocationStart:number,assigned:number){
  if([receiptStart,receiptQuantity,allocationStart,assigned].some(n=>!Number.isFinite(n)||n<0))throw new Error('Invalid receipt interval');
  return Math.max(0,quantity(Math.min(receiptStart+receiptQuantity,allocationStart+assigned)-Math.max(receiptStart,allocationStart)));
}
