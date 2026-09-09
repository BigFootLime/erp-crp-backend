import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { StationContext } from "../../production/middlewares/station-authorization.middleware";
import { svcDossier } from "../../production/services/station.service";
import {
  getOperationReadiness,
  usesOperationReadiness,
} from "../../production/repository/operation-readiness.repository";
import { svcGetExecution as getControl } from "../../qualite/services/quality-360.service";
import {
  applicableProgram,
  operationContext,
  dossierDocuments,
  programConfirmation,
  toolingForOf,
  qualityIdsForOf,
  materialForOf,
  firstArticleState,
  requiredToolsForOf,
} from "../repository/terminal-dossier.repository";
import {
  audit,
  type Terminal,
  type Db,
} from "../repository/terminal-auth.repository";
import { requireAlternativeReason } from "../domain/terminal-policy";

export async function operatorDossier(
  terminal: Terminal,
  station: StationContext,
  ofId: number,
  operationId: string,
) {
  const context = await operationContext(terminal, ofId, operationId);
  const [
    base,
    documents,
    program,
    tooling,
    controlIds,
    readiness,
    executions,
    operations,
  ] = await Promise.all([
    svcDossier({ station, ofId, operationId }),
    dossierDocuments(context),
    programConfirmation(terminal, context),
    toolingForOf(context),
    qualityIdsForOf(ofId),
    usesOperationReadiness(pool, ofId).then((enabled) =>
      enabled ? getOperationReadiness(ofId) : null,
    ),
    pool.query(
      `SELECT p.id::text,p.operation_id::text,p.machine_id::text,p.operator_user_id,p.activity_code,p.time_type::text,p.status::text,p.start_ts::text,
      COALESCE(a.counts_operator_time,true) AS counts_operator_time,COALESCE(a.counts_machine_time,true) AS counts_machine_time,
      (p.status='DONE' AND (SELECT e.event_type FROM public.production_pointage_events e WHERE e.pointage_id=p.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1)='PAUSE'
        AND NOT EXISTS(SELECT 1 FROM public.production_pointages next WHERE next.previous_segment_id=p.id)) AS resumable,
      p.end_ts::text,COALESCE(p.duration_minutes,extract(epoch FROM(now()-p.start_ts))/60)::float8 AS elapsed_minutes
      FROM public.production_pointages p LEFT JOIN public.production_activity_categories a ON a.code=p.activity_code WHERE p.of_id=$1 AND p.machine_id=$2 AND p.status<>'CANCELLED' ORDER BY p.start_ts DESC LIMIT 100`,
      [ofId, terminal.machine_id],
    ),
    pool.query(
      `SELECT id::text,phase,designation,status::text,machine_id::text,notes,temps_total_planned::float8,temps_total_real::float8
      FROM public.of_operations WHERE of_id=$1 AND (revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=revision_id AND r.statut='ACTIVE')) ORDER BY phase,id`,
      [ofId],
    ),
  ]);
  const controls = (await Promise.all(controlIds.map(getControl))).filter(
    (c) => c !== null,
  );
  const [material, firstArticle, requiredTools] = await Promise.all([
    materialForOf(context),
    firstArticleState(context),
    requiredToolsForOf(context),
  ]);
  const timeTotals = (
    await pool.query(
      `SELECT
    COALESCE(sum(CASE WHEN p.status='RUNNING' THEN extract(epoch FROM(now()-p.start_ts))/60 ELSE COALESCE(p.duration_minutes,0) END) FILTER(WHERE COALESCE(a.counts_machine_time,true)),0)::float8 AS machine_minutes,
    COALESCE(sum(CASE WHEN p.status='RUNNING' THEN extract(epoch FROM(now()-p.start_ts))/60 ELSE COALESCE(p.duration_minutes,0) END) FILTER(WHERE COALESCE(a.counts_operator_time,true) AND p.operator_user_id=$3),0)::float8 AS personal_minutes,
    count(*) FILTER(WHERE p.status='RUNNING' AND COALESCE(a.counts_machine_time,true))::int AS machine_running,
    count(*) FILTER(WHERE p.status='RUNNING' AND COALESCE(a.counts_operator_time,true) AND p.operator_user_id=$3)::int AS personal_running
    FROM public.production_pointages p LEFT JOIN public.production_activity_categories a ON a.code=p.activity_code
    WHERE p.of_id=$1 AND p.machine_id=$2 AND p.status IN('RUNNING','DONE')`,
      [ofId, terminal.machine_id, station.user.id],
    )
  ).rows[0];
  const coworkers = (
    await pool.query(
      `SELECT u.id,COALESCE(NULLIF(concat_ws(' ',u.name,u.surname),''),u.username) AS label
    FROM public.cerp_terminal_pins p JOIN public.users u ON u.id=p.user_id WHERE p.site_code=$1 AND p.revoked_at IS NULL
    AND u.status='Active' AND u.id<>$2 ORDER BY label`,
      [terminal.site_code, station.user.id],
    )
  ).rows;
  const measurementHistory = (
    await pool.query(
      `SELECT r.id,r.quality_control_id,r.point_id,r.revision,r.old_values,r.new_values,r.reason,r.created_at::text,
    COALESCE(NULLIF(concat_ws(' ',u.name,u.surname),''),u.username) AS operator_name FROM public.quality_measurement_revisions r
    JOIN public.quality_control c ON c.id=r.quality_control_id JOIN public.users u ON u.id=r.actor_user_id WHERE c.of_id=$1 ORDER BY r.created_at,r.id`,
      [ofId],
    )
  ).rows;
  const snapshot = context.technical_snapshot;
  const frozenOps = Array.isArray(snapshot?.operations)
    ? snapshot.operations
    : [];
  // Explicit projection keeps financial/preparation internals out of the kiosk.
  const gamme = frozenOps.map((op: Record<string, unknown>) => ({
    phase: op.phase,
    designation: op.designation,
    designation_2: op.designation_2,
    consignes: op.consignes,
    type_operation: op.type_operation,
    tp: op.tp,
    tf_unit: op.tf_unit,
    numero_programme: op.numero_programme,
    outils: op.outils,
    montage: op.montage,
    reglage: op.reglage,
  }));
  return {
    ...base,
    contract_version: 1,
    server_time: new Date().toISOString(),
    documents_manifest: documents,
    program,
    tooling,
    required_tools: requiredTools,
    instructions: { gamme, dossier_documents: documents },
    material: { ...(base.material as object), ...material },
    quality: {
      ...(base.quality as object),
      first_article: firstArticle,
      characteristics: snapshot?.preparation_evidence?.characteristics ?? [],
    },
    operations: operations.rows,
    executions: executions.rows,
    time_totals: timeTotals,
    autocontrols: controls,
    readiness,
    handover_operators: coworkers,
    measurement_history: measurementHistory,
    frozen_characteristics:
      snapshot?.preparation_evidence?.characteristics ?? [],
    scope: {
      of_id: ofId,
      operation_id: operationId,
      machine_id: terminal.machine_id,
    },
    cache_expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
  };
}
export async function assertStartAllowed(params: {
  terminal: Terminal;
  station: StationContext;
  ofId: number;
  operationId: string;
  planningVersion: string;
  reason?: string;
  activity: string;
  db: Db;
  key: string;
}) {
  const { terminal, station, ofId, operationId, db } = params;
  // Check revocation inside the effect transaction as well as at HTTP entry.
  const live = (
    await db.query(
      `SELECT t.id FROM public.cerp_terminals t JOIN public.production_devices d ON d.id=t.device_id
    JOIN public.cerp_terminal_sessions ts ON ts.terminal_id=t.id JOIN public.operator_device_sessions s ON s.id=ts.session_id
    JOIN public.cerp_terminal_pins p ON p.id=ts.pin_id JOIN public.users u ON u.id=s.user_id
    WHERE t.id=$1 AND s.id=$2 AND t.revoked_at IS NULL AND d.status='ACTIVE' AND s.state='ACTIVE' AND s.expires_at>now()
      AND p.revoked_at IS NULL AND u.status='Active' AND s.machine_id=d.machine_id FOR SHARE OF t,d,s,p,u`,
      [terminal.id, station.session_id],
    )
  ).rows[0];
  if (!live)
    throw new HttpError(
      401,
      "TERMINAL_SESSION_REVOKED",
      "La session ou la tablette n’est plus autorisée.",
    );
  const replay = (
    await db.query(
      "SELECT 1 FROM public.production_execution_idempotency WHERE idempotency_key=$1 AND user_id=$2",
      [params.key, station.user.id],
    )
  ).rows[0];
  if (replay) return; // canonical service still compares the full payload and owner
  const context = await operationContext(terminal, ofId, operationId, db);
  const event = (
    await db.query(
      `SELECT id,updated_at::text FROM public.planning_events WHERE of_operation_id=$1 AND machine_id=$2
    AND archived_at IS NULL AND status NOT IN('CANCELLED','DONE','BLOCKED') ORDER BY start_ts,id LIMIT 1 FOR SHARE`,
      [operationId, terminal.machine_id],
    )
  ).rows[0];
  if (!event || event.updated_at !== params.planningVersion)
    throw new HttpError(
      409,
      "TERMINAL_PLANNING_CHANGED",
      "Le planning a changé. Actualisez la file.",
    );
  if (context.machine_id && context.machine_id !== terminal.machine_id)
    throw new HttpError(
      409,
      "TERMINAL_MACHINE_CHANGED",
      "Cette opération a été réaffectée.",
    );
  const next = (
    await db.query(
      `SELECT op.id::text FROM public.planning_events e JOIN public.of_operations op ON op.id=e.of_operation_id
    JOIN public.ordres_fabrication o ON o.id=op.of_id WHERE e.machine_id=$1 AND e.archived_at IS NULL
    AND e.status NOT IN('CANCELLED','DONE') AND op.status NOT IN('DONE','CANCELLED') AND o.statut::text NOT IN('ANNULE','TERMINE')
    ORDER BY e.start_ts,op.phase,op.id LIMIT 1`,
      [terminal.machine_id],
    )
  ).rows[0];
  requireAlternativeReason(next?.id ?? null, operationId, params.reason);
  if (["PRODUCTION", "AUTO_MACHINE"].includes(params.activity)) {
    const first = await firstArticleState(context, db);
    if (first.blocks_series)
      throw new HttpError(
        409,
        "TERMINAL_FIRST_ARTICLE_REQUIRED",
        "La qualité doit valider le premier article avant la série.",
      );
    const program = await applicableProgram(context, db);
    if (program.required) {
      const confirmation = program.fingerprint
        ? (
            await db.query(
              "SELECT id FROM public.cerp_terminal_program_confirmations WHERE machine_id=$1 AND operation_id=$2 AND program_fingerprint=$3 LIMIT 1",
              [terminal.machine_id, operationId, program.fingerprint],
            )
          ).rows[0]
        : null;
      if (!program.validated || !confirmation)
        throw new HttpError(
          409,
          "TERMINAL_PROGRAM_CONFIRMATION_REQUIRED",
          "Vérifiez et confirmez le programme chargé avant la série.",
        );
    }
  }
  await audit(db, terminal.id, station.user.id, "START_REQUESTED", {
    of_id: ofId,
    operation_id: operationId,
    planning_event_id: event.id,
    reason: params.reason ?? null,
  });
}
export async function assertPointageScope(
  terminal: Terminal,
  station: StationContext,
  id: string,
  db: Db = pool,
) {
  const row = (
    await db.query<{
      of_id: number;
      operation_id: string;
      activity_code: string;
    }>(
      `SELECT of_id::int,operation_id::text,activity_code FROM public.production_pointages WHERE id=$1 AND machine_id=$2 AND operator_user_id=$3`,
      [id, terminal.machine_id, station.user.id],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "TERMINAL_EXECUTION_OUTSIDE_SCOPE",
      "Ce pointage n’appartient pas à votre poste.",
    );
  // An operator may always stop their own segment on this machine, even if
  // planning moved the operation since it began. Restart still checks planning.
  return row;
}
export async function resolveOperatorScan(terminal: Terminal, code: string) {
  let ofId: number | undefined;
  const match = /^CERP:1:([0-9a-f-]{36})$/i.exec(code);
  if (match) {
    // Use the canonical identification resolver; never trust a barcode as authority.
    const { resolveTerminalIdentification } = await import(
      "./terminal-scan.service"
    );
    ofId = await resolveTerminalIdentification(match[1]);
  }
  const rows = (
    await pool.query(
      `SELECT o.id::int AS of_id,op.id::text AS operation_id,o.numero FROM public.ordres_fabrication o
    JOIN public.of_operations op ON op.of_id=o.id WHERE (o.numero=$1 OR o.id=$2)
    AND (op.machine_id=$3 OR EXISTS(SELECT 1 FROM public.planning_events e WHERE e.of_operation_id=op.id AND e.machine_id=$3 AND e.archived_at IS NULL AND e.status<>'CANCELLED'))
    ORDER BY (op.status='RUNNING') DESC,(op.status NOT IN('DONE','CANCELLED')) DESC,op.phase`,
      [code, ofId ?? null, terminal.machine_id],
    )
  ).rows;
  if (!rows[0])
    throw new HttpError(
      404,
      "TERMINAL_SCAN_UNKNOWN",
      "OF non reconnu ou absent de cette machine.",
    );
  return rows[0];
}
