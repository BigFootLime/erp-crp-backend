import { beforeEach,describe,it,expect,vi } from "vitest";
const update=vi.hoisted(()=>vi.fn());
vi.mock('../../fournisseurs/repository/fournisseurs.repository',()=>({repoUpdateFournisseurCatalogueItem:update}));
import { applyAcknowledgementPricesTx } from './supplier-acknowledgement.repository';
import type { AuditContext } from './commande-fournisseur.repository';
const audit={user_id:1} as AuditContext;
const line={id:'line',catalogue_id:'cat',article_id:'article',unite:'u',quantite:20,prix_unitaire_ht:10,frais_ht:5,fournisseur_id:'supplier',devise:'EUR'};
let catalogue:Record<string,unknown>,query:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  update.mockReset();update.mockResolvedValue({id:'cat'});
  catalogue={id:'cat',actif:true,version:'v1',unite:'u',devise:'EUR',prix_unitaire:10,prix_multiple:1,price_tiers:[{qty_min:10,qty_max:null,unit_price:8}]};
  query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM public.commande_fournisseur_ligne')?[line]:sql.includes('FROM public.fournisseur_catalogue')?[catalogue]:[]}));
});
describe('confirmation des prix AR',()=>{
  it('corrige la commande sans modifier implicitement le catalogue',async()=>{
    const result=await applyAcknowledgementPricesTx({query} as never,'order',[{ligne_id:'line',prix_unitaire_ht:7}],audit);
    expect(update).not.toHaveBeenCalled();expect(result).toHaveLength(1);
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['line',7,null,1]);
  });
  it('actualise uniquement le palier applicable, avec la même transaction',async()=>{
    const tx={query};await applyAcknowledgementPricesTx(tx as never,'order',[{ligne_id:'line',prix_unitaire_ht:7,update_catalogue:true,expected_catalogue_updated_at:'v1'}],audit);
    expect(update).toHaveBeenCalledWith('supplier','cat',{price_tiers:[{qty_min:10,qty_max:null,unit_price:7}]},audit,tx);
  });
  it.each([{version:'v2'},{unite:'kg'},{devise:'USD'},{actif:false},{prix_multiple:100}])('refuse un catalogue périmé ou incompatible %j',async(patch)=>{
    Object.assign(catalogue,patch);
    await expect(applyAcknowledgementPricesTx({query} as never,'order',[{ligne_id:'line',prix_unitaire_ht:7,update_catalogue:true,expected_catalogue_updated_at:'v1'}],audit)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();expect(query.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE'))).toBe(false);
  });
  it('refuse une ligne absente ou étrangère avant toute écriture',async()=>{
    query.mockResolvedValue({rows:[]});
    await expect(applyAcknowledgementPricesTx({query} as never,'order',[{ligne_id:'foreign',prix_unitaire_ht:7}],audit)).rejects.toMatchObject({code:'AR_LINE_CHANGED'});
    expect(update).not.toHaveBeenCalled();
  });
});
