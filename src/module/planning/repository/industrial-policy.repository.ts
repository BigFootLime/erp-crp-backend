import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
type Db = Pick<PoolClient, "query">;
export async function readIndustrialPolicy(
  db: Db,
  clientId: string,
  lock = false,
) {
  // A client row exists even before its first policy. The lock also serializes first-use settings and decisions.
  const client = await db.query(
    "SELECT client_id FROM public.clients WHERE client_id=$1" +
      (lock ? " FOR UPDATE" : ""),
    [clientId],
  );
  if (!client.rowCount)
    throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
  return (
    (
      await db.query<{
        client_id: string;
        version: number;
        auto_enabled: boolean;
        auto_actor_id: number | null;
        auto_ar_contact_id: string | null;
        transit_calendar_days: number | null;
        risk_limit_eur: number | null;
        frozen_days: 14;
      }>(
        "SELECT client_id,version,auto_enabled,CASE WHEN auto_enabled THEN updated_by END AS auto_actor_id,auto_ar_contact_id,transit_calendar_days,risk_limit_eur::float8,14 AS frozen_days FROM public.industrial_policies WHERE client_id=$1",
        [clientId],
      )
    ).rows[0] ?? {
      client_id: clientId,
      version: 0,
      auto_enabled: false,
      auto_actor_id: null,
      auto_ar_contact_id: null,
      transit_calendar_days: null,
      risk_limit_eur: null,
      frozen_days: 14 as const,
    }
  );
}
export async function setIndustrialPolicy(
  db: Db,
  actor: number,
  input: {
    client_id: string;
    expected_version: number;
    auto_enabled: boolean;
    risk_limit_eur: number | null;
    auto_ar_contact_id?: string | null;
    transit_calendar_days?: number | null;
  },
) {
  const before = await readIndustrialPolicy(db, input.client_id, true);
  if (before.version !== input.expected_version)
    throw new HttpError(
      409,
      "POLICY_CHANGED",
      "La politique a été modifiée. Rechargez-la.",
    );
  const contact =
    input.auto_ar_contact_id === undefined
      ? before.auto_ar_contact_id
      : input.auto_ar_contact_id;
  if (
    contact &&
    !(
      await db.query(
        "SELECT 1 FROM public.contacts WHERE client_id=$1 AND contact_id=$2 AND NULLIF(trim(email),'') IS NOT NULL FOR SHARE",
        [input.client_id, contact],
      )
    ).rowCount
  )
    throw new HttpError(
      422,
      "AR_CONTACT_SCOPE",
      "Contact AR sans adresse ou étranger au client.",
    );
  await db.query(
    `INSERT INTO public.industrial_policies(client_id,version,auto_enabled,risk_limit_eur,updated_by,auto_ar_contact_id,transit_calendar_days) VALUES($1,1,$2,$3,$4,$5,$6)
   ON CONFLICT(client_id) DO UPDATE SET version=industrial_policies.version+1,auto_enabled=excluded.auto_enabled,
   risk_limit_eur=excluded.risk_limit_eur,updated_by=excluded.updated_by,auto_ar_contact_id=excluded.auto_ar_contact_id,transit_calendar_days=excluded.transit_calendar_days,updated_at=now()`,
    [
      input.client_id,
      input.auto_enabled,
      input.risk_limit_eur,
      actor,
      contact,
      input.transit_calendar_days === undefined
        ? before.transit_calendar_days
        : input.transit_calendar_days,
    ],
  );
  const after = await readIndustrialPolicy(db, input.client_id);
  await db.query(
    "INSERT INTO public.industrial_policy_events(client_id,actor_id,snapshot) VALUES($1,$2,$3)",
    [input.client_id, actor, JSON.stringify({ before, after })],
  );
  return after;
}
