import {describe,it,expect} from 'vitest';
import {programmingProgress} from './programming-progress';
import {programmingTaskSchema} from '../validators/production-workbench.validators';
describe('avancement de programmation distinct du pointage',()=>{
 it.each([0,25,50,75])('conserve TODO au palier %i',value=>expect(programmingProgress('TODO',value)).toBe(value));
 it('termine uniquement à 100 %',()=>expect(programmingProgress('DONE',100,75)).toBe(100));
 it.each([1,30,99,101])('refuse un pourcentage hors palier : %i',value=>expect(()=>programmingProgress('TODO',value)).toThrow());
 it('refuse la régression d’un avancement plus récent',()=>expect(()=>programmingProgress('TODO',25,50)).toThrow());
 it('ne transforme pas 100 % en tâche incomplète',()=>expect(()=>programmingProgress('TODO',100)).toThrow());
 it('conserve les clients historiques sans pourcentage',()=>{expect(programmingProgress('TODO',undefined,50)).toBe(50);expect(programmingProgress('DONE',undefined,75)).toBe(100);});
 it('exige la référence du programme pour la réalisation à 100 %',()=>{
  const body={expected_updated_at:'2026-11-05',assignee_id:1,estimated_hours:4,status:'DONE',progress_percent:100};
  expect(programmingTaskSchema.safeParse(body).success).toBe(false);
  expect(programmingTaskSchema.safeParse({...body,program_reference:'CN-001'}).success).toBe(true);
 });
});
