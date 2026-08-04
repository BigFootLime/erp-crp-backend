type QueryDelegate = (sql: unknown, params?: unknown[]) => unknown;

type RealtimeOutboxDbMockOptions = {
  onOutboxInsert?: QueryDelegate;
};

/**
 * Keeps route/repository tests focused on their business SQL while emulating
 * the infrastructure queries issued by the durable realtime outbox. Dedicated
 * realtime tests exercise these statements and their failure paths directly.
 */
export function withRealtimeOutboxDbMock(
  delegate: QueryDelegate,
  options: RealtimeOutboxDbMockOptions = {}
): QueryDelegate {
  return (sql: unknown, params?: unknown[]) => {
    const statement = String(sql);
    if (statement.includes("pg_advisory_xact_lock")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (
      statement.includes("SELECT")
      && statement.includes("correlation_id::text AS event_id")
      && statement.includes("FROM public.erp_outbox_events")
      && statement.includes("WHERE event_key = $1")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (statement.includes("INSERT INTO public.realtime_stream_enqueue_state")) {
      return Promise.resolve({ rows: [{ stream_ordinal: "1" }], rowCount: 1 });
    }
    if (statement.includes("INSERT INTO public.erp_outbox_events")) {
      if (options.onOutboxInsert) return options.onOutboxInsert(sql, params);
      const eventId = typeof params?.[5] === "string"
        ? params[5]
        : "00000000-0000-4000-8000-000000000001";
      return Promise.resolve({ rows: [{ event_id: eventId }], rowCount: 1 });
    }
    return params === undefined ? delegate(sql) : delegate(sql, params);
  };
}
