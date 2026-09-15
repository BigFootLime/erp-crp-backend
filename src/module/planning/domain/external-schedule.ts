import type { Resource } from "../types/planning-central.types";
import type { SubcontractFlow } from "../../subcontract/subcontract-flow.types";

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
) {
  const issues: string[] = [],
    dates: string[] = [];
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
