import { HttpError } from "../../../utils/httpError";

export const IMPORT_ASSISTANT_DATABASE = "cerp_test";

export function assertImportAssistantDatabase(database: string | null | undefined): void {
  if (database !== IMPORT_ASSISTANT_DATABASE) {
    throw new HttpError(
      409,
      "IMPORT_TEST_DATABASE_REQUIRED",
      "L’assistant d’import est verrouillé sur la base de validation cerp_test."
    );
  }
}
