import { describe,expect,it } from 'vitest';
import { deliveryStockRecoveryParams,deliveryStockRecoveryBody,deliveryStockRecoveryKey } from './delivery-stock-recovery.validators';
describe('delivery recovery strict request',()=>{
  it('accepts only identity, fresh fingerprint and auditable reason',()=>{
    expect(deliveryStockRecoveryParams.parse({allocationId:'96'})).toEqual({allocationId:96});
    expect(deliveryStockRecoveryBody.parse({preview_hash:'a'.repeat(64),reason:'  Réservation du restant  '})).toEqual({preview_hash:'a'.repeat(64),reason:'Réservation du restant'});
  });
  it('refuses caller supplied quantity, stock, client and extra parameters',()=>{
    for(const extra of [{qty:3},{stock_batch_id:'x'},{client_id:'other'}])
      expect(deliveryStockRecoveryBody.safeParse({preview_hash:'a'.repeat(64),reason:'Reprise',...extra}).success).toBe(false);
    expect(deliveryStockRecoveryParams.safeParse({allocationId:'96',id:'x'}).success).toBe(false);
  });
  it('refuses malformed fingerprints, unsafe identities and missing command key',()=>{
    expect(deliveryStockRecoveryBody.safeParse({preview_hash:'x',reason:'Reprise'}).success).toBe(false);
    for(const value of ['-1','1.2','9007199254740992']) expect(deliveryStockRecoveryParams.safeParse({allocationId:value}).success).toBe(false);
    expect(deliveryStockRecoveryKey.safeParse(undefined).success).toBe(false);
  });
});
