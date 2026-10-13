import { describe, it, expect } from 'vitest';
import { catalogueBatchQuantities, catalogueQuantityKey } from './catalogue-order-quantity';
const line={catalogue_id:'catalogue-A',article_id:'treatment-A',unite:'u',quantite:18};
describe('quantité commandée par référence fournisseur',()=>{
  it.each([[18,2],[2,18]])('regroupe les origines indépendamment de leur ordre %s/%s',(first,second)=>{
    const rows=[{...line,quantite:first},{...line,quantite:second}];
    expect(catalogueBatchQuantities(rows).get(catalogueQuantityKey(line))).toBe(20);
    expect(rows.map(row=>row.quantite)).toEqual([first,second]);
  });
  it.each([{catalogue_id:'catalogue-B'},{article_id:'treatment-B'},{unite:'kg'}])('ne compte pas une autre identité %s',difference=>{
    const target={...line,quantite:2};
    expect(catalogueBatchQuantities([target,{...line,...difference}]).get(catalogueQuantityKey(target))).toBe(2);
  });
  it('ne compte pas une ligne entièrement annulée ni une ligne hors catalogue',()=>{
    expect(catalogueBatchQuantities([{...line,quantite:0},{...line,quantite:2},{...line,catalogue_id:null}]).get(catalogueQuantityKey(line))).toBe(2);
  });
  it.each([-1,NaN,Infinity])('refuse une quantité agrégée invalide %s',quantite=>{
    expect(()=>catalogueBatchQuantities([{...line,quantite}])).toThrow();
  });
});
