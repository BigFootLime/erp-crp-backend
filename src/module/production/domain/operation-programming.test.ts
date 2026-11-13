import {describe,it,expect} from 'vitest';
import {needsProgramming,programmingPreparationCurrent} from './operation-programming';
import {sourceHash} from './preparation-rules';
import {operationProgrammingSchema} from '../validators/production-workbench.validators';

describe('programming preparation by route operation',()=>{
  const op={id:'operation-a',type_operation:'REPRISE',cf_id:'cf-a',designation:'Phase 20',tp:1,tf_unit:2};
  it('recognizes a milling or turning cost centre, excluding inspection',()=>{
    expect(needsProgramming(op,new Map([['cf-a','Fraisage CN']]))).toBe(true);
    expect(needsProgramming({...op,type_operation:'TOURNAGE'},new Map())).toBe(true);
    expect(needsProgramming({...op,type_operation:'CONTROLE'},new Map([['cf-a','Contrôle']]))).toBe(false);
    expect(needsProgramming(op,new Map([['cf-a','Frais de transport']]))).toBe(false);
  });
  it('invalidates an estimate when the operation or revision changed',()=>{
    const saved={version_id:'v1',operation_hash:sourceHash(op),estimated_hours:2,prepared_at:'2026-11-03',prepared_by:1};
    expect(programmingPreparationCurrent(op,'v1',saved)).toBe(true);
    expect(programmingPreparationCurrent({...op,tp:5},'v1',saved)).toBe(false);
    expect(programmingPreparationCurrent(op,'v2',saved)).toBe(false);
  });
  it('rejects invalid estimates and cannot accept a CNC completion flag',()=>{
    const input={operation_id:'00000000-0000-4000-8000-000000000001',operation_hash:'a'.repeat(64),expected_updated_at:'x',estimated_hours:1};
    expect(operationProgrammingSchema.safeParse(input).success).toBe(true);
    for(const value of [0,-1,Infinity,10001])expect(operationProgrammingSchema.safeParse({...input,estimated_hours:value}).success).toBe(false);
    expect(operationProgrammingSchema.safeParse({...input,status:'DONE'}).success).toBe(false);
  });
});
