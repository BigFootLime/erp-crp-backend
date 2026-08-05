import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueAppNotificationCreated, enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type { ListProgrammationsQueryDTO } from "../validators/programmation.validators";
import type {
  Paginated,
  ProgrammationConstraintConflict,
  ProgrammationConstraintViolation,
  ProgrammationRescheduleCancelResult,
  ProgrammationRescheduleCandidate,
  ProgrammationRescheduleCommitResult,
  ProgrammationReschedulePreview,
  ProgrammationRescheduleSnapshot,
  ProgrammationTaskListItem,
} from "../types/programmation.types";
import type {
  CancelProgrammationRescheduleBodyDTO,
  CommitProgrammationRescheduleBodyDTO,
  PreviewProgrammationRescheduleBodyDTO,
} from "../validators/programmation.validators";
import type { AuditContext } from "../../planning/repository/planning.repository";

function isUndefinedTableError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

export async function repoListProgrammations(filters: ListProgrammationsQueryDTO): Promise<Paginated<ProgrammationTaskListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!filters.include_archived) {
    where.push("pr.archived_at IS NULL");
  }

  const fromP = push(filters.from);
  const toP = push(filters.to);

  // Date overlap (range end treated as exclusive, consistent with the frontend).
  where.push(
    `daterange(pr.date_commencement, (pr.date_fin + 1), '[)') && daterange(${fromP}::timestamptz::date, ${toP}::timestamptz::date, '[)')`
  );

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const countRes = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM public.programmations pr ${whereSql}`,
      values
    );
    const total = countRes.rows[0]?.total ?? 0;

    type Row = {
      id: string;
      piece_technique_id: string;
      piece_code: string;
      piece_designation: string;
      client_id: string | null;
      client_company_name: string | null;
      plan_reference: string | null;
      date_commencement: string;
      date_fin: string;
      programmer_user_id: number | null;
      programmer_name: string | null;
      machine_id: string | null;
      machine_code: string | null;
      machine_name: string | null;
      poste_id: string | null;
      poste_code: string | null;
      poste_label: string | null;
      of_operation_id: string | null;
      calendar_id: string | null;
      calendar_code: string | null;
      calendar_label: string | null;
      calendar_timezone: string | null;
      required_machine_family_code: string | null;
      required_skill_codes: string[] | null;
      version: number;
      created_at: string;
      updated_at: string;
      archived_at: string | null;
    };

    const dataRes = await pool.query<Row>(
      `
        SELECT
          pr.id::text AS id,
          pr.piece_technique_id::text AS piece_technique_id,
          pt.code_piece AS piece_code,
          pt.designation AS piece_designation,
          pt.client_id AS client_id,
          COALESCE(c.company_name, pt.client_name) AS client_company_name,
          pr.plan_reference,
          pr.date_commencement::text AS date_commencement,
          pr.date_fin::text AS date_fin,
          pr.programmer_user_id,
          u.username AS programmer_name,
          pr.machine_id::text AS machine_id,
          m.code AS machine_code,
          m.name AS machine_name,
          pr.poste_id::text AS poste_id,
          po.code AS poste_code,
          po.label AS poste_label,
          pr.of_operation_id::text AS of_operation_id,
          pr.calendar_id::text AS calendar_id,
          cal.code AS calendar_code,
          cal.label AS calendar_label,
          cal.timezone AS calendar_timezone,
          pr.required_machine_family_code,
          COALESCE(skills.required_skill_codes, '{}'::text[]) AS required_skill_codes,
          pr.version::int AS version,
          pr.created_at::text AS created_at,
          pr.updated_at::text AS updated_at,
          pr.archived_at::text AS archived_at
        FROM public.programmations pr
        JOIN public.pieces_techniques pt
          ON pt.id = pr.piece_technique_id
         AND pt.deleted_at IS NULL
        LEFT JOIN public.clients c ON c.client_id = pt.client_id
        LEFT JOIN public.users u ON u.id = pr.programmer_user_id
        LEFT JOIN public.machines m ON m.id = pr.machine_id
        LEFT JOIN public.postes po ON po.id = pr.poste_id
        LEFT JOIN public.programmation_calendars cal ON cal.id = pr.calendar_id
        LEFT JOIN LATERAL (
          SELECT array_agg(req.skill_code ORDER BY req.skill_code) AS required_skill_codes
          FROM public.programmation_required_skills req
          WHERE req.programmation_id = pr.id
        ) skills ON TRUE
        ${whereSql}
        ORDER BY pr.date_commencement ASC, pr.id ASC
      `,
      values
    );

    const items: ProgrammationTaskListItem[] = dataRes.rows.map((r) => ({
      id: r.id,
      piece_technique_id: r.piece_technique_id,
      piece_code: r.piece_code,
      piece_designation: r.piece_designation,
      client_id: r.client_id,
      client_company_name: r.client_company_name,
      plan_reference: r.plan_reference,
      date_commencement: r.date_commencement,
      date_fin: r.date_fin,
      programmer_user_id: r.programmer_user_id,
      programmer_name: r.programmer_name,
      machine_id: r.machine_id,
      machine_code: r.machine_code,
      machine_name: r.machine_name,
      poste_id: r.poste_id,
      poste_code: r.poste_code,
      poste_label: r.poste_label,
      of_operation_id: r.of_operation_id,
      calendar_id: r.calendar_id,
      calendar_code: r.calendar_code,
      calendar_label: r.calendar_label,
      calendar_timezone: r.calendar_timezone,
      required_machine_family_code: r.required_machine_family_code,
      required_skill_codes: r.required_skill_codes ?? [],
      version: r.version,
      created_at: r.created_at,
      updated_at: r.updated_at,
      archived_at: r.archived_at,
    }));

    return { items, total };
  } catch (err) {
    if (isUndefinedTableError(err)) {
      return { items: [], total: 0 };
    }
    throw err;
  }
}

type DbQueryer = Pick<PoolClient, "query">;

type SnapshotRow = {
  id: string;
  date_commencement: string;
  date_fin: string;
  programmer_user_id: number | null;
  programmer_name: string | null;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  poste_id: string | null;
  poste_code: string | null;
  poste_label: string | null;
  of_operation_id: string | null;
  calendar_id: string | null;
  calendar_code: string | null;
  calendar_label: string | null;
  calendar_timezone: string | null;
  required_machine_family_code: string | null;
  required_skill_codes: string[] | null;
  version: number;
  updated_at: string;
  archived_at: string | null;
  piece_code: string;
  piece_designation: string;
};

function mapSnapshot(row: SnapshotRow): ProgrammationRescheduleSnapshot {
  return {
    id: row.id,
    start_date: row.date_commencement,
    end_date: row.date_fin,
    programmer_user_id: row.programmer_user_id,
    programmer_name: row.programmer_name,
    machine_id: row.machine_id,
    machine_code: row.machine_code,
    machine_name: row.machine_name,
    poste_id: row.poste_id,
    poste_code: row.poste_code,
    poste_label: row.poste_label,
    of_operation_id: row.of_operation_id,
    calendar_id: row.calendar_id,
    calendar_code: row.calendar_code,
    calendar_label: row.calendar_label,
    calendar_timezone: row.calendar_timezone,
    required_machine_family_code: row.required_machine_family_code,
    required_skill_codes: row.required_skill_codes ?? [],
    version: row.version,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    piece_code: row.piece_code,
    piece_designation: row.piece_designation,
  };
}

async function selectProgrammationSnapshot(
  q: DbQueryer,
  id: string,
  options: { forUpdate?: boolean } = {}
): Promise<ProgrammationRescheduleSnapshot | null> {
  const result = await q.query<SnapshotRow>(
    `
      SELECT
        pr.id::text AS id,
        pr.date_commencement::text AS date_commencement,
        pr.date_fin::text AS date_fin,
        pr.programmer_user_id::int AS programmer_user_id,
        u.username AS programmer_name,
        pr.machine_id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,
        pr.poste_id::text AS poste_id,
        po.code AS poste_code,
        po.label AS poste_label,
        pr.of_operation_id::text AS of_operation_id,
        pr.calendar_id::text AS calendar_id,
        cal.code AS calendar_code,
        cal.label AS calendar_label,
        cal.timezone AS calendar_timezone,
        pr.required_machine_family_code,
        COALESCE(skills.required_skill_codes, '{}'::text[]) AS required_skill_codes,
        pr.version::int AS version,
        pr.updated_at::text AS updated_at,
        pr.archived_at::text AS archived_at,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation
      FROM public.programmations pr
      JOIN public.pieces_techniques pt ON pt.id = pr.piece_technique_id
      LEFT JOIN public.users u ON u.id = pr.programmer_user_id
      LEFT JOIN public.machines m ON m.id = pr.machine_id
      LEFT JOIN public.postes po ON po.id = pr.poste_id
      LEFT JOIN public.programmation_calendars cal ON cal.id = pr.calendar_id
      LEFT JOIN LATERAL (
        SELECT array_agg(req.skill_code ORDER BY req.skill_code) AS required_skill_codes
        FROM public.programmation_required_skills req
        WHERE req.programmation_id = pr.id
      ) skills ON TRUE
      WHERE pr.id = $1::uuid
      ${options.forUpdate ? "FOR UPDATE OF pr" : ""}
    `,
    [id]
  );
  const row = result.rows[0];
  return row ? mapSnapshot(row) : null;
}

function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function previewToken(params: {
  programmationId: string;
  expectedVersion: number;
  candidate: ProgrammationRescheduleCandidate;
  timezone: string;
  reason: string;
  source: string;
}): string {
  return hashJson({
    contract: "programmation-reschedule-preview-v1",
    programmation_id: params.programmationId,
    expected_version: params.expectedVersion,
    candidate: params.candidate,
    timezone: params.timezone,
    reason: params.reason,
    source: params.source,
  });
}

function commitFingerprint(id: string, body: CommitProgrammationRescheduleBodyDTO): string {
  return hashJson({
    contract: "programmation-reschedule-commit-v1",
    programmation_id: id,
    expected_version: body.expected_version,
    candidate: body.candidate,
    timezone: body.timezone,
    reason: body.reason,
    source: body.source,
    preview_token: body.preview_token,
  });
}

function cancelFingerprint(
  programmationId: string,
  operationId: string,
  body: CancelProgrammationRescheduleBodyDTO
): string {
  return hashJson({
    contract: "programmation-reschedule-cancel-v1",
    programmation_id: programmationId,
    operation_id: operationId,
    expected_version: body.expected_version,
    timezone: body.timezone,
    reason: body.reason,
    source: body.source,
  });
}

function candidateFromSnapshot(snapshot: ProgrammationRescheduleSnapshot): ProgrammationRescheduleCandidate {
  return {
    start_date: snapshot.start_date,
    end_date: snapshot.end_date,
    programmer_user_id: snapshot.programmer_user_id,
    machine_id: snapshot.machine_id,
    poste_id: snapshot.poste_id,
    calendar_id: snapshot.calendar_id,
  };
}

function dateAtUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addCalendarDays(value: string, days: number): string {
  const date = dateAtUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveDurationDays(candidate: ProgrammationRescheduleCandidate): number {
  return Math.round((dateAtUtc(candidate.end_date).getTime() - dateAtUtc(candidate.start_date).getTime()) / 86_400_000) + 1;
}

function violation(
  code: string,
  message: string,
  field: ProgrammationConstraintViolation["field"],
  suggestedAction: string,
  conflicts?: ProgrammationConstraintConflict[]
): ProgrammationConstraintViolation {
  return {
    code,
    message,
    field,
    blocking: true,
    suggested_action: suggestedAction,
    ...(conflicts?.length ? { conflicts } : {}),
  };
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_-]+/g, "");
}

function machineUnavailableReason(row: {
  status: string | null;
  is_available: boolean | null;
  scheduling_enabled: boolean | null;
}): string | null {
  const status = normalizeStatus(row.status);
  if (status.includes("maintenance")) return "Machine en maintenance";
  if (["panne", "offline", "blocked", "bloque", "outofservice", "indisponible"].some((token) => status.includes(token))) {
    return "Machine en panne ou indisponible";
  }
  if (row.is_available === false) return "Machine signalée indisponible";
  if (row.scheduling_enabled === false) return "Machine non planifiable";
  return null;
}

type ValidationResult = {
  violations: ProgrammationConstraintViolation[];
  warnings: Array<{ code: string; message: string }>;
};

async function validateRescheduleCandidate(params: {
  q: DbQueryer;
  current: ProgrammationRescheduleSnapshot;
  candidate: ProgrammationRescheduleCandidate;
  timezone: string;
}): Promise<ValidationResult> {
  const { q, current, candidate, timezone } = params;
  const violations: ProgrammationConstraintViolation[] = [];
  const warnings: Array<{ code: string; message: string }> = [];

  if (current.archived_at) {
    violations.push(violation(
      "PROGRAMMATION_ARCHIVED",
      "Cette tâche de programmation est archivée.",
      null,
      "Rechargez le planning et choisissez une tâche active."
    ));
    return { violations, warnings };
  }

  let effectiveMachineId = candidate.machine_id;
  let machineRow: {
    id: string;
    code: string;
    name: string;
    status: string | null;
    is_available: boolean | null;
    scheduling_enabled: boolean | null;
    machine_family_code: string | null;
  } | null = null;

  if (candidate.programmer_user_id !== null) {
    const programmer = await q.query<{ id: number; username: string; status: string | null }>(
      `SELECT id::int AS id, username, status FROM public.users WHERE id = $1::int LIMIT 1`,
      [candidate.programmer_user_id]
    );
    const row = programmer.rows[0];
    if (!row) {
      violations.push(violation(
        "PROGRAMMER_NOT_FOUND",
        "Le programmeur sélectionné n'existe plus.",
        "programmer_user_id",
        "Choisissez un compte actif puis relancez l'aperçu."
      ));
    } else if (["inactive", "blocked", "suspended", "archive", "archived"].includes(normalizeStatus(row.status))) {
      violations.push(violation(
        "PROGRAMMER_UNAVAILABLE",
        `Le compte ${row.username} n'est pas actif.`,
        "programmer_user_id",
        "Choisissez un programmeur actif."
      ));
    }
  } else {
    warnings.push({ code: "PROGRAMMER_UNASSIGNED", message: "La tâche restera non assignée à un programmeur." });
  }

  if (candidate.poste_id) {
    const poste = await q.query<{
      id: string;
      code: string;
      label: string;
      is_active: boolean;
      machine_id: string | null;
    }>(
      `SELECT id::text AS id, code, label, is_active, machine_id::text AS machine_id
       FROM public.postes WHERE id = $1::uuid LIMIT 1`,
      [candidate.poste_id]
    );
    const row = poste.rows[0];
    if (!row) {
      violations.push(violation(
        "POSTE_NOT_FOUND",
        "Le poste sélectionné n'existe plus.",
        "poste_id",
        "Choisissez un poste actif puis relancez l'aperçu."
      ));
    } else {
      if (!row.is_active) {
        violations.push(violation(
          "POSTE_UNAVAILABLE",
          `Le poste ${row.code} est inactif.`,
          "poste_id",
          "Choisissez un poste actif."
        ));
      }
      if (candidate.machine_id && row.machine_id && candidate.machine_id !== row.machine_id) {
        violations.push(violation(
          "POSTE_MACHINE_MISMATCH",
          `Le poste ${row.code} n'appartient pas à la machine sélectionnée.`,
          "poste_id",
          "Sélectionnez la machine rattachée à ce poste ou retirez la machine explicite."
        ));
      }
      if (!effectiveMachineId) effectiveMachineId = row.machine_id;
    }
  }

  if (effectiveMachineId) {
    const machine = await q.query<{
      id: string;
      code: string;
      name: string;
      status: string | null;
      is_available: boolean | null;
      scheduling_enabled: boolean | null;
      machine_family_code: string | null;
    }>(
      `SELECT m.id::text AS id, m.code, m.name, m.status::text AS status, m.is_available,
              COALESCE((to_jsonb(m)->>'scheduling_enabled')::boolean, TRUE) AS scheduling_enabled,
              NULLIF(to_jsonb(m)->>'machine_family_code', '') AS machine_family_code
       FROM public.machines m WHERE m.id = $1::uuid LIMIT 1`,
      [effectiveMachineId]
    );
    machineRow = machine.rows[0] ?? null;
    if (!machineRow) {
      violations.push(violation(
        "MACHINE_NOT_FOUND",
        "La machine sélectionnée n'existe plus.",
        "machine_id",
        "Choisissez une machine existante puis relancez l'aperçu."
      ));
    } else {
      const reason = machineUnavailableReason(machineRow);
      if (reason) {
        violations.push(violation(
          "MACHINE_UNAVAILABLE",
          `${machineRow.code} · ${reason}.`,
          "machine_id",
          "Choisissez une machine disponible ou corrigez son état de parc."
        ));
      }
      if (
        current.required_machine_family_code
        && machineRow.machine_family_code !== current.required_machine_family_code
      ) {
        violations.push(violation(
          "MACHINE_QUALIFICATION_MISMATCH",
          `La machine ${machineRow.code} n'est pas qualifiée pour la famille ${current.required_machine_family_code}.`,
          "machine_id",
          "Choisissez une machine qualifiée ou faites tracer sa qualification dans Méthodes."
        ));
      }
    }
  } else if (current.required_machine_family_code) {
    violations.push(violation(
      "QUALIFIED_MACHINE_REQUIRED",
      `Cette tâche exige une machine de famille ${current.required_machine_family_code}.`,
      "machine_id",
      "Sélectionnez une machine qualifiée."
    ));
  } else {
    warnings.push({ code: "MACHINE_UNASSIGNED", message: "Aucune machine ou machine de poste ne contraint cette tâche." });
  }

  if (current.required_skill_codes.length > 0) {
    if (candidate.programmer_user_id === null) {
      violations.push(violation(
        "PROGRAMMER_SKILL_REQUIRED",
        `Compétence(s) requise(s) : ${current.required_skill_codes.join(", ")}.`,
        "programmer_user_id",
        "Assignez un programmeur possédant toutes les compétences requises."
      ));
    } else {
      const skills = await q.query<{ skill_code: string }>(
        `SELECT req.skill_code
         FROM public.programmation_required_skills req
         WHERE req.programmation_id = $1::uuid
           AND NOT EXISTS (
             SELECT 1 FROM public.programmation_user_skills us
             WHERE us.user_id = $2::int
               AND us.skill_code = req.skill_code
               AND us.active
               AND us.valid_from <= $3::date
               AND (us.valid_to IS NULL OR us.valid_to >= $4::date)
           )
         ORDER BY req.skill_code`,
        [current.id, candidate.programmer_user_id, candidate.start_date, candidate.end_date]
      );
      if (skills.rows.length) {
        const missing = skills.rows.map((row) => row.skill_code);
        violations.push(violation(
          "PROGRAMMER_SKILL_MISSING",
          `Compétence(s) manquante(s) ou expirée(s) : ${missing.join(", ")}.`,
          "programmer_user_id",
          "Choisissez un programmeur qualifié sur toute la période."
        ));
      }
    }
  }

  if (candidate.calendar_id) {
    const calendar = await q.query<{
      id: string;
      code: string;
      label: string;
      timezone: string;
      working_days: number[];
      active: boolean;
    }>(
      `SELECT id::text AS id, code, label, timezone, working_days::int[] AS working_days, active
       FROM public.programmation_calendars WHERE id = $1::uuid LIMIT 1`,
      [candidate.calendar_id]
    );
    const row = calendar.rows[0];
    if (!row) {
      violations.push(violation(
        "CALENDAR_NOT_FOUND",
        "Le calendrier sélectionné n'existe plus.",
        "calendar_id",
        "Choisissez un calendrier actif."
      ));
    } else if (!row.active) {
      violations.push(violation(
        "CALENDAR_INACTIVE",
        `Le calendrier ${row.code} est inactif.`,
        "calendar_id",
        "Choisissez un calendrier actif."
      ));
    } else {
      if (row.timezone !== timezone) {
        violations.push(violation(
          "CALENDAR_TIMEZONE_MISMATCH",
          `Le calendrier ${row.code} utilise ${row.timezone}, pas ${timezone}.`,
          "calendar_id",
          `Relancez l'aperçu avec le fuseau ${row.timezone}.`
        ));
      }
      const nonWorking: string[] = [];
      const duration = inclusiveDurationDays(candidate);
      for (let offset = 0; offset < duration; offset += 1) {
        const day = addCalendarDays(candidate.start_date, offset);
        const jsDay = dateAtUtc(day).getUTCDay();
        const isoDay = jsDay === 0 ? 7 : jsDay;
        if (!row.working_days.includes(isoDay)) nonWorking.push(day);
      }
      if (nonWorking.length) {
        violations.push(violation(
          "CALENDAR_NON_WORKING_DAY",
          `La période inclut ${nonWorking.length} jour(s) non ouvré(s), dont ${nonWorking.slice(0, 3).join(", ")}.`,
          "start_date",
          "Déplacez ou réduisez la tâche pour rester sur les jours ouvrés du calendrier."
        ));
      }
      const closures = await q.query<{ id: string; reason: string; start_date: string; end_date: string }>(
        `SELECT id::text AS id, reason, start_date::text AS start_date, end_date::text AS end_date
         FROM public.programmation_calendar_closures
         WHERE calendar_id = $1::uuid
           AND daterange(start_date, end_date + 1, '[)') && daterange($2::date, $3::date + 1, '[)')
         ORDER BY start_date, id`,
        [candidate.calendar_id, candidate.start_date, candidate.end_date]
      );
      if (closures.rows.length) {
        violations.push(violation(
          "CALENDAR_CLOSED",
          `Le calendrier est fermé sur la période (${closures.rows[0]?.reason ?? "fermeture"}).`,
          "start_date",
          "Choisissez une période hors fermeture.",
          closures.rows.map((closure) => ({
            id: closure.id,
            label: closure.reason,
            start_date: closure.start_date,
            end_date: closure.end_date,
            resource_type: "CALENDAR",
            resource_id: candidate.calendar_id as string,
          }))
        ));
      }
    }
  } else {
    warnings.push({
      code: "CALENDAR_NOT_CONFIGURED",
      message: "Aucun calendrier canonique n'est configuré : aucune capacité horaire n'est inventée.",
    });
  }

  const overlapRows = await q.query<{
    id: string;
    label: string;
    start_date: string;
    end_date: string;
    programmer_overlap: boolean;
    machine_overlap: boolean;
    poste_overlap: boolean;
  }>(
    `SELECT
       other.id::text AS id,
       pt.code_piece AS label,
       other.date_commencement::text AS start_date,
       other.date_fin::text AS end_date,
       ($4::int IS NOT NULL AND other.programmer_user_id = $4::int) AS programmer_overlap,
       ($5::uuid IS NOT NULL AND COALESCE(other.machine_id, other_poste.machine_id) = $5::uuid) AS machine_overlap,
       ($6::uuid IS NOT NULL AND other.poste_id = $6::uuid) AS poste_overlap
     FROM public.programmations other
     JOIN public.pieces_techniques pt ON pt.id = other.piece_technique_id
     LEFT JOIN public.postes other_poste ON other_poste.id = other.poste_id
     WHERE other.id <> $1::uuid
       AND other.archived_at IS NULL
       AND daterange(other.date_commencement, other.date_fin + 1, '[)')
           && daterange($2::date, $3::date + 1, '[)')
       AND (
         ($4::int IS NOT NULL AND other.programmer_user_id = $4::int)
         OR ($5::uuid IS NOT NULL AND COALESCE(other.machine_id, other_poste.machine_id) = $5::uuid)
         OR ($6::uuid IS NOT NULL AND other.poste_id = $6::uuid)
       )
     ORDER BY other.date_commencement, other.id
     LIMIT 50`,
    [current.id, candidate.start_date, candidate.end_date, candidate.programmer_user_id, effectiveMachineId, candidate.poste_id]
  );
  const conflictsFor = (
    predicate: (row: typeof overlapRows.rows[number]) => boolean,
    resourceType: ProgrammationConstraintConflict["resource_type"],
    resourceId: string | number | null
  ) => overlapRows.rows.filter(predicate).map((row) => ({
    id: row.id,
    label: row.label,
    start_date: row.start_date,
    end_date: row.end_date,
    resource_type: resourceType,
    resource_id: resourceId === null ? undefined : String(resourceId),
  }));

  const programmerConflicts = conflictsFor((row) => row.programmer_overlap, "PROGRAMMER", candidate.programmer_user_id);
  if (programmerConflicts.length) {
    violations.push(violation(
      "PROGRAMMER_OVERLAP",
      "Le programmeur a déjà une tâche sur cette période.",
      "programmer_user_id",
      "Choisissez un autre programmeur ou une période après la fin du conflit.",
      programmerConflicts
    ));
  }
  const machineConflicts = conflictsFor((row) => row.machine_overlap, "MACHINE", effectiveMachineId);
  if (machineConflicts.length) {
    violations.push(violation(
      "MACHINE_OVERLAP",
      "La machine a déjà une tâche de programmation sur cette période.",
      "machine_id",
      "Choisissez une autre machine ou une période après la fin du conflit.",
      machineConflicts
    ));
  }
  const posteConflicts = conflictsFor((row) => row.poste_overlap, "POSTE", candidate.poste_id);
  if (posteConflicts.length) {
    violations.push(violation(
      "POSTE_OVERLAP",
      "Le poste a déjà une tâche de programmation sur cette période.",
      "poste_id",
      "Choisissez un autre poste ou une période après la fin du conflit.",
      posteConflicts
    ));
  }

  if (effectiveMachineId) {
    const productionConflicts = await q.query<{
      id: string;
      title: string;
      start_date: string;
      end_date: string;
    }>(
      `SELECT e.id::text AS id, e.title,
              (e.start_ts AT TIME ZONE $4)::date::text AS start_date,
              ((e.end_ts - interval '1 microsecond') AT TIME ZONE $4)::date::text AS end_date
       FROM public.planning_events e
       LEFT JOIN public.postes event_poste ON event_poste.id = e.poste_id
       WHERE e.archived_at IS NULL
         AND e.status <> 'CANCELLED'::planning_event_status
         AND COALESCE(e.machine_id, event_poste.machine_id) = $1::uuid
         AND tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange(
           $2::date::timestamp AT TIME ZONE $4,
           ($3::date + 1)::timestamp AT TIME ZONE $4,
           '[)'
         )
       ORDER BY e.start_ts, e.id
       LIMIT 25`,
      [effectiveMachineId, candidate.start_date, candidate.end_date, timezone]
    );
    if (productionConflicts.rows.length) {
      violations.push(violation(
        "MACHINE_PRODUCTION_CALENDAR_CONFLICT",
        "La machine est occupée ou indisponible dans le planning de production.",
        "machine_id",
        "Choisissez une période libre dans le planning de production ou une autre machine.",
        productionConflicts.rows.map((row) => ({
          id: row.id,
          label: row.title,
          start_date: row.start_date,
          end_date: row.end_date,
          resource_type: "MACHINE",
          resource_id: effectiveMachineId as string,
        }))
      ));
    }
  }

  const dependencies = await q.query<{
    relation: "PREDECESSOR" | "SUCCESSOR";
    id: string;
    label: string;
    start_date: string;
    end_date: string;
    lag_days: number;
    violates: boolean;
  }>(
    `SELECT 'PREDECESSOR'::text AS relation, predecessor.id::text AS id,
            predecessor_piece.code_piece AS label,
            predecessor.date_commencement::text AS start_date,
            predecessor.date_fin::text AS end_date,
            dep.lag_days::int AS lag_days,
            ($2::date < predecessor.date_fin + 1 + dep.lag_days) AS violates
     FROM public.programmation_dependencies dep
     JOIN public.programmations predecessor ON predecessor.id = dep.predecessor_id AND predecessor.archived_at IS NULL
     JOIN public.pieces_techniques predecessor_piece ON predecessor_piece.id = predecessor.piece_technique_id
     WHERE dep.successor_id = $1::uuid
     UNION ALL
     SELECT 'SUCCESSOR'::text AS relation, successor.id::text AS id,
            successor_piece.code_piece AS label,
            successor.date_commencement::text AS start_date,
            successor.date_fin::text AS end_date,
            dep.lag_days::int AS lag_days,
            (successor.date_commencement < $3::date + 1 + dep.lag_days) AS violates
     FROM public.programmation_dependencies dep
     JOIN public.programmations successor ON successor.id = dep.successor_id AND successor.archived_at IS NULL
     JOIN public.pieces_techniques successor_piece ON successor_piece.id = successor.piece_technique_id
     WHERE dep.predecessor_id = $1::uuid
     ORDER BY relation, start_date, id`,
    [current.id, candidate.start_date, candidate.end_date]
  );
  const blockingDependencies = dependencies.rows.filter((row) => row.violates);
  if (blockingDependencies.length) {
    violations.push(violation(
      "DEPENDENCY_ORDER_VIOLATION",
      "La période ne respecte pas l'ordre ou le délai d'une dépendance.",
      "start_date",
      "Placez la tâche après ses prédécesseurs et avant ses successeurs.",
      blockingDependencies.map((row) => ({
        id: row.id,
        label: `${row.relation === "PREDECESSOR" ? "Prédécesseur" : "Successeur"} ${row.label} · délai ${row.lag_days} j`,
        start_date: row.start_date,
        end_date: row.end_date,
        resource_type: "DEPENDENCY",
        resource_id: row.id,
      }))
    ));
  }

  if (current.of_operation_id) {
    const running = await q.query<{ id: string; started_at: string; user_id: number }>(
      `SELECT id::text AS id, started_at::text AS started_at, user_id::int AS user_id
       FROM public.of_time_logs
       WHERE of_operation_id = $1::uuid AND ended_at IS NULL
       ORDER BY started_at, id`,
      [current.of_operation_id]
    );
    if (running.rows.length) {
      violations.push(violation(
        "PROGRAMMATION_TIME_LOG_OPEN",
        "Un pointage est ouvert sur l'opération liée.",
        "of_operation_id",
        "Arrêtez le pointage avant de replanifier cette tâche."
      ));
    }
  }

  return { violations, warnings };
}

