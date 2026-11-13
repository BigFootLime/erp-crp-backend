import type { PoolClient } from "pg";

import { HttpError } from "../../utils/httpError";

const segment = (value: string): string => value
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

/** The drawing reference is authoritative; never infer it from a client code. */
export function specialProcessTechnicalReference(planReference: string | null, indice: string): string {
  const reference = segment(planReference ?? "");
  if (!reference) {
    throw new HttpError(422, "SPECIAL_PROCESS_PLAN_REQUIRED", "Renseignez la référence du plan de la version de pièce technique sélectionnée.");
  }
  const index = segment(indice);
  if (!index) {
    throw new HttpError(422, "SPECIAL_PROCESS_INDEX_REQUIRED", "Renseignez l’indice de la version de pièce technique sélectionnée.");
  }
  return `${reference}-${index}`;
}

export function specialProcessArticleCode(abbreviation: string, technicalReference: string): string {
  const name = segment(abbreviation);
  const reference = segment(technicalReference);
  const code = `PS-${name}-${reference}`;
  if (!name || !reference || code.length > 80) {
    throw new HttpError(422, "SPECIAL_PROCESS_CODE_INVALID", "Le nom diminutif, la référence plan et l’indice doivent former un code article de 80 caractères maximum.");
  }
  return code;
}

/** Keep issued codes immutable, including those belonging to archived articles. */
export async function allocateSpecialProcessArticleCode(
  tx: Pick<PoolClient, "query">,
  abbreviation: string,
  technicalReference: string
): Promise<string> {
  const base = specialProcessArticleCode(abbreviation, technicalReference);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`special-process-code:${base}`]);
  const existing = await tx.query<{ code: string }>(
    "SELECT code FROM public.articles WHERE code = $1 OR left(code, length($1) + 1) = $1 || '-'",
    [base]
  );
  const issued = new Set(existing.rows.map((row) => row.code));
  if (!issued.has(base)) return base;
  for (let sequence = 2; sequence <= 100_000; sequence += 1) {
    const code = `${base}-${String(sequence).padStart(2, "0")}`;
    if (code.length > 80) {
      throw new HttpError(422, "SPECIAL_PROCESS_CODE_INVALID", "Raccourcissez le nom diminutif pour créer une nouvelle référence PS.");
    }
    if (!issued.has(code)) return code;
  }
  throw new HttpError(409, "SPECIAL_PROCESS_CODE_EXHAUSTED", "Aucune nouvelle référence disponible pour ce procédé spécial.");
}
