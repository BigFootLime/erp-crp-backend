import { repoFindLabelByPublicId } from "../../identification/identification.repository";
import { HttpError } from "../../../utils/httpError";
export async function resolveTerminalIdentification(
  publicId: string,
): Promise<number> {
  const label = await repoFindLabelByPublicId(publicId);
  if (
    !label ||
    label.status !== "ACTIVE" ||
    label.entity_type !== "WORK_ORDER" ||
    !/^\d+$/.test(label.entity_id)
  ) {
    throw new HttpError(
      404,
      "TERMINAL_SCAN_UNKNOWN",
      "Étiquette OF inconnue, remplacée ou invalide.",
    );
  }
  return Number(label.entity_id);
}
