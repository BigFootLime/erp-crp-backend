import crypto from "node:crypto";

import pool from "../../config/database";

export type ChatPresenceDelta = { userId: number; online: boolean };
export type ChatPresenceSnapshot = { known: boolean; onlineUserIds: number[] };

export interface ChatPresenceRegistry {
  connect(userId: number, connectionId: string): Promise<ChatPresenceDelta | null>;
  heartbeat(userId: number, connectionId: string): Promise<ChatPresenceDelta | null>;
  disconnect(userId: number, connectionId: string): Promise<ChatPresenceDelta | null>;
  sweepExpired(): Promise<ChatPresenceDelta[]>;
  snapshot(): Promise<ChatPresenceSnapshot>;
}

function ttlSeconds(): number {
  const value = Number.parseInt(process.env.REALTIME_PRESENCE_TTL_SECONDS ?? "45", 10);
  return Number.isSafeInteger(value) && value >= 10 && value <= 3_600 ? value : 45;
}

/**
 * PostgreSQL is the presence source of truth. Rows identify one Socket.IO
 * connection on one process; per-user advisory locks make the 0 -> 1 and
 * 1 -> 0 transitions exact even when different nodes race each other.
 */
export class PostgresChatPresenceRegistry implements ChatPresenceRegistry {
  readonly nodeId: string;

  constructor(nodeId = process.env.REALTIME_NODE_ID?.trim() || crypto.randomUUID()) {
    this.nodeId = nodeId.slice(0, 128);
  }

  async connect(userId: number, connectionId: string): Promise<ChatPresenceDelta | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
      await client.query("DELETE FROM public.realtime_chat_presence WHERE expires_at <= clock_timestamp() AND user_id = $1", [userId]);
      const before = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.realtime_chat_presence WHERE user_id = $1", [userId]);
      await client.query(
        `INSERT INTO public.realtime_chat_presence (node_id, connection_id, user_id, last_seen_at, expires_at)
         VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp() + ($4::text || ' seconds')::interval)
         ON CONFLICT (node_id, connection_id) DO UPDATE
           SET user_id = EXCLUDED.user_id, last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at`,
        [this.nodeId, connectionId, userId, ttlSeconds()]
      );
      const online = Number(before.rows[0]?.count ?? "0") === 0;
      if (online) await client.query("SELECT pg_notify('cerp_realtime_control', $1)", [JSON.stringify({ kind: "presence_changed", userId, online: true })]);
      await client.query("COMMIT");
      return online ? { userId, online: true } : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async heartbeat(userId: number, connectionId: string): Promise<ChatPresenceDelta | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
      await client.query(
        "DELETE FROM public.realtime_chat_presence WHERE expires_at <= clock_timestamp() AND user_id = $1",
        [userId]
      );
      const before = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM public.realtime_chat_presence WHERE user_id = $1",
        [userId]
      );
      await client.query(
        `INSERT INTO public.realtime_chat_presence (node_id, connection_id, user_id, last_seen_at, expires_at)
         VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp() + ($4::text || ' seconds')::interval)
         ON CONFLICT (node_id, connection_id) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               last_seen_at = EXCLUDED.last_seen_at,
               expires_at = EXCLUDED.expires_at`,
        [this.nodeId, connectionId, userId, ttlSeconds()]
      );
      const recoveredOnline = Number(before.rows[0]?.count ?? "0") === 0;
      if (recoveredOnline) {
        await client.query("SELECT pg_notify('cerp_realtime_control', $1)", [
          JSON.stringify({ kind: "presence_changed", userId, online: true }),
        ]);
      }
      await client.query("COMMIT");
      return recoveredOnline ? { userId, online: true } : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async disconnect(userId: number, connectionId: string): Promise<ChatPresenceDelta | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
      const deleted = await client.query("DELETE FROM public.realtime_chat_presence WHERE node_id = $1 AND connection_id = $2 AND user_id = $3 RETURNING user_id", [this.nodeId, connectionId, userId]);
      if (deleted.rowCount === 0) { await client.query("COMMIT"); return null; }
      await client.query("DELETE FROM public.realtime_chat_presence WHERE expires_at <= clock_timestamp() AND user_id = $1", [userId]);
      const remaining = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.realtime_chat_presence WHERE user_id = $1", [userId]);
      const offline = Number(remaining.rows[0]?.count ?? "0") === 0;
      if (offline) await client.query("SELECT pg_notify('cerp_realtime_control', $1)", [JSON.stringify({ kind: "presence_changed", userId, online: false })]);
      await client.query("COMMIT");
      return offline ? { userId, online: false } : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async sweepExpired(): Promise<ChatPresenceDelta[]> {
    // Serialize sweeps globally, then take the same per-user lock as connect
    // and disconnect *before* deleting rows. Deleting first can deadlock with
    // a concurrent connect (row lock -> advisory lock vs advisory -> row lock)
    // and can emit a stale offline transition after a fresh connection wins.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9223372036854775806::bigint)");
      const expired = await client.query<{ user_id: string }>(
        "SELECT DISTINCT user_id::text FROM public.realtime_chat_presence WHERE expires_at <= clock_timestamp() ORDER BY user_id::text"
      );
      const userIds = [...new Set(expired.rows.map((row) => Number(row.user_id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
        .sort((left, right) => left - right);
      const deltas: ChatPresenceDelta[] = [];
      for (const userId of userIds) {
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
        const deleted = await client.query(
          "DELETE FROM public.realtime_chat_presence WHERE expires_at <= clock_timestamp() AND user_id = $1",
          [userId]
        );
        if (deleted.rowCount === 0) continue;
        const remaining = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.realtime_chat_presence WHERE user_id = $1", [userId]);
        if (Number(remaining.rows[0]?.count ?? "0") === 0) {
          const delta = { userId, online: false };
          deltas.push(delta);
          await client.query("SELECT pg_notify('cerp_realtime_control', $1)", [JSON.stringify({ kind: "presence_changed", ...delta })]);
        }
      }
      await client.query("COMMIT");
      return deltas;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async snapshot(): Promise<ChatPresenceSnapshot> {
    const { rows } = await pool.query<{ user_id: string }>(
      "SELECT DISTINCT user_id::text FROM public.realtime_chat_presence WHERE expires_at > clock_timestamp() ORDER BY user_id"
    );
    return { known: true, onlineUserIds: rows.map((row) => Number(row.user_id)).filter((id) => Number.isSafeInteger(id) && id > 0) };
  }
}

/** Test-only / explicitly injected registry. It preserves transition semantics. */
export class MemoryChatPresenceRegistry implements ChatPresenceRegistry {
  private readonly connections = new Map<number, Set<string>>();
  async connect(userId: number, connectionId: string) { const set = this.connections.get(userId) ?? new Set<string>(); const first = set.size === 0; set.add(connectionId); this.connections.set(userId, set); return first ? { userId, online: true } : null; }
  async heartbeat() { return null; /* process-local test registry has no expiry */ }
  async disconnect(userId: number, connectionId: string) { const set = this.connections.get(userId); if (!set) return null; set.delete(connectionId); if (set.size) return null; this.connections.delete(userId); return { userId, online: false }; }
  async sweepExpired() { return []; }
  async snapshot() { return { known: true, onlineUserIds: [...this.connections.keys()].sort((a, b) => a - b) }; }
}