function suggestedSlots(
  candidate: ProgrammationRescheduleCandidate,
  violations: ProgrammationConstraintViolation[]
): ProgrammationReschedulePreview["suggested_slots"] {
  const ends = violations.flatMap((item) => item.conflicts ?? [])
    .map((conflict) => conflict.end_date)
    .filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)));
  if (!ends.length) return [];
  const latestEnd = ends.sort().at(-1) as string;
  const durationDays = inclusiveDurationDays(candidate);
  const starts = [addCalendarDays(latestEnd, 1), addCalendarDays(latestEnd, 7)];
  return [...new Set(starts)].map((start) => ({
    candidate: {
      ...candidate,
      start_date: start,
      end_date: addCalendarDays(start, durationDays - 1),
    },
    reason: "Après la fin des conflits connus ; une nouvelle prévalidation reste obligatoire.",
    requires_preview: true as const,
  }));
}

async function advisoryLock(q: DbQueryer, key: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

async function lockCandidateResources(q: DbQueryer, candidate: ProgrammationRescheduleCandidate): Promise<void> {
  let effectiveMachineId = candidate.machine_id;
  if (!effectiveMachineId && candidate.poste_id) {
    const poste = await q.query<{ machine_id: string | null }>(
      `SELECT machine_id::text AS machine_id FROM public.postes WHERE id = $1::uuid LIMIT 1`,
      [candidate.poste_id]
    );
    effectiveMachineId = poste.rows[0]?.machine_id ?? null;
  }
  const keys = [
    candidate.programmer_user_id ? `programmation:programmer:${candidate.programmer_user_id}` : null,
    effectiveMachineId ? `programmation:machine:${effectiveMachineId}` : null,
    candidate.poste_id ? `programmation:poste:${candidate.poste_id}` : null,
    candidate.calendar_id ? `programmation:calendar:${candidate.calendar_id}` : null,
  ].filter((key): key is string => Boolean(key)).sort();
  for (const key of keys) await advisoryLock(q, key);
}

async function insertAudit(
  tx: DbQueryer,
  audit: AuditContext,
  input: { action: string; programmationId: string; details: Record<string, unknown> }
): Promise<string> {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: input.action,
    page_key: audit.page_key,
    entity_type: "programmations",
    entity_id: input.programmationId,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: input.details,
  };
  const inserted = await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
  if (!inserted?.id) throw new Error("PROGRAMMATION_RESCHEDULE_AUDIT_INSERT_FAILED");
  return inserted.id;
}

