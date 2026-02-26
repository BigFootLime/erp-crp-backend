import { Client } from "pg";

import { emitAuditNew } from "./realtime.service";

const CHANNEL = "erp_audit_new";

export type StopAuditNotifyListener = () => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startAuditNotifyListener(): Promise<StopAuditNotifyListener> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[audit_notify] DATABASE_URL is missing; audit:new realtime disabled");
    return async () => {};
  }

  const client = new Client({ connectionString });
  client.on("error", (err) => {
    console.error("[audit_notify] listener error", err);
  });

  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);

  client.on("notification", (msg) => {
    if (msg.channel !== CHANNEL) return;
    const raw = typeof msg.payload === "string" ? msg.payload : "";
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return;
      const auditId = parsed.auditId;
      if (typeof auditId !== "string" || !auditId.trim()) return;
      emitAuditNew({ auditId });
    } catch (err) {
      console.warn("[audit_notify] invalid payload", {
        error: err instanceof Error ? err.name : "unknown",
        payload: raw,
      });
    }
  });

  return async () => {
    try {
      await client.query(`UNLISTEN ${CHANNEL}`);
    } catch (err) {
      console.warn("[audit_notify] UNLISTEN failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }

    try {
      await client.end();
    } catch (err) {
      console.warn("[audit_notify] listener shutdown failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  };
}
