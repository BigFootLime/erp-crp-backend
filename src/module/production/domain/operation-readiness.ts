import {HttpError} from "../../../utils/httpError";

/** Availability is a ceiling for this operation, never finished-goods stock. */
export type OperationBlocker = {code: string; message: string; action: string; target: "dossier" | "matiere" | "operations" | "qualite" | "programmation" | "planning"};
export type OperationReadinessFacts = {
  id: string; label: string; phase: number; status: string; targetQuantity: number; processedQuantity: number;
  dossierComplete: boolean; executionStatus: string; planned: boolean; machineBlocked: boolean;
  preparationMissing: boolean; programRequired: boolean; programReady: boolean; qualityBlocked: boolean;
  componentsMissing: boolean;
  materials: Array<{label: string; availableBlanks: number; allowPartial: boolean; blockers: string[]}>;
  predecessors: Array<{id: string; label: string; done: boolean; good: number; transferred: number; partial: boolean; minimum: number}>;
};

export function evaluateOperationReadiness(f: OperationReadinessFacts) {
  const blockers: OperationBlocker[] = [];
  const block = (code: string, message: string, action: string, target: OperationBlocker["target"]) => blockers.push({code,message,action,target});
  const remaining = Math.max(0, f.targetQuantity - f.processedQuantity);
  let ceiling = f.targetQuantity;
  if (!["BROUILLON", "PLANIFIE", "EN_COURS", "EN_PAUSE"].includes(f.executionStatus)) block("OF_CLOSED", "Cet OF est clôturé ou annulé.", "Consulter son historique", "dossier");
  if (!f.dossierComplete) block("DOSSIER_INCOMPLETE", "Le dossier doit être Complet avant le démarrage.", "Compléter ou revalider le dossier", "dossier");
  if (!f.planned) block("OPERATION_NOT_PLANNED", "Cette opération ne possède pas de créneau engagé.", "Planifier cette opération", "planning");
  if (["DONE", "CANCELLED", "BLOCKED"].includes(f.status)) block("OPERATION_UNAVAILABLE", f.status === "DONE" ? "Cette opération est déjà terminée." : "Cette opération est suspendue ou annulée.", "Consulter l’opération", "operations");
  if (f.machineBlocked) block("MACHINE_UNAVAILABLE", "La ressource affectée est indisponible.", "Vérifier la ressource ou la réaffecter", "planning");
  if (f.preparationMissing) block("MATERIAL_PREPARATION_MISSING", "Un besoin matière n’est pas encore relié à son opération.", "Compléter la préparation matière", "matiere");
  if (f.programRequired && !f.programReady) block("PROGRAM_REQUIRED", "Le programme requis n’est pas encore disponible.", "Terminer et référencer le programme", "programmation");
  if (f.qualityBlocked) block("QUALITY_BLOCKED", "Un contrôle applicable ou une non-conformité bloque cette opération.", "Consulter le contrôle et sa décision", "qualite");
  if (f.componentsMissing) block("COMPONENTS_MISSING", "Les composants de cet assemblage ne sont pas tous réservés et libérés par la qualité.", "Vérifier la couverture et la qualité des composants", "matiere");
  for (const m of f.materials) {
    ceiling = Math.min(ceiling, Math.max(0, Math.floor(m.availableBlanks)));
    for (const reason of m.blockers) block("MATERIAL_BLOCKED", `${m.label} : ${reason}`, "Vérifier les lots réservés", "matiere");
    if (!m.allowPartial && m.availableBlanks < f.targetQuantity) block("FULL_MATERIAL_REQUIRED", `${m.label} : la gamme exige la couverture de toute la quantité.`, "Couvrir le manque matière", "matiere");
  }
  for (const p of f.predecessors) {
    // An explicit released transfer is required for an unfinished predecessor.
    // A good quantity declaration alone never means the batch was transferred.
    const available = p.done ? Math.max(0,p.good) : p.partial ? Math.max(0,p.transferred) : 0;
    ceiling = Math.min(ceiling, available);
    if (!p.done && (!p.partial || available < p.minimum)) block("PREDECESSOR_REQUIRED", `Attente de ${p.label}${p.partial ? ` : lot transférable de ${p.minimum} pièces minimum.` : " : opération complète requise."}`, "Consulter l’étape précédente", "operations");
  }
  const availableQuantity = Math.max(0, Math.min(remaining, Math.floor(ceiling - f.processedQuantity)));
  if (!remaining) block("QUANTITY_COMPLETE", "Toute la quantité de cette opération est déjà déclarée.", "Vérifier puis terminer l’opération", "operations");
  else if (!availableQuantity && !blockers.length) block("QUANTITY_UNAVAILABLE", "Aucune quantité supplémentaire n’est encore utilisable sur cette opération.", "Vérifier la matière et les étapes précédentes", "matiere");
  return {id:f.id,label:f.label,phase:f.phase,status:f.status,targetQuantity:f.targetQuantity,processedQuantity:f.processedQuantity,
    remainingQuantity:remaining,availableQuantity,canStart:availableQuantity>0&&!blockers.length,partial:availableQuantity>0&&availableQuantity<remaining,blockers};
}

/** Good, rejected, awaiting inspection and awaiting rework are exclusive outputs.
 * Rework time is recorded as an activity; resolving an output needs a correction. */
export function assertOperationQuantityCeiling(f: {
  executionStatus:string; operationStatus:string; available:number; consumedAvailable:number|null;
  good:number; scrap:number; pending:number; rework:number;
}) {
  if (!["EN_COURS","EN_PAUSE"].includes(f.executionStatus) || !["RUNNING","READY"].includes(f.operationStatus))
    throw new HttpError(409,"OPERATION_NOT_STARTED","Démarrez cette opération avant de déclarer son avancement.");
  const added=f.good+f.scrap+f.pending+f.rework;
  if(added>f.available+1e-9)
    throw new HttpError(409,"OPERATION_QUANTITY_UNAVAILABLE","La quantité déclarée dépasse les pièces autorisées pour cette opération.",{available:f.available,declared:added});
  if(f.consumedAvailable!==null&&added>f.consumedAvailable+1e-9)
    throw new HttpError(409,"MATERIAL_DEBIT_REQUIRED","Déclarez le débit avec la matière réellement consommée avant de déclarer ces bruts.",{consumedAvailable:f.consumedAvailable});
}
