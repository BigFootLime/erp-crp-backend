import {describe,it,expect} from 'vitest';
import {supplierPoPriceSupplement,type SupplierPurchaseOrderSnapshot} from './commande-fournisseur-official-pdf';
const line:SupplierPurchaseOrderSnapshot['lines'][number]={position:1,reference:null,designation:'Fixture',unit:'u',quantity:'18',unit_price_ht:'6',discount_pct:'0',vat_pct:'20',net_ht:'128',need_date:null};
describe('frozen supplier PDF price breakdown',()=>{
  it('explains a frozen twenty euro supplement without guessing its historical rule',()=>expect(supplierPoPriceSupplement(line)).toBe(20));
  it('accounts for a separately rounded commercial discount',()=>expect(supplierPoPriceSupplement({...line,discount_pct:'10',net_ht:'117.20'})).toBe(20));
  it('omits zero supplements',()=>expect(supplierPoPriceSupplement({...line,net_ht:'108'})).toBeNull());
  it('does not invent missing price information',()=>expect(supplierPoPriceSupplement({...line,unit_price_ht:null})).toBeNull());
});
