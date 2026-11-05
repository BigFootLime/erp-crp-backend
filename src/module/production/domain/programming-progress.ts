import { HttpError } from '../../../utils/httpError';
export const PROGRAMMING_PROGRESS_STEPS = [0,25,50,75,100] as const;
export function programmingProgress(status:'TODO'|'DONE', requested:number|undefined, current=0) {
  const progress=requested??(status==='DONE'?100:current);
  if(!PROGRAMMING_PROGRESS_STEPS.includes(progress as typeof PROGRAMMING_PROGRESS_STEPS[number]))
    throw new HttpError(422,'PROGRAMMING_PROGRESS_INVALID','Choisissez un palier 0, 25, 50, 75 ou 100 %.');
  if((status==='DONE')!==(progress===100))throw new HttpError(422,'PROGRAMMING_PROGRESS_INVALID','100 % correspond à un programme réalisé et référencé.');
  if(progress<current)throw new HttpError(409,'PROGRAMMING_PROGRESS_REGRESSION','L’avancement a déjà atteint un palier supérieur. Actualisez la tâche.');
  return progress;
}
