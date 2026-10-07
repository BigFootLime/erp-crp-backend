import { HttpError } from "../../../utils/httpError";
import {
  assertGedParentLinkWritable,
  assertGedVersionParentReadable,
} from "../../ged/services/ged-parent-authorization.service";
import type { ApprovalRevisionInput } from "../domain/client-supplier-approval";
import {
  repoAppendApprovalRevision,
  repoApprovalPolicies,
  repoApprovalEvidenceChoices,
  repoApprovalHistory,
} from "../repository/client-supplier-approval.repository";

async function authorizeClient(actor: number, clientId: string) {
  await assertGedParentLinkWritable(actor, {
    entity_type: "CLIENT",
    entity_id: clientId,
  });
}
export async function listClientApprovals(actor: number, clientId: string) {
  await authorizeClient(actor, clientId);
  return repoApprovalPolicies(clientId);
}
export async function listClientApprovalEvidence(
  actor: number,
  clientId: string,
) {
  await authorizeClient(actor, clientId);
  const choices = await repoApprovalEvidenceChoices(clientId);
  const readable = [];
  for (const choice of choices) {
    try {
      await assertGedVersionParentReadable(actor, choice.document_id);
      readable.push(choice);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }
  }
  return readable;
}
export async function appendClientApproval(
  actor: number,
  input: ApprovalRevisionInput,
) {
  await authorizeClient(actor, input.scope.client_id);
  return repoAppendApprovalRevision(input, actor);
}
export async function clientApprovalHistory(actor: number, scopeId: string) {
  const rows = await repoApprovalHistory(scopeId);
  if (!rows.length)
    throw new HttpError(
      404,
      "CLIENT_APPROVAL_NOT_FOUND",
      "Agrément introuvable.",
    );
  await authorizeClient(actor, rows[0].client_id);
  return rows;
}
