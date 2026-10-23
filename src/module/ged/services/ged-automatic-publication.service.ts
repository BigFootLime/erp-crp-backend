import type { PoolClient } from "pg";
import { assertGedCapability } from "../domain/ged-policy";
import { repoLockAutomaticPublicationSource, type AutomaticPublicationSource } from "../repository/ged-automatic-publication.repository";
import { repoLogAccess, repoObsoletePreviousApplicable, repoSetCurrentVersion, repoSetVersionStatus } from "../repository/ged.repository";
import { assertGedParentLinkWritable } from "./ged-parent-authorization.service";
import type { GedActor } from "./ged.service";

export const AUTOMATIC_PUBLICATION_POLICY = "ged-clean-upload-20261023";

export function canAutomaticallyPublishGedUpload(source: AutomaticPublicationSource): boolean {
  return source.status === "BROUILLON" && !source.archived && !source.held && !source.checked_out_by_other
    && source.scan_status === "clean" && source.quarantine_status === "released" && source.scan_matches_blob === true;
}

/**
 * Explicit administrator-requested availability policy for all GED uploads.
 * The service publishes the scanned version; it does not impersonate a human
 * approver or accept measurements, invoices, derogations or other business acts.
 */
export async function automaticallyPublishCleanUpload(
  tx: Pick<PoolClient, "query">,
  actor: GedActor,
  documentId: string,
  versionId: string,
): Promise<boolean> {
  assertGedCapability(actor.role, "upload");
  const source = await repoLockAutomaticPublicationSource(tx, documentId, versionId, actor.id);
  if (!source || !canAutomaticallyPublishGedUpload(source)) return false;
  // Recheck every live business attachment, including newly created links in this transaction.
  for (const link of source.links) await assertGedParentLinkWritable(actor.id, link);
  await repoObsoletePreviousApplicable(tx, documentId, versionId);
  await repoSetVersionStatus(tx, versionId, "APPLICABLE", actor.id);
  await repoSetCurrentVersion(tx, documentId, versionId);
  await repoLogAccess(tx, {
    document_id: documentId, version_id: versionId, event_type: "PUBLISH", actor_id: actor.id,
    details: { from: "BROUILLON", to: "APPLICABLE", publication_mode: "AUTOMATIC_AFTER_CLEAN_SCAN",
      policy: AUTOMATIC_PUBLICATION_POLICY, antivirus: "clean", quarantine: "released", human_approval: false },
  });
  return true;
}
