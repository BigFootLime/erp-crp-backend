import {HttpError} from '../../../utils/httpError';

/** Canonical reservations retain the original entitlement. Consumed units are
 * removed from physical reserved stock, while the unconsumed remainder stays. */
export function partialReservationConsumption(f:{reserved:number;consumed:number;prepared:number;quantity:number}){
  for(const value of Object.values(f))if(!Number.isFinite(value)||value<0||Math.abs(value*1000-Math.round(value*1000))>1e-6)
    throw new HttpError(422,'RESERVATION_QUANTITY_INVALID','La quantité doit être positive et exprimée avec trois décimales au maximum.');
  const milli=(n:number)=>Math.round(n*1000);
  const reserved=milli(f.reserved),consumed=milli(f.consumed),prepared=milli(f.prepared),quantity=milli(f.quantity);
  if(!quantity||consumed+prepared>reserved||quantity>reserved-consumed)
    throw new HttpError(409,'RESERVATION_QUANTITY_EXCEEDED','La quantité dépasse le reliquat de cette réservation.');
  return {consumed:(consumed+quantity)/1000,prepared:Math.max(0,prepared-quantity)/1000,
    remaining:(reserved-consumed-quantity)/1000,unreserve:quantity/1000,status:consumed+quantity===reserved?'CONSUMED' as const:'ACTIVE' as const};
}
