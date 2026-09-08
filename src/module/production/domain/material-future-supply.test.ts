import {describe,it,expect} from 'vitest';
import {futureSupplyBalance} from './material-future-supply';
describe('future supply in stock units',()=>{
  it('makes 25 of 100 free when 75 are already promised',()=>expect(futureSupplyBalance({ordered:100,cancelled:0,coefficient:1,assigned:75,received:0})).toEqual({capacity:100,available:25,unassignedReceived:0}));
  it('does not subtract fulfilled promises twice',()=>expect(futureSupplyBalance({ordered:100,cancelled:0,coefficient:1,assigned:75,received:40}).available).toBe(25));
  it('distinguishes unassigned received quantities from future stock',()=>expect(futureSupplyBalance({ordered:100,cancelled:0,coefficient:1,assigned:25,received:40})).toEqual({capacity:100,available:60,unassignedReceived:15}));
  it('converts purchased bars and cancellations to stock length',()=>expect(futureSupplyBalance({ordered:10,cancelled:2,coefficient:6,assigned:30,received:6}).available).toBe(18));
  it('rounds partial quantities using stock precision',()=>expect(futureSupplyBalance({ordered:.3,cancelled:0,coefficient:1,assigned:.2,received:0}).available).toBe(.1));
  it('never reoffers an overallocated purchase',()=>expect(futureSupplyBalance({ordered:10,cancelled:0,coefficient:1,assigned:12,received:0}).available).toBe(0));
  it.each([-1,NaN,Infinity])('rejects invalid quantities %s',ordered=>expect(()=>futureSupplyBalance({ordered,cancelled:0,coefficient:1,assigned:0,received:0})).toThrow());
});
