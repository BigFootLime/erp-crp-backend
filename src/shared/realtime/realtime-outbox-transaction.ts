import type { PoolClient } from "pg";

import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";

const REALTIME_EVENT_KEY_PREFIX = "realtime:";
type InsertedRealtimeOutboxEvidence = { eventKey: string; eventId: string };
type RealtimeTransactionContext = {
  owner: symbol;
  depth: number;
  insertedEvents: Map<string, string>;
};
const realtimeTransactionContexts = new WeakMap<object, RealtimeTransactionContext>();

export class RealtimeCommitUncertainError extends HttpError {
  constructor() {
    super(
      503,
      "REALTIME_COMMIT_OUTCOME_UNKNOWN",
      "L'issue de la transaction est incertaine et doit etre rapprochee avant toute nouvelle tentative"
    );
  }
}

export function isRealtimeCommitUncertainError(error: unknown): error is RealtimeCommitUncertainError {
  return error instanceof RealtimeCommitUncertainError;
}

export function realtimeOutboxEventKey(deduplicationKey: string): string {
  return `${REALTIME_EVENT_KEY_PREFIX}${deduplicationKey}`;
}

/**
 * Called only after the current transaction inserted a fresh outbox row.
 * A pre-existing idempotency key is deliberately not evidence that this
 * transaction committed.
 */
export function trackInsertedRealtimeOutboxEvent(tx: object, evidence: InsertedRealtimeOutboxEvidence): void {
  realtimeTransactionContexts.get(tx)?.insertedEvents.set(evidence.eventKey, evidence.eventId);
}

export type RealtimeCommitReconciliation = "committed" | "not_committed" | "unknown";

type RealtimeTransactionOptions<T> = {
  transactionAlreadyStarted?: boolean;
  joinExistingTransaction?: boolean;
  reconcileCommit?: (verifier: PoolClient, result: T) => Promise<RealtimeCommitReconciliation>;
};

async function visibleInsertedEvents(
  verifier: PoolClient,
  expectedEvents: readonly InsertedRealtimeOutboxEvidence[]
): Promise<Set<string>> {
  const eventKeys = expectedEvents.map((event) => event.eventKey);
  const eventIds = expectedEvents.map((event) => event.eventId);
  const { rows } = await verifier.query<{ event_key: string }>(
      `
        SELECT outbox.event_key
        FROM public.erp_outbox_events outbox
        JOIN unnest($1::text[], $2::uuid[]) AS expected(event_key, event_id)
          ON expected.event_key = outbox.event_key
         AND expected.event_id = outbox.correlation_id
      `,
      [eventKeys, eventIds]
  );
  return new Set(rows.map((row) => row.event_key));
}

/**
 * Owns BEGIN/COMMIT/release for a business mutation that writes realtime
 * outbox rows. If the COMMIT acknowledgement is lost, the original connection
 * is destroyed and the durable event keys resolve the transaction outcome.
 */
export async function withRealtimeOutboxTransaction<T>(
  client: PoolClient,
  work: (tx: PoolClient) => Promise<T>,
  options: RealtimeTransactionOptions<T> = {}
): Promise<T> {
  const activeContext = realtimeTransactionContexts.get(client);
  if (activeContext) {
    if (!options.joinExistingTransaction) {
      throw new HttpError(
        500,
        "REALTIME_NESTED_TRANSACTION_FORBIDDEN",
        "Une transaction temps reel est deja active sur cette connexion"
      );
    }
    if (options.transactionAlreadyStarted || options.reconcileCommit) {
      throw new HttpError(
        500,
        "REALTIME_NESTED_TRANSACTION_OPTIONS_INVALID",
        "La transaction jointe ne peut pas posseder le cycle de commit"
      );
    }
    activeContext.depth += 1;
    try {
      return await work(client);
    } finally {
      activeContext.depth -= 1;
    }
  }
  if (options.joinExistingTransaction) {
    throw new HttpError(
      500,
      "REALTIME_TRANSACTION_JOIN_WITHOUT_OWNER",
      "Aucune transaction temps reel active ne peut etre jointe"
    );
  }

  const context: RealtimeTransactionContext = {
    owner: Symbol("realtime-transaction-owner"),
    depth: 1,
    insertedEvents: new Map<string, string>(),
  };
  realtimeTransactionContexts.set(client, context);
  let commitAttempted = false;
  let transactionOpen = options.transactionAlreadyStarted === true;
  let released = false;
  try {
    if (!transactionOpen) {
      try {
        await client.query("BEGIN");
        transactionOpen = true;
      } catch {
        released = true;
        client.release(true);
        throw new HttpError(503, "REALTIME_TRANSACTION_START_FAILED", "La transaction n'a pas pu etre demarree");
      }
    }
    const result = await work(client);
    commitAttempted = true;
    try {
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (commitError) {
      released = true;
      client.release(true);
      const expected = [...context.insertedEvents].map(([eventKey, eventId]) => ({ eventKey, eventId }));
      const evidence: RealtimeCommitReconciliation[] = [];
      const verifier = await pool.connect().catch(() => null);
      if (!verifier) throw new RealtimeCommitUncertainError();
      let verifierReleased = false;
      try {
        if (expected.length > 0) {
          const visible = await visibleInsertedEvents(verifier, expected);
          evidence.push(
            expected.every(({ eventKey }) => visible.has(eventKey))
              ? "committed"
              : visible.size === 0
                ? "not_committed"
                : "unknown"
          );
          if (visible.size > 0 && visible.size < expected.length) {
            console.error(JSON.stringify({
              type: "realtime_commit_reconciliation_partial",
              expected_event_count: expected.length,
              visible_event_count: visible.size,
            }));
          }
        }
        if (options.reconcileCommit) evidence.push(await options.reconcileCommit(verifier, result));
      } catch {
        verifierReleased = true;
        verifier.release(true);
        console.error(JSON.stringify({
          type: "realtime_commit_reconciliation_failed",
          expected_event_count: expected.length,
        }));
        throw new RealtimeCommitUncertainError();
      } finally {
        if (!verifierReleased) verifier.release();
      }
      if (evidence.length > 0 && evidence.every((item) => item === "committed")) return result;
      if (evidence.length > 0 && evidence.every((item) => item === "not_committed")) throw commitError;
      throw new RealtimeCommitUncertainError();
    }
  } catch (error) {
    if (!commitAttempted && transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        if (!released) {
          released = true;
          client.release(true);
        }
        throw new RealtimeCommitUncertainError();
      }
    }
    throw error;
  } finally {
    if (realtimeTransactionContexts.get(client)?.owner === context.owner) {
      realtimeTransactionContexts.delete(client);
    }
    if (!released) client.release();
  }
}
