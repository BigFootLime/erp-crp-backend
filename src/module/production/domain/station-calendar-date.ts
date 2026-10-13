/** Calendar DATE from PostgreSQL, never a locale string or a UTC instant. */
export function stationCalendarDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    // The pg DATE parser constructs local midnight in the process timezone.
    // toISOString() would shift that calendar day in positive UTC offsets.
    const year = value.getFullYear();
    if (year < 1 || year > 9999) return null;
    return `${String(year).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}
