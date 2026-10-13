import {describe,it,expect} from 'vitest';
import {snapshotFromLegacySupplierFreeze} from './supplier-po-legacy-document';
const payload={type:'BON_DE_COMMANDE_FOURNISSEUR',version:1,code:'BCF-TEST',statut:'APPROUVEE',
  fournisseur:{id:'b4ef174e-9fd4-4571-86af-97ee6a63e639',code:'TEST-TR',nom:'TEST — Traitements'},
  devise:'EUR',date_besoin:'2026-10-15',incoterm:'EXW',conditions_paiement:'Virement30j',
  mode_transport:'Atelier',commentaire_public:'Selon planTEST-A indiceA',general_terms:null,
  lignes:[{position:1,reference_fournisseur:'TR-TEST',designation:'Traitement origine18',unite:'U',quantite:18,prix_unitaire_ht:6,remise_pct:0,tva_pct:20,net_ht:128,date_besoin:'2026-10-15'},
    {position:2,reference_fournisseur:'TR-TEST',designation:'Traitement origine2',unite:'U',quantite:2,prix_unitaire_ht:6,remise_pct:0,tva_pct:20,net_ht:32,date_besoin:'2026-10-15'}],
  totaux:{total_ht:160,total_remise:0,total_tva:32,frais_port_ht:0,total_ttc:192},note_interne:'MUST NOT BE EXPORTED'};
const identity={issuer:{name:'Fixture CRP'},supplierAddress:{street:'Adresse vérifiée maintenant',house_number:'1',postal_code:'69000',city:'Lyon',country:'France'},issuedAt:'2026-10-13T07:00:00Z'};
describe('first corrective PDF for a legacy frozen supplier order',()=>{
  it('preserves18+2 and6EUR, conditions and frozen dates without reading mutable order rows',()=>{
    const s=snapshotFromLegacySupplierFreeze(payload,identity);
    expect(s.lines.map(l=>[l.quantity,l.unit_price_ht,l.net_ht])).toEqual([['18','6','128'],['2','6','32']]);
    expect(s.totals.total_ttc).toBe('192');expect(s.need_date).toBe('2026-10-15');
    expect(s.payment_terms).toBe('Virement30j');expect(s.public_comment).toBe('Selon planTEST-A indiceA');
    expect(s).not.toHaveProperty('note_interne');expect(s).not.toHaveProperty('supplier.actif');
  });
  it('dates first corrective issuance now and captures currently verified identity',()=>{
    const s=snapshotFromLegacySupplierFreeze(payload,identity);
    expect(s.issued_at).toBe(identity.issuedAt);expect(s.issuer).toEqual(identity.issuer);
    expect(s.supplier.address).toEqual(identity.supplierAddress);
    expect(s.delivery_address).toBeNull();
  });
  it('refuses an unapproved legacy source rather than calling it official',()=>{
    expect(()=>snapshotFromLegacySupplierFreeze({...payload,statut:'BROUILLON'},identity)).toThrow();
  });
  it.each([{lignes:[]},{general_terms:undefined},{fournisseur:{nom:'Unknown'}},{totaux:{}},{version:0}])('rejects incomplete frozen evidence %j',patch=>{
    expect(()=>snapshotFromLegacySupplierFreeze({...payload,...patch},identity)).toThrow();
  });
  it('never guesses an emission date',()=>{
    expect(()=>snapshotFromLegacySupplierFreeze(payload,{...identity,issuedAt:'bad-date'})).toThrow();
  });
});
