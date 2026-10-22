import { ZodError } from "zod";
import { HttpError } from "../../../utils/httpError";
import type { CutoverIssue } from "../types/data-cutover.types";

/** Native DTO errors are user corrections; unexpected infrastructure errors
 * remain server failures and must never become an inline SQL/error message. */
export function applicationInputIssues(error: unknown, rowId?: string): Array<CutoverIssue & { row_id?: string }> {
  if (error instanceof HttpError) return [{ row_id: rowId, field: null, code: error.code, message: error.message }];
  if (error instanceof ZodError) return error.issues.slice(0, 10).map((issue) => ({
    row_id: rowId, field: null, code: "CUTOVER_NATIVE_FORMAT_INVALID",
    message: `La fiche CERP doit être complétée ou corrigée (${issue.path.join(".") || "fiche"}) : ${issue.message}`,
  }));
  throw error;
}
