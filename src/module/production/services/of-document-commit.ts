import { HttpError } from "../../../utils/httpError";
import { readBlob } from "../../ged/services/ged-vault.service";
import {
  reconcileOfDocumentMetadataCommit,
  type OfDocumentCommitExpectation,
} from "../repository/of-versioning.repository";
import {
  compensateOfDocumentArchive,
  type OfDocumentArchiveResult,
} from "./of-document-archive";

export type OfDocumentCommitContext<T> = Readonly<{
  publicResult: T;
  expectation: OfDocumentCommitExpectation;
  archiveOwnership: OfDocumentArchiveResult | null;
}>;

function commitUncertain(): HttpError {
  return new HttpError(
    503,
    "OF_DOCUMENT_COMMIT_UNCERTAIN",
    "Le résultat de l'émission du document OF doit être rapproché."
  );
}

/**
 * Reconcile a lost COMMIT acknowledgement only through a fresh pool query.
 * Metadata must match exactly, then the physical GED blob is independently
 * re-read and verified by hash and size. Any partial or inaccessible state is
 * preserved for operators; only proven total absence authorizes compensation.
 */
export async function reconcileOfDocumentCommit<T>(
  context: OfDocumentCommitContext<T>
): Promise<T> {
  let outcome;
  try {
    outcome = await reconcileOfDocumentMetadataCommit(context.expectation);
  } catch {
    throw commitUncertain();
  }

  if (outcome === "committed") {
    if (context.expectation.gedVersionId) {
      if (!context.expectation.gedBlobStorageKey) throw commitUncertain();
      try {
        const blob = await readBlob(
          context.expectation.gedBlobStorageKey,
          context.expectation.pdfSha256
        );
        if (blob.byteLength !== context.expectation.pdfByteSize) throw commitUncertain();
      } catch {
        throw commitUncertain();
      }
    }
    return context.publicResult;
  }

  if (outcome === "not-committed") {
    await compensateOfDocumentArchive(context.archiveOwnership);
    throw new HttpError(
      503,
      "OF_DOCUMENT_COMMIT_NOT_APPLIED",
      "L'émission du document OF n'a pas été appliquée. Vous pouvez réessayer."
    );
  }

  throw commitUncertain();
}
