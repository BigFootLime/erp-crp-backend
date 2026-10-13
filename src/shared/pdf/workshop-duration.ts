/** Storage remains decimal hours; workshop documents use minutes and hours/minutes. */
export function formatWorkshopDuration(hours: unknown): string {
  if (hours === null || hours === undefined || hours === "") return "—";
  const value = Number(hours);
  if (!Number.isFinite(value) || value < 0) return "—";
  const rawMinutes = value * 60;
  if (rawMinutes > 0 && rawMinutes < 0.001) return "< 0,001 min";
  const minutes = Math.round(rawMinutes * 1000) / 1000;
  const h = Math.floor(minutes / 60);
  const m = Math.round((minutes - h * 60) * 1000) / 1000;
  const label = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3, useGrouping: false }).format(m);
  return h === 0 ? `${label} min` : m === 0 ? `${h} h` : `${h} h ${label} min`;
}
