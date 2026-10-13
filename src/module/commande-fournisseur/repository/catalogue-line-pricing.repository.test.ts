import { describe, it, expect, vi } from 'vitest';
import { assertCatalogueMinimumsTx,readCatalogueOrderQuantityTx,readCatalogueLinePriceTx } from './catalogue-line-pricing.repository';
const line={catalogue_id:'catalogue-A',article_id:'treatment-A',unite:'u',quantite:2};
const offer={id:line.catalogue_id,article_id:line.article_id,unite:'u',devise:'EUR',order_currency:'EUR',version:'v1',
  prix_unitaire:6,forfait_ht:20,minimum_facturation_ht:30,moq:4,price_tiers:[],prix_multiple:1,pricing_basis:'NONE'};
describe('minimum catalogue de la commande',()=>{
  it('accepte les deux origines18+2 sur une référence',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{...line,quantite:18,minimum:4},{...line,minimum:4}]});
    await expect(assertCatalogueMinimumsTx({query},'order-A')).resolves.toBeUndefined();
    expect(query.mock.calls[0][1]).toEqual(['order-A']);
    expect(query.mock.calls[0][0]).toContain("l.statut_ligne='ACTIVE'");
    expect(query.mock.calls[0][0]).toContain('l.qty_annulee');
  });
  it('refuse le reliquat2 après annulation de la ligne18',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{...line,quantite:0,minimum:4},{...line,minimum:4}]});
    await expect(assertCatalogueMinimumsTx({query},'order-A')).rejects.toMatchObject({code:'CATALOGUE_MINIMUM_QUANTITY'});
  });
  it.each([{catalogue_id:'catalogue-B'},{article_id:'treatment-B'},{unite:'kg'}])('refuse la couverture par une autre référence %s',different=>{
    const query=vi.fn().mockResolvedValue({rows:[{...line,minimum:4},{...line,...different,quantite:18,minimum:4}]});
    return expect(assertCatalogueMinimumsTx({query},'order-A')).rejects.toMatchObject({code:'CATALOGUE_MINIMUM_QUANTITY'});
  });
  it('exclut la ligne modifiée et isole commande,catalogue,article et unité',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{quantity:18}]});
    expect(await readCatalogueOrderQuantityTx({query},'order-A',line,'line-edited')).toBe(20);
    expect(query.mock.calls[0][1]).toEqual(['order-A','catalogue-A','treatment-A','u','line-edited']);
  });
  it('déduit aussi la quantité annulée de la ligne en cours de modification',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[offer]}).mockResolvedValueOnce({rows:[{quantity:2}]});
    await expect(readCatalogueLinePriceTx({query},'order-A',{...line,qty_annulee:1},{excludeLineId:'line-edited'}))
      .rejects.toMatchObject({code:'CATALOGUE_MINIMUM_QUANTITY'});
  });
  it('tarife une petite origine dans un batch20 sans ajouter de quantité ni supprimer le minimum figé',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[offer]});
    const result=await readCatalogueLinePriceTx({query},'order-A',line,{orderQuantity:20});
    expect(result.snapshot.moq).toBe(4);expect(result.price.net_ht).toBe(32);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('refuse une unité ou une devise étrangères malgré une quantité globale20',async()=>{
    for(const wrong of [{unite:'kg'},{order_currency:'USD'}]){
      const query=vi.fn().mockResolvedValue({rows:[{...offer,...wrong}]});
      await expect(readCatalogueLinePriceTx({query},'order-A',line,{orderQuantity:20})).rejects.toMatchObject({code:'CATALOGUE_UNIT_MISMATCH'});
    }
  });
});
