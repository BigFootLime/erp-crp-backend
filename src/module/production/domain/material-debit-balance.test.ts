import {describe,it,expect} from 'vitest';
import {actualDebitBalance} from './material-debit-balance';
const rule={form:'BAR' as const,stockUnit:'m',unitsPerBlank:.4,kerfPerBlank:0,yieldValidated:false};
describe('actual bar and sheet withdrawals',()=>{
  it('distinguishes a six metre withdrawal, four consumed and two reusable',()=>{
    expect(actualDebitBalance({rule,blanks:10,sources:[{id:'r',quantity:6,remnant:2}],varianceReason:'Barre entière sortie, chute de deux mètres.'})).toMatchObject({expected:4,actual:6,net:4,remnants:2});
  });
  it('accepts a explained actual yield while keeping the quantity credit exact',()=>{
    const result=actualDebitBalance({rule,blanks:10,sources:[{id:'a',quantity:1,remnant:0},{id:'b',quantity:2.8,remnant:0}],varianceReason:'Débit groupé constaté et rendement vérifié.'});
    expect(result.actual).toBe(3.8);expect(result.sources.reduce((sum,s)=>sum+s.planned,0)).toBe(4);
  });
  it('rejects an unexplained difference',()=>expect(()=>actualDebitBalance({rule,blanks:10,sources:[{id:'r',quantity:6,remnant:0}]})).toThrow(/Expliquez/));
  it('does not allow a remnant to recreate the whole withdrawal',()=>expect(()=>actualDebitBalance({rule,blanks:10,sources:[{id:'r',quantity:6,remnant:6}],varianceReason:'Une justification explicite.'})).toThrow(/inférieure/));
  it('never assumes feasible sheet nesting from surface alone',()=>expect(()=>actualDebitBalance({rule:{...rule,form:'SHEET'},blanks:10,sources:[{id:'r',quantity:4,remnant:0}]})).toThrow(/méthodes/));
  it('keeps unit blanks exact',()=>expect(()=>actualDebitBalance({rule:{...rule,form:'UNIT',unitsPerBlank:1},blanks:10,sources:[{id:'r',quantity:9,remnant:0}],varianceReason:'Justification insuffisante pour inventer un brut.'})).toThrow(/unitaires/));
});
