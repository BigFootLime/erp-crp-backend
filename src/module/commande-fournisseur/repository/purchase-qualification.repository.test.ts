import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {readPurchaseQualificationTx} from './purchase-qualification.repository';
import {supplierQualityDefault} from './supplier-quality-settings.repository';

describe('réglage des contrôles qualité fournisseur',()=>{
  it('désactive le contrôle par défaut sur les sites Croix Rousse seulement',()=>{
    expect(supplierQualityDefault('cerp_prod')).toBe(false);
    expect(supplierQualityDefault('cerp_test')).toBe(false);
    expect(supplierQualityDefault('entreprise-dediee')).toBe(true);
  });

  it('saute les décisions fournisseur et les agréments client lorsqu’un administrateur désactive le contrôle',async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{fournisseur_id:'supplier',today:'2026-11-09',checked_at:'2026-11-09T12:00:00Z'}]})
      .mockResolvedValueOnce({rows:[{value_json:{enabled:false},updated_at:'2026-11-09'}]});
    const result=await readPurchaseQualificationTx({query} as unknown as PoolClient,'order',true);
    expect(result).toMatchObject({enabled:false,can_engage:true,domains:[]});
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('FOR SHARE');
  });

  it('applique de nouveau le refus fournisseur lorsque le contrôle est activé',async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{fournisseur_id:'supplier',today:'2026-11-09',checked_at:'2026-11-09T12:00:00Z'}]})
      .mockResolvedValueOnce({rows:[{value_json:{enabled:true},updated_at:'2026-11-09'}]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{id:'supplier'}]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{id:'decision',domaine_code:null,statut:'suspendu'}]});
    await expect(readPurchaseQualificationTx({query} as unknown as PoolClient,'order',true))
      .rejects.toMatchObject({code:'SUPPLIER_HOMOLOGATION_NOT_VALID'});
  });
});
