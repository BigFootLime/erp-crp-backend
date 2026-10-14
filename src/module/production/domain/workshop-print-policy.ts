import { HttpError } from "../../../utils/httpError";

export type WorkshopCopyStatus = "BROUILLON" | "OFFICIEL" | "OBSOLETE";
export type WorkshopCopyMark = "BROUILLON" | "DUPLICATA" | "OBSOLETE" | null;

/** This ordinal counts accepted print intents, not previews, downloads,
 * archived emissions or successful spooler observations. A retry retains the
 * same durable intent/ordinal; draft intents never consume an official one. */
export function workshopCopyMark(status: WorkshopCopyStatus, officialOrdinal: number | null): WorkshopCopyMark {
  if (!["BROUILLON", "OFFICIEL", "OBSOLETE"].includes(status)) {
    throw new HttpError(409, "WORKSHOP_PRINT_STATUS_INVALID", "L'état documentaire du dossier doit être vérifié.");
  }
  if (status === "BROUILLON") return "BROUILLON";
  if (status === "OBSOLETE") return "OBSOLETE";
  if (!Number.isSafeInteger(officialOrdinal) || officialOrdinal === null || officialOrdinal <= 0) {
    throw new HttpError(409, "WORKSHOP_PRINT_ORDINAL_INVALID", "L'exemplaire d'impression doit être rapproché avant cette action.");
  }
  return officialOrdinal === 1 ? null : "DUPLICATA";
}

export function nextWorkshopOfficialOrdinal(previousAccepted: number): number {
  if (!Number.isSafeInteger(previousAccepted) || previousAccepted < 0 || previousAccepted >= Number.MAX_SAFE_INTEGER) {
    throw new HttpError(409, "WORKSHOP_PRINT_ORDINAL_INVALID", "L'historique d'impression doit être vérifié.");
  }
  return previousAccepted + 1;
}
