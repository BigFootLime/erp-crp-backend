import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

type Phase = "IDLE" | "PREPARING" | "ACTIVE";

async function gate(client: PoolClient, lock: "SHARE" | "UPDATE") {
  const relation = await client.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", ["public.financial_cutover_gate"]);
  if (!relation.rows[0]?.relation) throw new HttpError(503, "FINANCIAL_CUTOVER_GUARD_NOT_INSTALLED", "Le verrou de bascule financière n'est pas installé. Aucune émission ne peut être sécurisée.");
  const row = await client.query<{ phase: Phase }>(`SELECT phase FROM public.financial_cutover_gate WHERE singleton=TRUE FOR ${lock}`);
  if (!row.rows[0]) throw new HttpError(503, "FINANCIAL_CUTOVER_GUARD_NOT_READY", "Le verrou de bascule financière n'est pas initialisé.");
  return row.rows[0];
}

export async function assertFinancialCutoverEmissionAllowedTx(client: PoolClient) {
  const row = await gate(client, "SHARE");
  if (row.phase !== "IDLE" && row.phase !== "ACTIVE") throw new HttpError(409, "FINANCIAL_CUTOVER_SUSPENDED", "Les factures, acomptes, avoirs et proformas restent dans Excel jusqu'à l'activation contrôlée de la bascule financière.");
  return { phase: row.phase };
}

/** Called with creation of the first preparation batch; ACTIVE never moves backwards. */
export async function startFinancialCutoverPreparationTx(client: PoolClient, input: { actorId: number; batchId: string }) {
  const row = await gate(client, "UPDATE");
  if (row.phase === "ACTIVE" || row.phase === "PREPARING") return { phase: row.phase };
  await client.query("UPDATE public.financial_cutover_gate SET phase='PREPARING',started_at=now(),started_by=$1,started_batch_id=$2::uuid,updated_at=now() WHERE singleton=TRUE", [input.actorId, input.batchId]);
  await client.query("INSERT INTO public.financial_cutover_events(action,actor_user_id,batch_id,details) VALUES('PREPARATION_STARTED',$1,$2::uuid,'{}'::jsonb)", [input.actorId, input.batchId]);
  return { phase: "PREPARING" as const };
}

export async function getFinancialCutoverStatusTx(client: PoolClient) {
  const row = await gate(client, "SHARE");
  return { phase: row.phase };
}

/** Must run in the same transaction after common FACTURE/AVOIR series activation. */
export async function activateFinancialCutoverEmissionTx(client: PoolClient, input: { actorId: number; entityCode: string; periodKey: string; proformaNextValue: number; evidenceReference: string }) {
  if (!Number.isSafeInteger(input.proformaNextValue) || input.proformaNextValue <= 0 || !/^[0-9]{4}$/.test(input.periodKey) || !input.evidenceReference.trim()) throw new HttpError(422, "FINANCIAL_CUTOVER_ACTIVATION_INVALID", "Les derniers numéros vérifiés et leur justificatif sont requis.");
  const row = await gate(client, "UPDATE");
  if (row.phase !== "PREPARING") throw new HttpError(409, "FINANCIAL_CUTOVER_NOT_PREPARING", "La bascule financière doit d'abord être suspendue par un dossier de reprise.");
  const currentYear = await client.query<{ year: string }>("SELECT to_char(CURRENT_DATE,'YYYY') AS year");
  if (currentYear.rows[0]?.year !== input.periodKey) {
    throw new HttpError(409, "FINANCIAL_CUTOVER_PROFORMA_PERIOD_INVALID", "L'année de la prochaine proforma doit correspondre à l'année courante d'émission.");
  }
  const common = await client.query("SELECT 1 FROM public.cutover_finance_shared_sequences WHERE entity_code=$1 AND period_key=$2 AND active=TRUE FOR KEY SHARE", [input.entityCode, input.periodKey]);
  if (!common.rows.length) throw new HttpError(409, "FINANCIAL_CUTOVER_SHARED_SERIES_REQUIRED", "La série commune factures, acomptes et avoirs doit être activée avant la bascule.");
  const proformaState = await client.query<{ next_value: string; max_consumed: string | null }>(
    `SELECT
       (last_value + CASE WHEN is_called THEN 1 ELSE 0 END)::text AS next_value,
       (SELECT max((regexp_match(reference, '^PF-[0-9]{4}-([0-9]+)$'))[1]::bigint)::text FROM public.proforma_client) AS max_consumed
     FROM public.proforma_client_reference_seq`,
  );
  const currentNext = Number(proformaState.rows[0]?.next_value);
  const maxConsumed = Number(proformaState.rows[0]?.max_consumed ?? 0);
  if (!Number.isSafeInteger(currentNext) || !Number.isSafeInteger(maxConsumed)) {
    throw new HttpError(503, "FINANCIAL_CUTOVER_PROFORMA_SEQUENCE_INVALID", "La séquence de proformas ne peut pas être vérifiée de manière sûre.");
  }
  const minimumNext = Math.max(currentNext, maxConsumed + 1);
  if (input.proformaNextValue < minimumNext) {
    throw new HttpError(409, "FINANCIAL_CUTOVER_PROFORMA_SEQUENCE_BACKWARD", "Le prochain numéro de proforma ne peut pas revenir en arrière.", { minimum_next_value: minimumNext });
  }
  // PostgreSQL setval is intentionally non-transactional. It can reserve a
  // harmless gap after a later rollback, but it must never reassign a number.
  await client.query("SELECT setval('public.proforma_client_reference_seq',$1,false)", [input.proformaNextValue]);
  await client.query("UPDATE public.financial_cutover_gate SET phase='ACTIVE',activated_at=now(),activated_by=$1,activation_evidence_reference=$2,updated_at=now() WHERE singleton=TRUE", [input.actorId, input.evidenceReference.trim()]);
  await client.query("INSERT INTO public.financial_cutover_events(action,actor_user_id,details) VALUES('ACTIVATED',$1,jsonb_build_object('entity_code',$2::text,'period_key',$3::text,'proforma_next_value',$4::bigint,'evidence_reference',$5::text))", [input.actorId,input.entityCode,input.periodKey,input.proformaNextValue,input.evidenceReference.trim()]);
}