type NotificationPayload = {
  id: string;
  user_id: number;
  kind: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  action_url: string | null;
  action_label: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
};

async function insertRescheduleNotifications(params: {
  tx: DbQueryer;
  userIds: Array<number | null>;
  kind: "programmation.rescheduled" | "programmation.reschedule_cancelled";
  operationId: string;
  snapshot: ProgrammationRescheduleSnapshot;
  message: string;
}): Promise<NotificationPayload[]> {
  const userIds = [...new Set(params.userIds.filter((id): id is number => Number.isInteger(id) && Number(id) > 0))];
  const created: NotificationPayload[] = [];
  for (const userId of userIds) {
    const result = await params.tx.query<NotificationPayload>(
      `INSERT INTO public.app_notifications (
         user_id, kind, title, message, severity, action_url, action_label, payload, dedupe_key
       ) VALUES ($1::int, $2, $3, $4, 'info', '/production/planning?view=programmation', 'Ouvrir le planning', $5::jsonb, $6)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id::text AS id, user_id::int AS user_id, kind, title, message,
                 severity::text AS severity, action_url, action_label, payload,
                 created_at::text AS created_at, read_at::text AS read_at`,
      [
        userId,
        params.kind,
        `Programmation ${params.snapshot.piece_code} replanifiée`,
        params.message,
        JSON.stringify({ programmation_id: params.snapshot.id, operation_id: params.operationId, version: params.snapshot.version }),
        `${params.kind}:${params.operationId}`,
      ]
    );
    const notification = result.rows[0];
    if (!notification) continue;
    created.push(notification);
    await enqueueAppNotificationCreated(params.tx, notification.user_id, notification, {
      deduplicationKey: `notification:${notification.id}`,
    });
  }
  return created;
}

