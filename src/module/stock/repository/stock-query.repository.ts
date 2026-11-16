export function sortDirection(sortDir: "asc" | "desc" | undefined): "ASC" | "DESC" {
  return sortDir === "asc" ? "ASC" : "DESC";
}

export function normalizeLikeQuery(raw: string): string {
  return `%${raw.trim()}%`;
}
