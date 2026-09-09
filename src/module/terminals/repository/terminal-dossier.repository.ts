import { createHash } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { Db, Terminal } from "./terminal-auth.repository";
import { assertProgramConfirmation } from "../domain/terminal-policy";
import { audit, transaction } from "./terminal-auth.repository";

export type OperationContext = {
  of_id: number;
  operation_id: string;
  phase: number;
  designation: string;
  status: string;
  machine_id: string | null;
  piece_technique_id: string;
  piece_technique_version_id: string | null;
  technical_snapshot: Record<string, any> | null;
  technical_snapshot_sha256: string | null;
  technical_readiness: string;
  quantite_lancee: number;
  numero: string;
  statut: string;
};
export async function operationContext(
  terminal: Terminal,
  ofId: number,
  operationId: string,
  db: Db = pool,
): Promise<OperationContext> {
  const row = (
    await db.query<OperationContext>(
      `SELECT o.id::int AS of_id,op.id::text AS operation_id,op.phase,op.designation,op.status::text,
    op.machine_id::text,o.piece_technique_id::text,o.piece_technique_version_id::text,o.technical_snapshot,o.technical_snapshot_sha256,
    o.technical_readiness,o.quantite_lancee::float8,o.numero,o.statut::text
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    WHERE op.id=$1 AND o.id=$2 AND (op.machine_id=$3 OR EXISTS(SELECT 1 FROM public.planning_events e
      WHERE e.of_operation_id=op.id AND e.machine_id=$3 AND e.archived_at IS NULL AND e.status<>'CANCELLED')
      OR EXISTS(SELECT 1 FROM public.production_pointages p WHERE p.operation_id=op.id AND p.machine_id=$3 AND p.status='RUNNING'))`,
      [operationId, ofId, terminal.machine_id],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "TERMINAL_OPERATION_OUTSIDE_SCOPE",
      "Cette opération n’est pas affectée à cette machine.",
    );
  return row;
}
export async function plannedWorklist(terminal: Terminal, offset = 0) {
  const rows = (
    await pool.query(
      `SELECT op.id::text AS operation_id,op.phase,op.designation,op.status::text AS operation_status,
    o.id::int AS of_id,o.numero,o.statut::text AS of_status,o.priority::text,o.quantite_lancee::float8,
    o.quantite_bonne::float8,o.quantite_rebut::float8,o.technical_readiness,o.technical_snapshot_sha256,
    pt.code_piece,pt.designation AS piece_designation,c.company_name AS client_name,
    e.id::text AS planning_event_id,e.start_ts::text,e.end_ts::text,e.updated_at::text AS planning_version,e.status::text AS planning_status,
    active.id::text AS active_id,active.operator_user_id,active.activity_code,
    EXISTS(SELECT 1 FROM public.of_operations prev WHERE prev.of_id=o.id AND prev.phase<op.phase AND prev.status NOT IN('DONE','CANCELLED')) AS predecessor_pending,
    count(*) OVER()::int AS total
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    JOIN LATERAL(SELECT * FROM public.planning_events p WHERE p.of_operation_id=op.id AND p.machine_id=$1
      AND p.archived_at IS NULL AND p.status NOT IN('CANCELLED','DONE') ORDER BY p.start_ts,p.id LIMIT 1) e ON true
    LEFT JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
    LEFT JOIN public.clients c ON c.client_id=o.client_id
    LEFT JOIN LATERAL(SELECT p.id,p.operator_user_id,p.activity_code FROM public.production_pointages p
      WHERE p.operation_id=op.id AND p.machine_id=$1 AND p.status='RUNNING' ORDER BY p.start_ts DESC LIMIT 1) active ON true
    WHERE o.statut::text NOT IN('ANNULE','TERMINE') AND op.status::text NOT IN('DONE','CANCELLED')
      AND (op.machine_id IS NULL OR op.machine_id=$1)
      AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
    ORDER BY (active.id IS NOT NULL) DESC,e.start_ts,op.phase,op.id LIMIT 100 OFFSET $2`,
      [terminal.machine_id, offset],
    )
  ).rows;
  return {
    server_time: new Date().toISOString(),
    total: rows[0]?.total ?? 0,
    next_offset: rows.length === 100 ? offset + 100 : null,
    recommended_operation_id: rows[0]?.operation_id ?? null,
    items: rows.map(({ total, ...r }) => r),
  };
}
export async function dossierDocuments(context: OperationContext) {
  // Only versions carried by the released OF snapshot. Never current_version_id.
  const evidence = context.technical_snapshot?.preparation_evidence?.documents;
  const docs: Array<{
    id: string;
    version_id: string;
    role: string;
    sha256?: string;
  }> = Array.isArray(evidence) ? evidence : [];
  const rows = (
    await pool.query(
      `SELECT v.id::text,v.document_id::text,v.version_number,v.original_name AS name,v.status,v.published_at,
    b.mime_type,b.size_bytes::float8,b.sha256,d.title
    FROM public.ged_document_versions v JOIN public.ged_documents d ON d.id=v.document_id JOIN public.ged_blobs b ON b.id=v.blob_id
    WHERE v.id=ANY($1::uuid[])`,
      [docs.map((d) => d.version_id)],
    )
  ).rows;
  const manifest: Array<{
    id: string;
    source: string;
    category: string;
    name: string;
    title: string | null;
    version: number | null;
    mime_type: string | null;
    size_bytes: number | null;
    sha256: string | null;
    available: boolean;
    download_path: string;
    reception_id?: string;
  }> = docs.map((doc) => {
    const found = rows.find((r) => r.id === doc.version_id);
    return {
      id: doc.version_id,
      source: "GED" as string,
      category: doc.role,
      name: found?.name ?? "Document indisponible",
      title: found?.title ?? null,
      version: found?.version_number ?? null,
      mime_type: found?.mime_type ?? null,
      size_bytes: found?.size_bytes ?? null,
      sha256: doc.sha256 ?? found?.sha256 ?? null,
      available:
        !!found &&
        ["APPLICABLE", "OBSOLETE"].includes(found.status) &&
        !!found.published_at &&
        (!doc.sha256 || doc.sha256 === found.sha256),
      download_path: `/terminals/operator/ofs/${context.of_id}/operations/${context.operation_id}/documents/${doc.version_id}`,
    };
  });
  const sheet = (
    await pool.query(
      `SELECT s.id::text,s.pdf_sha256,octet_length(s.pdf)::float8 AS size_bytes,s.snapshot->'plan'->>'version' AS version
    FROM public.of_self_inspection_sheets s JOIN public.ordres_fabrication o ON o.id=s.of_id
    WHERE o.id=$1 AND s.id::text=o.technical_preparation->>'self_inspection_sheet_id'
    AND s.piece_technique_version_id=o.piece_technique_version_id AND s.state='READY'`,
      [context.of_id],
    )
  ).rows[0];
  if (sheet)
    manifest.push({
      id: sheet.id,
      source: "SELF_INSPECTION",
      category: "FICHE_AUTOCONTROLE",
      name: `Autocontrôle ${context.numero}.pdf`,
      title: "Fiche d’autocontrôle de l’OF",
      version: Number(sheet.version),
      mime_type: "application/pdf",
      size_bytes: sheet.size_bytes,
      sha256: sheet.pdf_sha256,
      available: true,
      download_path: `/terminals/operator/ofs/${context.of_id}/operations/${context.operation_id}/documents/${sheet.id}`,
    });
  const official = (
    await pool.query(
      `SELECT d.id::text,d.pdf_sha256,d.pdf_byte_size,r.revision_rank AS version
    FROM public.of_documents d JOIN public.of_revisions r ON r.id=d.revision_id
    WHERE d.of_id=$1 AND r.statut='ACTIVE' AND d.statut='OFFICIEL' AND d.pdf_sha256 IS NOT NULL`,
      [context.of_id],
    )
  ).rows;
  for (const doc of official)
    manifest.push({
      id: doc.id,
      source: "OF_DOCUMENT",
      category: "ORDRE_FABRICATION",
      name: `${context.numero}.pdf`,
      title: "Ordre de fabrication officiel",
      version: Number(doc.version),
      mime_type: "application/pdf",
      size_bytes: doc.pdf_byte_size,
      sha256: doc.pdf_sha256,
      available: true,
      download_path: `/terminals/operator/ofs/${context.of_id}/operations/${context.operation_id}/documents/${doc.id}`,
    });
  const certificates = (
    await pool.query(
      `WITH RECURSIVE assigned(id) AS(
    SELECT r.lot_id FROM public.stock_reservations r WHERE(r.of_id=$1 OR(r.source_type='OF' AND r.source_id=$1::text))
      AND r.lot_id IS NOT NULL AND(r.status IN('ACTIVE','CONSUMED') OR r.qty_consumed>0)
    UNION SELECT e.parent_lot_id FROM public.stock_lot_genealogy_edges e JOIN assigned a ON a.id=e.child_lot_id)
    SELECT DISTINCT d.id::text,d.reception_id::text,d.original_name,d.label,d.mime_type,d.size_bytes::float8,d.sha256
    FROM public.reception_fournisseur_documents d JOIN public.reception_fournisseur_lignes l ON l.reception_id=d.reception_id
      AND(d.reception_line_id IS NULL OR d.reception_line_id=l.id) JOIN assigned a ON a.id=l.lot_id
    WHERE d.removed_at IS NULL AND d.document_type='CERTIFICAT_MATIERE'`,
      [context.of_id],
    )
  ).rows;
  for (const doc of certificates)
    manifest.push({
      id: doc.id,
      source: "MATERIAL_CERTIFICATE",
      category: "CERTIFICATE",
      name: doc.original_name,
      title: doc.label,
      version: null,
      mime_type: doc.mime_type,
      size_bytes: doc.size_bytes,
      sha256: doc.sha256,
      available: !!doc.sha256,
      reception_id: doc.reception_id,
      download_path: `/terminals/operator/ofs/${context.of_id}/operations/${context.operation_id}/documents/${doc.id}`,
    });
  return manifest;
}
export async function materialForOf(context: OperationContext) {
  const [needs, reservations] = await Promise.all([
    pool.query(
      `SELECT n.designation,n.required_qty::float8,n.unit,n.supply_mode,n.requirements,n.debit_rule
      FROM public.of_material_needs n WHERE n.of_id=$1 AND n.technical_version_id=$2 AND n.superseded_at IS NULL ORDER BY n.created_at,n.id`,
      [context.of_id, context.piece_technique_version_id],
    ),
    pool.query(
      `SELECT a.code AS article,l.lot_code,l.supplier_lot_code,l.lot_status,l.material_properties,
      r.qty_reserved::float8,r.qty_consumed::float8,r.status,a.unite
      FROM public.stock_reservations r LEFT JOIN public.lots l ON l.id=r.lot_id LEFT JOIN public.articles a ON a.id=r.article_id
      WHERE (r.of_id=$1 OR(r.source_type='OF' AND r.source_id=$1::text))
      AND(r.status IN('ACTIVE','CONSUMED') OR r.qty_consumed>0) ORDER BY r.created_at,r.id`,
      [context.of_id],
    ),
  ]);
  return { needs: needs.rows, allocations: reservations.rows };
}
export async function firstArticleState(
  context: OperationContext,
  db: Db = pool,
) {
  const evidence = context.technical_snapshot?.preparation_evidence;
  const chars = Array.isArray(evidence?.characteristics)
    ? evidence.characteristics
    : [];
  const frozenRequired =
    evidence?.quality_plan?.trigger_type === "FIRST_ARTICLE" ||
    chars.some(
      (c: Record<string, unknown>) =>
        c.trigger_type === "FIRST_ARTICLE" || c.trigger === "FIRST_ARTICLE",
    );
  const row = (
    await db.query<{ required: boolean; passed: boolean }>(
      `SELECT
    ($2::boolean OR EXISTS(SELECT 1 FROM public.quality_control_plan q WHERE q.id::text=$3 AND q.trigger_type='FIRST_ARTICLE')
      OR EXISTS(SELECT 1 FROM public.quality_control c WHERE c.of_id=$1 AND c.trigger_type='FIRST_ARTICLE')) AS required,
    EXISTS(SELECT 1 FROM public.quality_control c WHERE c.of_id=$1 AND c.trigger_type='FIRST_ARTICLE'
      AND c.validation_date IS NOT NULL AND COALESCE(c.verdict,c.verdict_computed)='CONFORME') AS passed`,
      [context.of_id, frozenRequired, evidence?.quality_plan?.id ?? null],
    )
  ).rows[0];
  const required = row?.required === true,
    passed = row?.passed === true;
  return {
    required,
    passed,
    blocks_series: required && !passed,
    message: required
      ? passed
        ? "Premier article validé conforme par la qualité."
        : "Premier article requis : validation qualité nécessaire avant la série."
      : "Aucun premier article exigé par le dossier applicable.",
  };
}
export function frozenProgram(context: OperationContext) {
  const snapshot = context.technical_snapshot;
  const ops = Array.isArray(snapshot?.operations) ? snapshot.operations : [];
  const op = ops.find(
    (o: Record<string, unknown>) => Number(o.phase) === context.phase,
  );
  const decision = snapshot?.preparation_decisions?.programming;
  const reference =
    typeof op?.numero_programme === "string" && op.numero_programme.trim()
      ? op.numero_programme.trim()
      : typeof decision?.reference === "string"
        ? decision.reference.trim()
        : null;
  const required =
    decision?.mode !== "NONE" &&
    ["FRAISAGE", "TOURNAGE", "REPRISE"].includes(op?.type_operation ?? "");
  const fingerprint =
    reference && context.technical_snapshot_sha256
      ? createHash("sha256")
          .update(
            JSON.stringify([
              context.technical_snapshot_sha256,
              context.operation_id,
              context.machine_id,
              reference,
              snapshot?.preparation_evidence?.documents ?? [],
            ]),
          )
          .digest("hex")
      : null;
  return {
    reference,
    fingerprint,
    required,
    validated: !!fingerprint && context.technical_readiness === "VALIDATED",
    source: "OF_SNAPSHOT",
    notice: reference
      ? null
      : "Aucune référence programme figée dans ce dossier. Les méthodes doivent la renseigner.",
  };
}
export async function programConfirmation(
  terminal: Terminal,
  context: OperationContext,
) {
  const program = await applicableProgram(context);
  const confirmation = program.fingerprint
    ? ((
        await pool.query(
          `SELECT id,operator_id,confirmed_at::text FROM public.cerp_terminal_program_confirmations
    WHERE machine_id=$1 AND operation_id=$2 AND program_fingerprint=$3 ORDER BY confirmed_at DESC LIMIT 1`,
          [terminal.machine_id, context.operation_id, program.fingerprint],
        )
      ).rows[0] ?? null)
    : null;
  return { ...program, confirmation };
}
export async function confirmProgram(
  terminal: Terminal,
  ofId: number,
  operationId: string,
  fingerprint: string,
  actor: number,
  key: string,
) {
  return transaction(async (tx) => {
    await tx.query(
      "SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE",
      [ofId],
    );
    const context = await operationContext(terminal, ofId, operationId, tx);
    const program = await applicableProgram(context, tx);
    assertProgramConfirmation(
      program.validated ? program.fingerprint : null,
      fingerprint,
    );
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key,
    ]);
    const replay = (
      await tx.query(
        "SELECT * FROM public.cerp_terminal_program_confirmations WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0];
    if (replay) {
      if (
        replay.terminal_id !== terminal.id ||
        replay.operator_id !== actor ||
        replay.operation_id !== operationId ||
        replay.program_fingerprint !== fingerprint
      )
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette tentative a déjà un autre contenu.",
        );
      return { id: replay.id, confirmed_at: replay.confirmed_at };
    }
    const row = (
      await tx.query(
        `INSERT INTO public.cerp_terminal_program_confirmations(terminal_id,operator_id,machine_id,of_id,operation_id,program_fingerprint,program_reference,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,confirmed_at`,
        [
          terminal.id,
          actor,
          terminal.machine_id,
          ofId,
          operationId,
          fingerprint,
          program.reference,
          key,
        ],
      )
    ).rows[0];
    await audit(tx, terminal.id, actor, "PROGRAM_LOADED_CONFIRMED", {
      operation_id: operationId,
      fingerprint,
    });
    return row;
  });
}
export async function applicableProgram(
  context: OperationContext,
  db: Db = pool,
) {
  const frozen = frozenProgram(context);
  const decision =
    context.technical_snapshot?.preparation_decisions?.programming;
  if (decision?.mode !== "TASK") return frozen;
  const task = (
    await db.query<{
      program_reference: string;
      completed_at: string;
      updated_at: string;
    }>(
      `SELECT program_reference,completed_at::text,updated_at::text
    FROM public.piece_version_programming_tasks WHERE id::text=$1 AND piece_technique_version_id=$2 AND status='DONE'`,
      [decision.task_id, context.piece_technique_version_id],
    )
  ).rows[0];
  if (!task)
    return {
      ...frozen,
      reference: null,
      fingerprint: null,
      validated: false,
      notice: "La tâche de programmation de cet indice reste à terminer.",
    };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        context.technical_snapshot_sha256,
        context.operation_id,
        context.machine_id,
        decision.task_id,
        task.program_reference,
        task.completed_at,
        task.updated_at,
      ]),
    )
    .digest("hex");
  return {
    ...frozen,
    reference: task.program_reference,
    fingerprint,
    validated: context.technical_readiness === "VALIDATED",
    source: "VERSION_PROGRAMMING_TASK",
    notice: null,
  };
}
export async function toolingForOf(context: OperationContext) {
  return (
    await pool.query(
      `SELECT o.codification,o.reference_fabricant,o.designation_outil_cnc AS designation,
      a.reserved_quantity,a.issued_quantity,a.returned_quantity,a.broken_quantity,a.worn_quantity,a.status,a.notes
    FROM public.outillage_allocations a JOIN public.gestion_outils_outil o ON o.id_outil=a.id_outil
    WHERE a.of_id=$1 AND a.piece_technique_version_id=$2 ORDER BY a.created_at`,
      [context.of_id, context.piece_technique_version_id],
    )
  ).rows;
}
export async function requiredToolsForOf(context: OperationContext) {
  return (
    await pool.query(
      `SELECT o.codification,o.reference_fabricant,o.designation_outil_cnc AS designation,r.required_quantity,r.usage_notes
    FROM public.piece_version_tool_requirements r JOIN public.gestion_outils_outil o ON o.id_outil=r.id_outil
    WHERE r.piece_technique_version_id=$1 ORDER BY o.codification,r.id_outil`,
      [context.piece_technique_version_id],
    )
  ).rows;
}
export async function qualityIdsForOf(ofId: number) {
  return (
    await pool.query<{ id: string }>(
      "SELECT id::text FROM public.quality_control WHERE of_id=$1 ORDER BY control_date DESC,id",
      [ofId],
    )
  ).rows.map((r) => r.id);
}
export async function assertQualityScope(
  terminal: Terminal,
  ofId: number,
  operationId: string,
  controlId: string,
) {
  await operationContext(terminal, ofId, operationId);
  const row = (
    await pool.query(
      "SELECT id FROM public.quality_control WHERE id=$1 AND of_id=$2",
      [controlId, ofId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "TERMINAL_CONTROL_OUTSIDE_SCOPE",
      "Ce contrôle n’appartient pas à cet OF.",
    );
}