function jsonObject<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

export async function repoPreviewProgrammationReschedule(params: {
  id: string;
  body: PreviewProgrammationRescheduleBodyDTO;
}): Promise<ProgrammationReschedulePreview> {
  const current = await selectProgrammationSnapshot(pool, params.id);
  if (!current) throw new HttpError(404, "PROGRAMMATION_NOT_FOUND", "Tâche de programmation introuvable.");

  const validation = await validateRescheduleCandidate({
    q: pool,
    current,
    candidate: params.body.candidate,
    timezone: params.body.timezone,
  });
  if (current.version !== params.body.expected_version) {
    validation.violations.unshift(violation(
      "PROGRAMMATION_STALE",
      `La version attendue ${params.body.expected_version} n'est plus courante (version ${current.version}).`,
      "version",
      "Rechargez la tâche puis recommencez le déplacement."
    ));
  }

  return {
    valid: validation.violations.length === 0,
    preview_token: previewToken({
      programmationId: params.id,
      expectedVersion: params.body.expected_version,
      candidate: params.body.candidate,
      timezone: params.body.timezone,
      reason: params.body.reason,
      source: params.body.source,
    }),
    current,
    candidate: params.body.candidate,
    violations: validation.violations,
    warnings: validation.warnings,
    suggested_slots: suggestedSlots(params.body.candidate, validation.violations),
    expires_when_version_changes: true,
  };
}

