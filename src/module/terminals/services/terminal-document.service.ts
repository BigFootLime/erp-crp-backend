import { HttpError } from "../../../utils/httpError";
import { repoInternalGetVersionContentRef } from "../../ged/repository/ged.repository";
import { resolveBlobForDownload } from "../../ged/services/ged-vault.service";
import type { DownloadResult, GedActor } from "../../ged/services/ged.service";
import type { OperationContext } from "../repository/terminal-dossier.repository";
import { requireModule } from "./terminal-auth.service";

/** The caller must first authorize this OF operation against the paired machine.
 * The released OF grants scoped document consultation to production operators;
 * it does not grant access to general GED browsing or other parent records. */
export async function downloadOfGedVersion(
  actor: GedActor,
  context: OperationContext,
  versionId: string,
): Promise<DownloadResult> {
  await requireModule(actor.id, "production");
  const evidence = context.technical_snapshot?.preparation_evidence?.documents;
  const frozen = Array.isArray(evidence)
    ? evidence.find((d) => d.version_id === versionId)
    : null;
  if (!frozen)
    throw new HttpError(
      404,
      "TERMINAL_DOCUMENT_OUTSIDE_SCOPE",
      "Cette version ne fait pas partie du dossier OF.",
    );
  const ref = await repoInternalGetVersionContentRef(versionId);
  if (
    !ref ||
    !["APPLICABLE", "OBSOLETE"].includes(ref.status) ||
    (frozen.sha256 && frozen.sha256 !== ref.sha256)
  )
    throw new HttpError(
      409,
      "TERMINAL_DOCUMENT_VERSION",
      "Version applicable indisponible ou empreinte différente.",
    );
  if (
    (ref.scan_status !== null && ref.scan_status !== "clean") ||
    ref.quarantine_status === "quarantined"
  )
    throw new HttpError(
      409,
      "GED_SCAN_REQUIRED",
      "Ce document reste bloqué par le contrôle antivirus.",
    );
  const blob = await resolveBlobForDownload(ref.storage_key);
  return {
    file_path: blob.file_path,
    allowed_root: blob.allowed_root,
    size_bytes: ref.size_bytes,
    original_name: ref.original_name,
    mime_type: ref.mime_type,
    sha256: ref.sha256,
    document_id: ref.document_id,
    version_id: ref.version_id,
  };
}
