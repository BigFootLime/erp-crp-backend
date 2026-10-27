export type PreparationDocument = { id: string; version_id: string; role: string; sha256: string | null; original_name?: string; mime_type?: string };

/** Callers supply only applicable, released and clean GED evidence for this revision. */
export function importedInspection(documents: readonly PreparationDocument[]): PreparationDocument | null {
  const matches = documents.filter((document) => document.role === "FICHE_AUTOCONTROLE" && /^[a-f0-9]{64}$/i.test(document.sha256 ?? ""));
  // Multiple sources need an explicit choice rather than silently picking a file.
  return matches.length === 1 ? matches[0] : null;
}
