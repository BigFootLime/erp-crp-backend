import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { companyRuntimeConfiguration } from "../runtime/company-runtime.config";
import { intercompanyDigest, parseIntercompanyMessage, type IntercompanyMessage, type IntercompanyMessageKind } from "./intercompany-message";

export type EnqueueIntercompanyMessageInput = {
  destination_company_id: string;
  kind: IntercompanyMessageKind;
  aggregate_id: string;
  revision: number;
  payload: Record<string, unknown>;
};

/** Caller owns the business transaction. No network call occurs before commit. */
export async function enqueueIntercompanyMessageTx(tx: Pick<PoolClient, "query">, input: EnqueueIntercompanyMessageInput): Promise<IntercompanyMessage> {
  const runtime = companyRuntimeConfiguration();
  if (!runtime.enabled)
    throw new HttpError(503, "INTERCOMPANY_RUNTIME_REQUIRED", "Le contexte entreprise doit être configuré.");
  const message = parseIntercompanyMessage({
    ...input, id: randomUUID(), source_company_id: runtime.company_id,
    environment: runtime.environment, occurred_at: new Date().toISOString(),
    payload_sha256: intercompanyDigest(input.payload),
  });
  const inserted = await tx.query<{ message: IntercompanyMessage }>(
    `INSERT INTO public.cerp_intercompany_outbox
      (id,source_company_id,destination_company_id,environment,kind,aggregate_id,revision,payload_sha256,message)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT(source_company_id,destination_company_id,environment,kind,aggregate_id,revision) DO NOTHING
     RETURNING message`,
    [message.id, message.source_company_id, message.destination_company_id, message.environment,
      message.kind, message.aggregate_id, message.revision, message.payload_sha256, JSON.stringify(message)],
  );
  if (inserted.rows[0]) return parseIntercompanyMessage(inserted.rows[0].message);
  const existing = await tx.query<{ message: IntercompanyMessage }>(
    `SELECT message FROM public.cerp_intercompany_outbox WHERE source_company_id=$1::uuid
     AND destination_company_id=$2::uuid AND environment=$3 AND kind=$4 AND aggregate_id=$5 AND revision=$6`,
    [message.source_company_id, message.destination_company_id, message.environment, message.kind, message.aggregate_id, message.revision],
  );
  const prior = existing.rows[0] ? parseIntercompanyMessage(existing.rows[0].message) : null;
  if (!prior || prior.payload_sha256 !== message.payload_sha256)
    throw new HttpError(409, "INTERCOMPANY_MESSAGE_REVISION_CONFLICT", "Cette révision a déjà un contenu différent.");
  return prior;
}
