import {describe,it,expect} from 'vitest';
import {assertPurchaseLineCoveragePatch,type AllocatedPurchaseLine} from '../module/commande-fournisseur/domain/purchase-line-coverage';
const line:AllocatedPurchaseLine={type:'MATIERE',article_id:'article',unite:'barre',unite_stock:'mm',coef_conversion:6000,quantite:2,qty_annulee:0};
describe('modification d’une ligne couvrant des OF',()=>{
  it('refuse une réduction sous la quantité affectée dans l’unité de stock',()=>{
    expect(()=>assertPurchaseLineCoveragePatch(line,{quantite:1},9000)).toThrow();
    expect(()=>assertPurchaseLineCoveragePatch(line,{quantite:1.5},9000)).not.toThrow();
  });
  it('autorise le surplus et les conditions sans toucher aux promesses',()=>{
    expect(()=>assertPurchaseLineCoveragePatch(line,{quantite:3},9000)).not.toThrow();
    expect(()=>assertPurchaseLineCoveragePatch(line,{},9000)).not.toThrow();
  });
  it('empêche le remplacement de l’article ou de la conversion déjà affectés',()=>{
    expect(()=>assertPurchaseLineCoveragePatch(line,{article_id:'autre'},9000)).toThrow();
    expect(()=>assertPurchaseLineCoveragePatch(line,{coef_conversion:3000},9000)).toThrow();
    expect(()=>assertPurchaseLineCoveragePatch(line,{unite_stock:'kg'},9000)).toThrow();
    expect(()=>assertPurchaseLineCoveragePatch(line,{article_id:line.article_id,coef_conversion:6000},9000)).not.toThrow();
  });
  it('autorise une correction sans destinataire et tient compte du reliquat annulé',()=>{
    expect(()=>assertPurchaseLineCoveragePatch(line,{quantite:1},0)).not.toThrow();
    expect(()=>assertPurchaseLineCoveragePatch({...line,qty_annulee:0.5},{quantite:1.5},9000)).toThrow();
  });
});
