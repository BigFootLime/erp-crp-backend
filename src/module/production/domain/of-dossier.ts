import { createHash } from "node:crypto";

export type DossierOperation = {
  id: string; phase: number; label: string; planned: boolean; status: string;
  setup: number; unit: number; base: number; coefficient: number;
  start: string | null; end: string | null; resource: string | null;
};
export type DossierFacts = {
  id: number; status: string; technicalReadiness: string; technicalHash: string | null;
  revision: string | null; quantity: number; operations: DossierOperation[];
};
/** Intentional: moving a committed slot doesn't change the prepared product. */
export function dossierSourceHash(f: DossierFacts): string {
  return createHash("sha256").update(JSON.stringify({
    hash:f.technicalHash,revision:f.revision,quantity:f.quantity,
    operations:f.operations.map(o => [o.id,o.phase,o.label,o.setup,o.unit,o.base,o.coefficient]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
  })).digest("hex");
}
export function evaluateDossier(f: DossierFacts, validation?: {source_hash:string;invalidated_at:string|null;invalidation_reason:string|null}|null) {
  const blockers: Array<{code:string;message:string;operationId?:string}> = [];
  if(f.technicalReadiness!=="VALIDATED" || !f.technicalHash || !f.revision)
    blockers.push({code:"TECHNICAL_PREPARATION_REQUIRED",message:"Valider et figer le dossier technique de l’OF."});
  if(!f.operations.length) blockers.push({code:"ROUTING_REQUIRED",message:"Définir les opérations de fabrication."});
  for(const operation of f.operations) if(!operation.planned && !["RUNNING","DONE"].includes(operation.status))
    blockers.push({code:"OPERATION_NOT_PLANNED",message:`Planifier la phase ${operation.phase} : ${operation.label}.`,operationId:operation.id});
  const fingerprint=dossierSourceHash(f);
  const valid=!!validation && !validation.invalidated_at && validation.source_hash===fingerprint && !blockers.length;
  return {status:valid?"COMPLETE" as const:validation?"REVALIDATION_REQUIRED" as const:"INCOMPLETE" as const,
    sourceHash:fingerprint,blockers,canComplete:["BROUILLON","PLANIFIE"].includes(f.status)&&!blockers.length,
    invalidationReason:validation?.invalidation_reason ?? null,
    planning:{total:f.operations.length,planned:f.operations.filter(o=>o.planned||["RUNNING","DONE"].includes(o.status)).length},
    loadMinutes:f.operations.reduce((sum,o)=>sum+Math.round((o.setup+o.unit*o.base*f.quantity*o.coefficient)*60),0)};
}