export async function repoCommitProgrammationReschedule(params: {
  id: string;
  body: CommitProgrammationRescheduleBodyDTO;
  audit: AuditContext;
}): Promise<ProgrammationRescheduleCommitResult> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const fingerprint = commitFingerprint(params.id, params.body);
    await advisoryLock(tx, `programmation:commit:${params.id}:${params.body.idempotency_key}`);

    const replay = await tx.query<{
      request_fingerprint: string;
      commit_response: ProgrammationRescheduleCommitResult | string;
    }>(
      `SELECT request_fingerprint, commit_response
       FROM public.programmation_reschedule_operations
       WHERE programmation_id = $1::uuid AND request_idempotency_key = $2
       LIMIT 1`,
      [params.id, params.body.idempotency_key]
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_fingerprint !== fingerprint) {
        throw new HttpError(409, "PROGRAMMATION_IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence correspond à une autre demande.", {
          programmation_id: params.id,
          idempotency_key: params.body.idempotency_key,
          suggested_action: "Générez une nouvelle clé pour une intention différente.",
        });
      }
      return { ...jsonObject(replay.rows[0].commit_response), idempotent_replay: true };
    }

    const current = await selectProgrammationSnapshot(tx, params.id, { forUpdate: true });
    if (!current) throw new HttpError(404, "PROGRAMMATION_NOT_FOUND", "Tâche de programmation introuvable.");
    if (current.version !== params.body.expected_version) {
      throw new HttpError(409, "PROGRAMMATION_STALE", "La tâche a été modifiée par un autre utilisateur.", {
        expected_version: params.body.expected_version,
        current_version: current.version,
        current,
        suggested_action: "Rechargez la tâche puis relancez l'aperçu.",
      });
    }

    const expectedToken = previewToken({
      programmationId: params.id,
      expectedVersion: params.body.expected_version,
      candidate: params.body.candidate,
      timezone: params.body.timezone,
      reason: params.body.reason,
      source: params.body.source,
    });
    if (params.body.preview_token !== expectedToken) {
      throw new HttpError(409, "PROGRAMMATION_PREVIEW_EXPIRED", "L'aperçu ne correspond pas à cette demande.", {
        expected_version: current.version,
        suggested_action: "Relancez la prévalidation sans modifier le motif, le fuseau ou les dates.",
      });
    }

    await lockCandidateResources(tx, params.body.candidate);
    const validation = await validateRescheduleCandidate({
      q: tx,
      current,
      candidate: params.body.candidate,
      timezone: params.body.timezone,
    });
    if (validation.violations.length) {
      throw new HttpError(409, "PROGRAMMATION_CONSTRAINT_VIOLATION", "La replanification n'est plus applicable.", {
        current,
        candidate: params.body.candidate,
        violations: validation.violations,
        warnings: validation.warnings,
        suggested_slots: suggestedSlots(params.body.candidate, validation.violations),
        suggested_action: "Corrigez les contraintes puis relancez l'aperçu.",
      });
    }

    const updated = await tx.query<{ version: number; updated_at: string }>(
      `UPDATE public.programmations
       SET date_commencement = $2::date,
           date_fin = $3::date,
           programmer_user_id = $4::int,
           machine_id = $5::uuid,
           poste_id = $6::uuid,
           calendar_id = $7::uuid,
           version = version + 1,
           updated_by = $8::int,
           updated_at = now()
       WHERE id = $1::uuid AND version = $9::int AND archived_at IS NULL
       RETURNING version::int AS version, updated_at::text AS updated_at`,
      [
        params.id,
        params.body.candidate.start_date,
        params.body.candidate.end_date,
        params.body.candidate.programmer_user_id,
        params.body.candidate.machine_id,
        params.body.candidate.poste_id,
        params.body.candidate.calendar_id,
        params.audit.user_id,
        params.body.expected_version,
      ]
    );
    if (!updated.rows[0]) {
      throw new HttpError(409, "PROGRAMMATION_STALE", "La tâche a changé pendant la replanification.", {
        expected_version: params.body.expected_version,
        suggested_action: "Rechargez la tâche puis relancez l'aperçu.",
      });
    }

    const next = await selectProgrammationSnapshot(tx, params.id);
    if (!next) throw new Error("PROGRAMMATION_RESCHEDULE_RELOAD_FAILED");
    const operationId = crypto.randomUUID();
    const auditId = await insertAudit(tx, params.audit, {
      action: "programmations.reschedule.commit",
      programmationId: params.id,
      details: {
        operation_id: operationId,
        idempotency_key: params.body.idempotency_key,
        reason: params.body.reason,
        source: params.body.source,
        timezone: params.body.timezone,
        before: current,
        after: next,
        constraints_checked: [
          "optimistic_version", "machine", "poste", "qualification", "skills",
          "calendar", "dependencies", "overlap", "production_calendar", "open_time_logs",
        ],
      },
    });
    const notifications = await insertRescheduleNotifications({
      tx,
      userIds: [params.audit.user_id, current.programmer_user_id, next.programmer_user_id],
      kind: "programmation.rescheduled",
      operationId,
      snapshot: next,
      message: `${next.piece_code} est planifiée du ${next.start_date} au ${next.end_date}. Motif : ${params.body.reason}`,
    });
    const response: ProgrammationRescheduleCommitResult = {
      operation_id: operationId,
      idempotent_replay: false,
      status: "APPLIED",
      task: next,
      previous: current,
      audit_id: auditId,
      notification_ids: notifications.map((notification) => notification.id),
    };

    await tx.query(
      `INSERT INTO public.programmation_reschedule_operations (
         id, programmation_id, request_idempotency_key, request_fingerprint,
         preview_token, source, timezone, reason, previous_state, next_state,
         applied_version, commit_response, applied_by
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::int, $12::jsonb, $13::int)`,
      [
        operationId, params.id, params.body.idempotency_key, fingerprint,
        params.body.preview_token, params.body.source, params.body.timezone, params.body.reason,
        JSON.stringify(current), JSON.stringify(next), next.version, JSON.stringify(response), params.audit.user_id,
      ]
    );
    await tx.query(
      `INSERT INTO public.programmation_reschedule_events (operation_id, event_type, reason, snapshot, actor_id)
       VALUES ($1::uuid, 'COMMITTED', $2, $3::jsonb, $4::int)`,
      [operationId, params.body.reason, JSON.stringify({ before: current, after: next, audit_id: auditId }), params.audit.user_id]
    );
    await enqueueEntityChanged(tx, {
      entityType: "PROGRAMMATION",
      entityId: params.id,
      action: "updated",
      module: "production",
      at: new Date().toISOString(),
      invalidateKeys: ["programmations", `programmation:${params.id}`],
    }, { deduplicationKey: `programmation:reschedule:${operationId}` });

    return response;
  });
}

