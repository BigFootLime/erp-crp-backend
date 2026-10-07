const workshopDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
});

/** A date-only shelf life remains valid through the named day at the workshop. */
export function isLotExpired(expiryAt: string | null | undefined, at: Date): boolean {
  if (!expiryAt) return false;
  const parts = workshopDate.formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return expiryAt.slice(0, 10) < today;
}
