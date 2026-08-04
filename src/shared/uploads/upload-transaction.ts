import type { PoolClient } from "pg";

import { HttpError } from "../../utils/httpError";
import logger from "../../utils/logger";
import {
  cleanupUploadsAfterConfirmedRollback,
  cleanupUploadsAfterReconciledNoCommit,
  markUploadCommitUncertain,
  markUploadCommitAttempted,
  markUploadRollbackUncertain,
  markUploadsCommitted,
  type UploadFileReference,
} from "./secure-upload";

export type UploadCommitReconciliation = "committed" | "not-committed" | "uncertain";

type UploadTransactionClient = Pick<PoolClient, "query" | "release">;

export type UploadTransactionOptions<T> = Readonly<{
  client: UploadTransactionClient;
  files: readonly UploadFileReference[];
  context: string;
  work: (client: UploadTransactionClient) => Promise<T>;
  /** Must query through a fresh pool connection, never `client`. */
  reconcile: (result: T) => Promise<UploadCommitReconciliation>;
}>;

export class UploadCommitUncertainError extends HttpError {
  constructor() {
    super(
      503,
      "UPLOAD_COMMIT_UNCERTAIN",
      "Le résultat de l’enregistrement du fichier est incertain. Réessayez après vérification."
    );
    this.name = "UploadCommitUncertainError";
  }
}

export class UploadRollbackUncertainError extends HttpError {
  constructor() {
    super(
      503,
      "UPLOAD_ROLLBACK_UNCERTAIN",
      "L’annulation de l’enregistrement du fichier n’a pas pu être confirmée."
    );
    this.name = "UploadRollbackUncertainError";
  }
}

function privacySafeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Owns one database transaction and the durable files promoted inside `work`.
 * It never issues ROLLBACK after COMMIT was attempted. An ACK-loss is resolved
 * only by the caller's fresh read; ambiguous ownership is preserved.
 */
export async function withUploadTransaction<T>(options: UploadTransactionOptions<T>): Promise<T> {
  const { client, files, context, work, reconcile } = options;
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };

  try {
    await client.query("BEGIN");
  } catch (error) {
    release(true);
    throw error;
  }

  let result: T;
  try {
    result = await work(client);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      markUploadRollbackUncertain(files);
      release(true);
      logger.error("[UPLOAD_TRANSACTION] rollback uncertain", JSON.stringify({
        context,
        error: privacySafeErrorName(rollbackError),
      }));
      throw new UploadRollbackUncertainError();
    }
    // A confirmed database rollback and a failed durable-file compensation are
    // distinct outcomes. The cleanup helper preserves registry state and
    // surfaces its own safe error instead of misreporting rollback uncertainty.
    try {
      await cleanupUploadsAfterConfirmedRollback(files);
    } catch (cleanupError) {
      release();
      logger.error("[UPLOAD_TRANSACTION] durable cleanup failed after rollback", JSON.stringify({
        context,
        error: privacySafeErrorName(cleanupError),
      }));
      throw cleanupError;
    }
    release();
    throw error;
  }

  markUploadCommitAttempted(files);
  try {
    await client.query("COMMIT");
    markUploadsCommitted(files);
    release();
    return result;
  } catch (commitError) {
    // The connection that lost the COMMIT acknowledgement must never be used
    // for reconciliation or returned to the pool.
    release(true);

    let reconciliation: UploadCommitReconciliation = "uncertain";
    try {
      reconciliation = await reconcile(result);
    } catch (reconciliationError) {
      logger.error("[UPLOAD_TRANSACTION] reconciliation failed", JSON.stringify({
        context,
        error: privacySafeErrorName(reconciliationError),
      }));
    }

    if (reconciliation === "committed") {
      markUploadsCommitted(files);
      return result;
    }
    if (reconciliation === "not-committed") {
      await cleanupUploadsAfterReconciledNoCommit(files);
      throw commitError;
    }

    logger.error("[UPLOAD_TRANSACTION] commit uncertain; durable files preserved", JSON.stringify({
      context,
      error: privacySafeErrorName(commitError),
    }));
    markUploadCommitUncertain(files);
    throw new UploadCommitUncertainError();
  }
}

/** Classifies exact immutable identities returned by a fresh reconciliation query. */
export function classifyUploadReconciliation(
  expectedKeys: readonly string[],
  observedKeys: readonly string[]
): UploadCommitReconciliation {
  const expected = new Set(expectedKeys);
  const observed = new Set(observedKeys);
  if (expected.size === 0) return "committed";
  if (observed.size === 0) return "not-committed";
  if (observed.size !== expected.size) return "uncertain";
  for (const key of expected) {
    if (!observed.has(key)) return "uncertain";
  }
  return "committed";
}
