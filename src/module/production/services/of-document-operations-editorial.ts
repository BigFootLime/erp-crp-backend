import type { CerpDocumentContext } from "../../../shared/pdf/cerp-document";
import { formatQuantity, type OfDocumentPayload } from "../domain/of-document";

const visaStates: Record<string,string> = { A_FAIRE:"À faire", EN_COURS:"En cours", VISE:"Visé", REFUSE:"Refusé" };
const decimalHours = (hours: number) => Number.isFinite(hours)
  ? new Intl.NumberFormat("fr-FR", {useGrouping:false,maximumSignificantDigits:15}).format(hours)
  : "Non renseigné";
function visaDate(iso: string): string {
  const date=new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getUTCDate()).padStart(2,"0")}/${String(date.getUTCMonth()+1).padStart(2,"0")}/${date.getUTCFullYear()} à ${String(date.getUTCHours()).padStart(2,"0")}:${String(date.getUTCMinutes()).padStart(2,"0")}`;
}

/** An operator reads one phase at a time; timing, programme and its recorded visa stay together. */
export function renderEditorialOfOperations(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  ctx.section("Gamme applicable");
  if (!payload.phases.length) {
    ctx.notes("Aucune phase dans cette révision.");
    return;
  }
  for (const phase of payload.phases) {
    const recordedVisa = Boolean(phase.visa.visaOperateur || phase.visa.operateur || phase.visa.visaAt || phase.visa.visaControle || phase.visa.motifRebut)
      || phase.visa.quantiteBonne !== null || phase.visa.quantiteRebut !== null;
    const visaFields = recordedVisa ? [
      {label:"Opérateur / visa", value:[phase.visa.operateur,phase.visa.visaOperateur].filter(Boolean).join(" — ") || null},
      {label:"Date du visa", value:phase.visa.visaAt ? visaDate(phase.visa.visaAt) : null},
      ...(phase.visa.visaControle ? [{label:"Visa contrôle", value:phase.visa.visaControle}] : []),
      ...(phase.visa.quantiteBonne !== null ? [{label:"Pièces bonnes", value:formatQuantity(phase.visa.quantiteBonne)}] : []),
      ...(phase.visa.quantiteRebut !== null ? [{label:"Rebuts", value:formatQuantity(phase.visa.quantiteRebut)}] : []),
      ...(phase.visa.motifRebut ? [{label:"Motif rebut", value:phase.visa.motifRebut}] : []),
    ] : [{label:"Visa opérateur", value:"Non enregistré"}];
    ctx.operationCard({
      number:String(phase.phase), title:phase.designation,
      fields:[
        {label:"Machine", value:phase.machine ?? phase.familyLabel},
        {label:"Centre / famille", value:[phase.centre,phase.familyLabel].filter(Boolean).join(" — ") || null},
        ...(phase.programme || phase.programmeManquant ? [{label:"Programme", value:phase.programme ?? "À obtenir avant lancement"}] : []),
        {label:"Temps par pièce", value:`${decimalHours(phase.tempsUnitaireH)} h / pièce`},
        {label:"Temps de réglage", value:`${decimalHours(phase.preparationH)} h`},
        {label:"Quantité de base", value:formatQuantity(phase.quantiteBase)},
        {label:"Fabrication prévue", value:phase.fabricationLabel},
        {label:"Charge totale", value:phase.finalLabel},
        {label:"État du visa", value:visaStates[phase.visa.statut] ?? phase.visa.statut},
        ...visaFields,
      ],
      instructions:phase.visa.commentaire,
    });
  }
}