export async function repoCancelProgrammationReschedule(params: {
  id: string;
  operationId: string;
  body: CancelProgrammationRescheduleBodyDTO;
  audit: AuditContext;
}): Promise<ProgrammationRescheduleCancelResult> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const fingerprint = cancelFingerprint(params.id, params.operationId, params.body);
    await advisoryLock(tx, `programmation:cancel:${params.id}:${params.body.idempotency_key}`);

    const operationResult = await tx.query<{
      id: string;
      status: "APPLIED" | "CANCELLED";
      applied_version: number;
      previous_state: ProgrammationRescheduleSnapshot | string;
      next_state: ProgrammationRescheduleSnapshot | string;
      cancel_idempotency_key: string | null;
      cancel_fingerprint: string | null;
      cancel_response: ProgrammationRescheduleCancelResult | string | null;
    }>(
      `SELECT id::text AS id, status, applied_version::int AS applied_version,
              previous_state, next_state, cancel_idempotency_key, cancel_fingerprint, cancel_response
       FROM public.programmation_reschedule_operations
       WHERE id = $1::uuid AND programmation_id = $2::uuid
       FOR UPDATE`,
      [params.operationId, params.id]
    );
    const operation = operationResult.rows[0];
    if (!operation) throw new HttpError(404, "PROGRAMMATION_RESCHEDULE_NOT_FOUND", "Replanification introuvable.");
    if (operation.status === "CANCELLED") {
      if (
        operation.cancel_idempotency_key === params.body.idempotency_key
        && operation.cancel_fingerprint === fingerprint
        && operation.cancel_response
      ) {
        return { ...jsonObject(operation.cancel_response), idempotent_replay: true };
      }
      throw new HttpError(409, "PROGRAMMATION_RESCHEDULE_ALREADY_CANCELLED", "Cette replanification a déjà été compensée.", {
        operation_id: params.operationId,
        suggested_action: "Rechargez le planning ; aucune nouvelle annulation n'est nécessaire.",
      });
    }

    const current = await selectProgrammationSnapshot(tx, params.id, { forUpdate: true });
    if (!current) throw new HttpError(404, "PROGRAMMATION_NOT_FOUND", "Tâche de programmation introuvable.");
    if (current.version !== params.body.expected_version || current.version !== operation.applied_version) {
      throw new HttpError(409, "PROGRAMMATION_CANCEL_STALE", "La tâche a changé depuis cette replanification ; la compensation automatique est refusée.", {
        expected_version: params.body.expected_version,
        applied_version: operation.applied_version,
        current_version: current.version,
        current,
        suggested_action: "Prévisualisez une nouvelle replanification vers les dates précédentes ; les changements intermédiaires ne seront pas écrasés.",
      });
    }

    const previous = jsonObject<ProgrammationRescheduleSnapshot>(operation.previous_state);
    const previousCandidate = candidateFromSnapshot(previous);
    await lockCandidateResources(tx, previousCandidate);
    const validation = await validateRescheduleCandidate({
      q: tx,
      current,
      candidate: previousCandidate,
      timezone: params.body.timezone,
    });
    if (validation.violations.length) {
      throw new HttpError(409, "PROGRAMMATION_COMPENSATION_CONFLICT", "L'état précédent n'est plus applicable sans risque.", {
        operation_id: params.operationId,
        current,
        compensated_candidate: previousCandidate,
        violations: validation.violations,
        suggested_slots: suggestedSlots(previousCandidate, validation.violations),
        suggested_action: "Résolvez les conflits ou effectuez une nouvelle replanification contrôlée.",
      });
    }

    const update = await tx.query<{ version: number }>(
      `UPDATE public.programmations
       SET date_commencement = $2::date,
           date_fin = $3::date,
           programmer_user_id = $4::int,
           machine_id = $5::uuid,
           poste_id = $6::uuid,
           calendar_id = $7::uuid,
           version = version + 1,
           updated_by = $8::int,
           updated_at = now()
       WHERE id = $1::uuid AND version = $9::int AND archived_at IS NULL
       RETURNING version::int AS version`,
      [
        params.id, previous.start_date, previous.end_date, previous.programmer_user_id,
        previous.machine_id, previous.poste_id, previous.calendar_id,
        params.audit.user_id, params.body.expected_version,
      ]
    );
    if (!update.rows[0]) {
      throw new HttpError(409, "PROGRAMMATION_CANCEL_STALE", "La tâche a changé pendant la compensation.", {
        suggested_action: "Rechargez le planning avant toute nouvelle action.",
      });
    }
    const compensated = await selectProgrammationSnapshot(tx, params.id);
    if (!compensated) throw new Error("PROGRAMMATION_COMPENSATION_RELOAD_FAILED");

    const auditId = await insertAudit(tx, params.audit, {
      action: "programmations.reschedule.cancel",
      programmationId: params.id,
      details: {
        operation_id: params.operationId,
        idempotency_key: params.body.idempotency_key,
        reason: params.body.reason,
        source: params.body.source,
        timezone: params.body.timezone,
        before_compensation: current,
        compensated_to: compensated,
      },
    });
    const notifications = await insertRescheduleNotifications({
      tx,
      userIds: [params.audit.user_id, current.programmer_user_id, compensated.programmer_user_id],
      kind: "programmation.reschedule_cancelled",
      operationId: params.operationId,
      snapshot: compensated,
      message: `${compensated.piece_code} revient du ${compensated.start_date} au ${compensated.end_date}. Motif : ${params.body.reason}`,
    });
    const response: ProgrammationRescheduleCancelResult = {
      operation_id: params.operationId,
      idempotent_replay: false,
      status: "CANCELLED",
      task: compensated,
      compensated,
      audit_id: auditId,
      notification_ids: notifications.map((notification) => notification.id),
    };

    const updateOperation = await tx.query<{ id: string }>(
      `UPDATE public.programmation_reschedule_operations
       SET status = 'CANCELLED', cancel_idempotency_key = $3, cancel_fingerprint = $4,
           cancel_reason = $5, cancel_response = $6::jsonb, cancelled_at = now(), cancelled_by = $7::int
       WHERE id = $1::uuid AND programmation_id = $2::uuid AND status = 'APPLIED'
       RETURNING id::text AS id`,
      [params.operationId, params.id, params.body.idempotency_key, fingerprint, params.body.reason, JSON.stringify(response), params.audit.user_id]
    );
    if (!updateOperation.rows[0]) throw new Error("PROGRAMMATION_COMPENSATION_OPERATION_UPDATE_FAILED");
    await tx.query(
      `INSERT INTO public.programmation_reschedule_events (operation_id, event_type, reason, snapshot, actor_id)
       VALUES ($1::uuid, 'CANCELLED', $2, $3::jsonb, $4::int)`,
      [params.operationId, params.body.reason, JSON.stringify({ before: current, after: compensated, audit_id: auditId }), params.audit.user_id]
    );
    await enqueueEntityChanged(tx, {
      entityType: "PROGRAMMATION",
      entityId: params.id,
      action: "updated",
      module: "production",
      at: new Date().toISOString(),
      invalidateKeys: ["programmations", `programmation:${params.id}`],
    }, { deduplicationKey: `programmation:reschedule-cancel:${params.operationId}` });

    return response;
  });
}
