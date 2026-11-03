import { sourceHash } from './preparation-rules';

export type ProgrammingPreparation = {
  version_id: string; operation_hash: string; estimated_hours: number;
  prepared_at: string; prepared_by: number;
};
export function needsProgramming(operation: {type_operation?: string | null; cf_id: string | null}, centres: Map<string, string>) {
  const label = `${operation.type_operation ?? ''} ${centres.get(operation.cf_id ?? '') ?? ''}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g,' ');
  return /\b(?:FRAISAGE|TOURNAGE)\b/.test(label);
}
export function programmingPreparationCurrent(operation: object, versionId: string | null, saved?: ProgrammingPreparation) {
  return Boolean(saved && saved.version_id === versionId && saved.operation_hash === sourceHash(operation)
    && Number.isFinite(saved.estimated_hours) && saved.estimated_hours > 0);
}
