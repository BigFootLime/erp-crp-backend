import type { Resource } from "../types/planning-central.types";
import type { ExternalServicePreparation, SubcontractFlow } from "../../subcontract/subcontract-flow.types";

function civilDate(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k)!.value)
    .join("-");
}
/** A supplier promise is a civil day, available only once that day has ended. */
export function promiseEnd(date: string, timezone: string) {
  const target = Date.parse(date + "T00:00:00Z") + 86400000;
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const p = formatter.formatToParts(new Date(guess)),
      get = (k: string) => p.find((x) => x.type === k)!.value;
    const shown = Date.parse(
      `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
    );
    guess += target - shown;
  }
  return new Date(guess).toISOString();
}
export function externalCompletion(
  packages: SubcontractFlow[],
  quantity: number,
  earliest: string,
  resources: Resource[],
  now: string,
  preparations: ExternalServicePreparation[] = [],
  preparationIssues: string[] = [],
) {
  if (preparations.length) return preparedCompletion(packages,quantity,earliest,resources,now,preparations,preparationIssues);
  const issues: string[] = [],
    dates: string[] = [];
  issues.push(...preparationIssues);
  if (packages.reduce((n, p) => n + p.planned, 0) < quantity)
    issues.push("La commande sous-traitant ne couvre pas toute la quantité.");
  for (const p of packages) {
    const calendar = resources.find((r) => r.id === "supplier:" + p.supplierId);
    if (p.returned >= p.planned && p.released >= p.planned && p.lastReturnAt) {
      dates.push(p.lastReturnAt);
      continue;
    }
    if (p.returned > p.released) {
      issues.push(
        `${p.supplierName} : ${p.returned - p.released} pièces indisponibles pour la suite (libération qualité ou affectation au stock à vérifier).`,
      );
      continue;
    }
    if (!calendar) {
      issues.push(`${p.supplierName} : calendrier à définir.`);
      continue;
    }
    const start = p.departedAt ?? earliest;
    let end: string | null = null;
    if (p.promisedDate) end = promiseEnd(p.promisedDate, calendar.timezone);
    else {
      const first = civilDate(start, calendar.timezone);
      const days = [
        ...new Set(
          calendar.availability
            .filter((i) => civilDate(i.start, calendar.timezone) > first)
            .map((i) => civilDate(i.start, calendar.timezone)),
        ),
      ].sort();
      const day = days[4];
      if (day)
        end = calendar.availability
          .filter((i) => civilDate(i.start, calendar.timezone) === day)
          .at(-1)!.end;
    }
    if (!end)
      issues.push(
        `${p.supplierName} : cinq jours ouvrés ne sont pas disponibles dans le calendrier.`,
      );
    else if (
      Date.parse(end) < Date.parse(now) ||
      Date.parse(end) < Date.parse(earliest)
    )
      issues.push(
        `${p.supplierName} : date de retour dépassée ou incompatible, nouvelle promesse nécessaire.`,
      );
    else dates.push(end);
  }
  return {
    fullReadyAt: issues.length || !dates.length ? null : dates.sort().at(-1)!,
    issues,
  };
}

/** A forecast uses the selected catalogue lead time, without creating a shipment,
 * returned quantity, supplier acknowledgement, or material-origin allocation. */
function preparedCompletion(packages:SubcontractFlow[],quantity:number,earliest:string,resources:Resource[],now:string,
  preparations:ExternalServicePreparation[],preparationIssues:string[]) {
  const issues=[...preparationIssues],dates:string[]=[];
  if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(Date.parse(earliest))||!Number.isFinite(Date.parse(now)))
    return {fullReadyAt:null,issues:[...issues,'Quantité ou date de départ de la prestation à vérifier.']};
  const usedLines=new Set<string>(),usedPurchases=new Set<string>();
  for(const preparation of preparations) {
    if(usedPurchases.has(preparation.purchaseId)||preparation.quantity!==quantity) {
      issues.push('Actualisez la quantité et les prestations de la préparation fournisseur.');continue;
    }
    usedPurchases.add(preparation.purchaseId);
    if(preparation.orderLineIds.some(id=>usedLines.has(id))) {
      issues.push('Une ligne fournisseur ne peut pas couvrir deux prestations.');continue;
    }
    preparation.orderLineIds.forEach(id=>usedLines.add(id));
    const actual=packages.filter(p=>preparation.orderLineIds.includes(p.orderLineId));
    const packaged=actual.reduce((sum,p)=>sum+p.planned,0);
    if(actual.length) {
      const result=externalCompletion(actual,packaged,earliest,resources,now);
      issues.push(...result.issues);
      if(result.fullReadyAt)dates.push(result.fullReadyAt);
    }
    if(packaged>=quantity)continue;
    const calendar=resources.find(r=>r.id==='supplier:'+preparation.supplierId);
    if(!calendar||!calendar.availability.length) {issues.push(`${preparation.supplierName} : calendrier à définir.`);continue;}
    const start=new Date(Math.max(Date.parse(earliest),Date.parse(now))).toISOString();
    let end:string|null=null;
    if(preparation.due)end=promiseEnd(preparation.due,calendar.timezone);
    else if(Number.isInteger(preparation.leadDays)&&preparation.leadDays!>=0) {
      const first=civilDate(start,calendar.timezone);
      const days=[...new Set(calendar.availability.filter(i=>preparation.leadDays===0
        ? Date.parse(i.end)>Date.parse(start)&&civilDate(i.start,calendar.timezone)>=first
        : civilDate(i.start,calendar.timezone)>first).map(i=>civilDate(i.start,calendar.timezone)))].sort();
      const day=days[Math.max(0,preparation.leadDays!-1)];
      if(day)end=calendar.availability.filter(i=>civilDate(i.start,calendar.timezone)===day).at(-1)!.end;
    }
    if(!end)issues.push(`${preparation.supplierName} : délai estimé ou calendrier à compléter.`);
    else if(Date.parse(end)<=Date.parse(start))issues.push(`${preparation.supplierName} : le retour estimé précède la disponibilité des pièces.`);
    else dates.push(end);
  }
  if(packages.some(p=>!usedLines.has(p.orderLineId)))issues.push('Rapprochez les commandes fournisseur de leur prestation avant de planifier le complément.');
  return {fullReadyAt:issues.length||!dates.length?null:dates.sort().at(-1)!,issues};
}
