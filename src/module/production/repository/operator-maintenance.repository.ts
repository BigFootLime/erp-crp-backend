import crypto from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  validateMaintenanceResults,
  type MaintenanceCommand,
  type MaintenanceChecklistItem,
} from "../domain/operator-maintenance";
import { maintenanceEvidenceTx } from "./operator-maintenance-read.repository";
type Plan = {
  id: string;
  machine_id: string;
  title: string;
  status: string;
  version: number;
  frequency_days: number | null;
  frequency_counter: number | null;
  counter_unit: string | null;
  counter_value: number | null;
  next_due_counter: number | null;
  next_due_at: string | null;
  checklist: MaintenanceChecklistItem[];
};
export const MAINTENANCE_PLAN_LOCK_SQL = `SELECT id::text,machine_id::text,title,status,version,frequency_days,frequency_counter::float8,counter_unit,counter_value::float8,next_due_counter::float8,next_due_at::text,checklist FROM public.production_machine_maintenance_plans WHERE id=$1::uuid AND machine_id=$2::uuid AND archived_at IS NULL FOR UPDATE`;
function requireManager(manager: boolean) {
  if (!manager)
    throw new HttpError(
      403,
      "MAINTENANCE_MANAGER_REQUIRED",
      "Cette décision nécessite un responsable maintenance, la direction ou l’administration.",
    );
}
async function planTx(tx: PoolClient, machineId: string, id: string) {
  const plan = (
    await tx.query<Plan>(MAINTENANCE_PLAN_LOCK_SQL, [id, machineId])
  ).rows[0];
  if (!plan)
    throw new HttpError(
      404,
      "MAINTENANCE_PLAN_NOT_FOUND",
      "Plan introuvable pour cette machine.",
    );
  return plan;
}
async function authorizationTx(
  tx: PoolClient,
  plan: Plan,
  actor: number,
  today: string,
) {
  const row = (
    await tx.query(
      `SELECT a.id::text,a.enabled,a.valid_from::text,a.valid_to::text,u.status FROM public.production_maintenance_authorizations a JOIN public.users u ON u.id=a.user_id WHERE a.plan_id=$1::uuid AND a.user_id=$2 ORDER BY a.revision DESC LIMIT 1`,
      [plan.id, actor],
    )
  ).rows[0];
  if (
    !row ||
    !row.enabled ||
    row.valid_from > today ||
    row.valid_to < today ||
    ["inactive", "blocked", "suspended"].includes(
      String(row.status ?? "active")
        .trim()
        .toLowerCase(),
    )
  )
    throw new HttpError(
      403,
      "MAINTENANCE_OPERATOR_NOT_AUTHORIZED",
      "Une habilitation nominative valide est requise pour exécuter ce plan.",
    );
  return row;
}
async function counterTx(
  tx: PoolClient,
  plan: Plan,
  value: number,
  reset: boolean,
  nextDue: number | null,
  reason: string,
  actor: number,
) {
  if (!reset && plan.counter_value !== null && value < plan.counter_value)
    throw new HttpError(
      422,
      "MAINTENANCE_COUNTER_DECREASE",
      "Le compteur est inférieur au précédent. Un responsable doit justifier sa remise à zéro.",
    );
  if (reset && plan.frequency_counter && (nextDue === null || nextDue <= value))
    throw new HttpError(
      422,
      "MAINTENANCE_COUNTER_THRESHOLD_REQUIRED",
      "Définissez un nouveau seuil supérieur au compteur remis à zéro.",
    );
  await tx.query(
    "INSERT INTO public.production_maintenance_counter_readings(machine_id,plan_id,value,reset,reason,created_by)VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)",
    [plan.machine_id, plan.id, value, reset, reason, actor],
  );
  await tx.query(
    "UPDATE public.production_machine_maintenance_plans SET counter_value=$2,next_due_counter=CASE WHEN $3 THEN $4 ELSE next_due_counter END,version=version+1,updated_at=now(),updated_by=$5 WHERE id=$1::uuid",
    [plan.id, value, reset, nextDue, actor],
  );
}
export async function repoMaintenanceCommand(
  machineId: string,
  input: MaintenanceCommand,
  actor: number,
  manager: boolean,
) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ machineId, input, actor }))
    .digest("hex");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `maintenance-command:${input.idempotency_key}`,
    ]);
    const replay = (
      await tx.query(
        "SELECT request_hash,result FROM public.production_maintenance_commands WHERE idempotency_key=$1::uuid",
        [input.idempotency_key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== hash)
        throw new HttpError(
          409,
          "MAINTENANCE_REQUEST_CONFLICT",
          "Cette demande a déjà été utilisée avec un autre contenu.",
        );
      await tx.query("COMMIT");
      return replay.result;
    }
    const machine = (
      await tx.query(
        "SELECT id,archived_at,(statement_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today FROM public.machines WHERE id=$1::uuid FOR UPDATE",
        [machineId],
      )
    ).rows[0];
    if (!machine)
      throw new HttpError(404, "MACHINE_NOT_FOUND", "Machine introuvable.");
    if (machine.archived_at)
      throw new HttpError(
        409,
        "MACHINE_ARCHIVED",
        "Cette machine est archivée.",
      );
    let result: Record<string, unknown>;
    if (input.action === "RESOLVE") {
      requireManager(manager);
      const hold = (
        await tx.query(
          "SELECT id FROM public.production_maintenance_holds WHERE id=$1::uuid AND machine_id=$2::uuid AND resolved_at IS NULL FOR UPDATE",
          [input.hold_id, machineId],
        )
      ).rows[0];
      if (!hold)
        throw new HttpError(
          409,
          "MAINTENANCE_HOLD_ALREADY_RESOLVED",
          "Arrêt introuvable ou déjà levé.",
        );
      const evidence = await maintenanceEvidenceTx(
        tx,
        machineId,
        input.document_id,
      );
      await tx.query(
        "UPDATE public.production_maintenance_holds SET resolved_at=now(),resolved_by=$2,resolution_reason=$3,resolution_document_id=$4::uuid,resolution_evidence=$5::jsonb WHERE id=$1::uuid",
        [hold.id, actor, input.reason, evidence.id, JSON.stringify(evidence)],
      );
      result = { hold_id: hold.id, resolved: true };
    } else {
      const plan = await planTx(tx, machineId, input.plan_id);
      if (input.action === "AUTHORIZE") {
        requireManager(manager);
        if (
          !(
            await tx.query(
              "SELECT id FROM public.users WHERE id=$1 AND COALESCE(NULLIF(lower(trim(status)),''),'active') NOT IN ('inactive','blocked','suspended') FOR SHARE",
              [input.user_id],
            )
          ).rows.length
        )
          throw new HttpError(
            422,
            "MAINTENANCE_OPERATOR_INVALID",
            "Choisissez un opérateur actif.",
          );
        const evidence = await maintenanceEvidenceTx(
          tx,
          machineId,
          input.document_id,
        );
        const row = (
          await tx.query(
            `INSERT INTO public.production_maintenance_authorizations(plan_id,user_id,revision,enabled,valid_from,valid_to,reason,document_id,evidence_snapshot,created_by)SELECT $1::uuid,$2,COALESCE(max(revision),0)+1,$3,$4::date,$5::date,$6,$7::uuid,$8::jsonb,$9 FROM public.production_maintenance_authorizations WHERE plan_id=$1::uuid AND user_id=$2 RETURNING id::text,revision`,
            [
              plan.id,
              input.user_id,
              input.enabled,
              input.valid_from,
              input.valid_to,
              input.reason,
              evidence.id,
              JSON.stringify(evidence),
              actor,
            ],
          )
        ).rows[0];
        result = { authorization_id: row.id, revision: row.revision };
      } else {
        if (plan.version !== input.expected_version)
          throw new HttpError(
            409,
            "MAINTENANCE_PLAN_CHANGED",
            "Le plan ou le compteur a changé. Rechargez avant de valider.",
          );
        if (plan.status !== "ACTIVE")
          throw new HttpError(
            409,
            "MAINTENANCE_PLAN_NOT_ACTIVE",
            "Ce plan n’est pas actif.",
          );
        const authorization =
          manager && input.action === "READ_COUNTER"
            ? null
            : await authorizationTx(tx, plan, actor, machine.today);
        if (input.action === "READ_COUNTER") {
          if (input.reset) requireManager(manager);
          await counterTx(
            tx,
            plan,
            input.value,
            input.reset,
            input.next_due_counter,
            input.reason,
            actor,
          );
          result = { plan_id: plan.id, counter_value: input.value };
        } else {
          if (!authorization)
            throw new HttpError(
              403,
              "MAINTENANCE_OPERATOR_NOT_AUTHORIZED",
              "Habilitation requise.",
            );
          const blocking = validateMaintenanceResults(
            plan.checklist,
            input.results,
          );
          const evidence = await maintenanceEvidenceTx(
            tx,
            machineId,
            input.document_id,
          );
          if (
            plan.frequency_counter &&
            (input.counter_value === null ||
              plan.next_due_counter === null ||
              !plan.counter_unit)
          )
            throw new HttpError(
              422,
              "MAINTENANCE_COUNTER_PROGRAM_INCOMPLETE",
              "Renseignez l’unité, le seuil et le compteur réel de ce programme.",
            );
          let nextCounter: number | null = plan.next_due_counter;
          if (input.counter_value !== null) {
            nextCounter = plan.frequency_counter
              ? Math.round(
                  (input.counter_value + plan.frequency_counter) * 1000,
                ) / 1000
              : plan.next_due_counter;
            if (nextCounter !== null && nextCounter > 99_999_999_999)
              throw new HttpError(
                422,
                "MAINTENANCE_COUNTER_OUT_OF_RANGE",
                "Le seuil dépasse la plage du compteur.",
              );
            await counterTx(
              tx,
              plan,
              input.counter_value,
              false,
              null,
              "Contrôle de maintenance",
              actor,
            );
          }
          const eventId = crypto.randomUUID();
          const receiptId = crypto.randomUUID();
          const nextDate = (
            await tx.query<{ next_date: string | null }>(
              "SELECT CASE WHEN $1::int IS NULL THEN NULL ELSE (statement_timestamp() AT TIME ZONE 'Europe/Paris')::date+$1::int END::text AS next_date",
              [plan.frequency_days],
            )
          ).rows[0].next_date;
          await tx.query(
            "INSERT INTO public.production_machine_maintenance_events(id,machine_id,maintenance_plan_id,event_type,occurred_at,checklist_result,notes,created_by)VALUES($1::uuid,$2::uuid,$3::uuid,'COMPLETED',now(),$4::jsonb,$5,$6)",
            [
              eventId,
              machineId,
              plan.id,
              JSON.stringify(input.results),
              input.notes,
              actor,
            ],
          );
          const signature = (
            await tx.query(
              "SELECT id,username,name,surname FROM public.users WHERE id=$1",
              [actor],
            )
          ).rows[0];
          await tx.query(
            `INSERT INTO public.production_maintenance_receipts(id,event_id,machine_id,plan_id,authorization_id,document_id,plan_snapshot,evidence_snapshot,results,signature_snapshot,counter_value,next_due_at,next_due_counter,notes,created_by)VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::date,$13,$14,$15)`,
            [
              receiptId,
              eventId,
              machineId,
              plan.id,
              authorization.id,
              evidence.id,
              JSON.stringify(plan),
              JSON.stringify(evidence),
              JSON.stringify(input.results),
              JSON.stringify(signature),
              input.counter_value,
              nextDate,
              nextCounter,
              input.notes,
              actor,
            ],
          );
          for (const anomaly of blocking)
            await tx.query(
              "INSERT INTO public.production_maintenance_holds(machine_id,receipt_id,reason,created_by)VALUES($1::uuid,$2::uuid,$3,$4)",
              [
                machineId,
                receiptId,
                `${plan.checklist.find((item) => item.id === anomaly.id)?.label}: ${anomaly.note}`,
                actor,
              ],
            );
          await tx.query(
            "UPDATE public.production_machine_maintenance_plans SET next_due_at=$2::date,next_due_counter=$3,status=CASE WHEN frequency_days IS NULL AND frequency_counter IS NULL THEN 'COMPLETED' ELSE status END,version=version+1,updated_at=now(),updated_by=$4 WHERE id=$1::uuid",
            [plan.id, nextDate, nextCounter, actor],
          );
          result = {
            event_id: eventId,
            receipt_id: receiptId,
            blocking_anomalies: blocking.length,
          };
        }
      }
    }
    await tx.query(
      "INSERT INTO public.production_maintenance_commands(idempotency_key,actor_id,request_hash,result)VALUES($1::uuid,$2,$3,$4::jsonb)",
      [input.idempotency_key, actor, hash, JSON.stringify(result)],
    );
    await repoInsertAuditLog({
      tx,
      user_id: actor,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      body: {
        event_type: "ACTION",
        action: `OPERATOR_MAINTENANCE_${input.action}`,
        entity_type: "MACHINE",
        entity_id: machineId,
        details: { ...result, input },
      },
    });
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
