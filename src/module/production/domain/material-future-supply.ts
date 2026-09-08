import {quantity} from './of-material';

/** All arguments use the stock unit, including older purchase-unit allocations.
 * A receipt fulfils an allocation; it is never subtracted a second time. */
export function futureSupplyBalance(input:{ordered:number;cancelled:number;coefficient:number;assigned:number;received:number}){
  if(Object.values(input).some(n=>!Number.isFinite(n)||n<0)||input.coefficient<=0||input.cancelled>input.ordered)
    throw new Error('Invalid future supply quantities');
  const capacity=quantity((input.ordered-input.cancelled)*input.coefficient);
  return {capacity,available:Math.max(0,quantity(capacity-Math.max(input.assigned,input.received))),
    unassignedReceived:Math.max(0,quantity(input.received-input.assigned))};
}
