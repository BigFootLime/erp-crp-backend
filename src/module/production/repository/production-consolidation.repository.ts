import { PLANNED_OPERATION_DURATION_MINUTES_SQL } from "../domain/planned-operation-duration";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import {
  copyPieceOperationsToOf,
  loadApplicableTechnicalSnapshot,
} from "../domain/of-generation";
import {
  buildConsolidationPlan,
  type ConsolidationSource,
} from "../domain/consolidation-rules";
import { sourceHash } from "../domain/preparation-rules";
import {
  preparationAudit,
  assertOfPreparationReady,
  evaluateOfPreparation,
} from "./production-preparation.repository";
import { generateSelfInspectionTx } from "./self-inspection.repository";
import { createConsolidationSurplusComponents } from "./consolidation-components.repository";
import type { AuditContext } from "./production.repository";
import type { ConsolidationRequest } from "../validators/production-workbench.validators";

type Db = Pick<PoolClient, "query">;
async function assertConsolidationEnabled(tx: Db) {
  const flag = (
    await tx.query<{ enabled: boolean }>(
      `SELECT enabled FROM public.app_feature_flags WHERE key='PRODUCTION_CONSOLIDATION'`,
    )
  ).rows[0];
  if (!flag?.enabled)
    throw new HttpError(
      409,
      "CONSOLIDATION_DISABLED",
      "Le regroupement de production n’est pas encore activé.",
    );
}
async function readSources(
  tx: Db,
  request: ConsolidationRequest,
  lock: boolean,
) {
  const ids = request.sources.map((s) => s.of_id).sort((a, b) => a - b);
  if (lock)
    await tx.query(
      "SELECT id FROM public.ordres_fabrication WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [ids],
    );
  const sources = (
    await tx.query<ConsolidationSource>(
      `SELECT o.id::bigint::int AS id,o.numero,o.priority::text,o.client_id,o.article_id::text,o.piece_technique_id::text,o.piece_technique_version_id::text,
    o.technical_snapshot_sha256,o.technical_snapshot,o.quantite_lancee::float8,o.quantite_bonne::float8,o.quantite_rebut::float8,o.statut::text,o.technical_readiness,
    o.updated_at::text,o.planning_wait_started_at::text,o.date_fin_prevue::text,o.parent_of_id::bigint::int,o.root_of_id::bigint::int,
    (SELECT count(*)::int FROM public.planning_events e WHERE (e.of_id=o.id OR e.of_operation_id IN(SELECT id FROM public.of_operations WHERE of_id=o.id)) AND e.archived_at IS NULL AND e.status<>'CANCELLED') AS planned_count,
    (SELECT count(*)::int FROM public.of_operations op WHERE op.of_id=o.id AND op.status::text NOT IN ('TODO','READY')) AS started_count,
    EXISTS(SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id=o.id AND a.state='ACTIVE') AS covered,
    EXISTS(SELECT 1 FROM public.production_consolidations c WHERE c.producer_of_id=o.id) AS producer
    FROM public.ordres_fabrication o WHERE o.id=ANY($1::bigint[]) ORDER BY o.id`,
      [ids],
    )
  ).rows;
  if (sources.length !== ids.length)
    throw new HttpError(
      404,
      "OF_NOT_FOUND",
      "Un OF sélectionné est introuvable.",
    );
  for (const s of sources)
    if (
      s.updated_at !==
      request.sources.find((r) => r.of_id === s.id)!.expected_updated_at
    )
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        `${s.numero} a changé. Rechargez l’aperçu.`,
      );
  return sources;
}
async function previewTx(tx: Db, request: ConsolidationRequest, lock = false) {
  await assertConsolidationEnabled(tx);
  const sources = await readSources(tx, request, lock);
  const plan = buildConsolidationPlan(sources, request.surplus_quantity);
  const load = (
    await tx.query<{ producer_minutes: number; separate_minutes: number }>(
      `SELECT (SELECT COALESCE(sum(${PLANNED_OPERATION_DURATION_MINUTES_SQL}),0)::int FROM public.of_operations op CROSS JOIN (SELECT $2::numeric AS quantite_lancee) o WHERE op.of_id=$1) AS producer_minutes,
    (SELECT COALESCE(sum(${PLANNED_OPERATION_DURATION_MINUTES_SQL}),0)::int FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id WHERE o.id=ANY($3::bigint[])) AS separate_minutes`,
      [sources[0].id, plan.quantity, sources.map((s) => s.id)],
    )
  ).rows[0];
  return {
    ...plan,
    workload: load,
    preview_hash: sourceHash({
      request,
      sources: sources.map((s) => ({
        id: s.id,
        updated_at: s.updated_at,
        hash: s.technical_snapshot_sha256,
      })),
      plan,
    }),
    sources,
  };
}
export async function repoPreviewConsolidation(request: ConsolidationRequest) {
  return previewTx(pool, request);
}

export async function repoCreateConsolidation(
  input: {
    request: ConsolidationRequest;
    idempotency_key: string;
    preview_hash: string;
  },
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    // The advisory lock serialises identical retries before the unique insert.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `consolidation:${input.idempotency_key}`,
    ]);
    const requestHash = sourceHash(input.request);
    const prior = (
      await tx.query<{
        id: string;
        producer_of_id: number;
        request_hash: string;
        state: string;
      }>(
        `SELECT id::text,producer_of_id::bigint::int,request_hash,state FROM public.production_consolidations WHERE idempotency_key=$1::uuid`,
        [input.idempotency_key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette clé correspond à un autre regroupement.",
        );
      return { ...prior, idempotent_replay: true };
    }
    const preview = await previewTx(tx, input.request, true);
    if (preview.preview_hash !== input.preview_hash)
      throw new HttpError(
        409,
        "CONSOLIDATION_PREVIEW_CHANGED",
        "L’aperçu a changé. Recalculez le regroupement.",
      );
    for (const s of preview.sources) await assertOfPreparationReady(tx, s.id);
    const first = preview.sources[0];
    const firstEvaluation = await evaluateOfPreparation(tx, first.id);
    const currentTechnical = await loadApplicableTechnicalSnapshot(
      tx,
      first.piece_technique_id,
      {
        pinned_version_id: first.piece_technique_version_id,
        preparation_evidence: firstEvaluation.sources,
      },
    );
    if (currentTechnical.sha256 !== first.technical_snapshot_sha256)
      throw new HttpError(
        409,
        "CONSOLIDATION_DEFINITION_CHANGED",
        "La définition applicable diffère des OF sélectionnés. Révisez les OF avant regroupement.",
      );
    const snapshot = first.technical_snapshot as { gamme?: { id?: string } };
    const producerId = Number(
      (
        await tx.query<{ id: string }>(
          `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id'))::text AS id`,
        )
      ).rows[0].id,
    );
    const numero = await generateTransactionalBusinessCode(tx, {
      prefix: "OF",
    });
    await tx.query(
      `INSERT INTO public.ordres_fabrication(id,numero,article_id,client_id,piece_technique_id,piece_technique_version_id,
      technical_snapshot,technical_snapshot_sha256,technical_snapshot_at,technical_readiness,technical_preparation,preparation_rules_version,
      quantite_lancee,statut,priority,root_of_id,generation_level,structure_path,quantity_per_parent,quantity_cumulative,planning_wait_started_at,date_fin_prevue,notes,created_by,updated_by)
      VALUES($1::bigint,$2,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb,$8,now(),'VALIDATED',jsonb_build_object('consolidation',true),1,
      $9,'BROUILLON',$14::of_priority,$1::bigint,0,($1::bigint)::text,1,1,$10::timestamptz,$11::date,$12,$13,$13)`,
      [
        producerId,
        numero,
        first.article_id,
        first.client_id,
        first.piece_technique_id,
        first.piece_technique_version_id,
        JSON.stringify(first.technical_snapshot),
        first.technical_snapshot_sha256,
        preview.quantity,
        preview.planning_wait_started_at,
        preview.allocations
          .map((a) => a.due_date)
          .filter(Boolean)
          .sort()[0] ?? null,
        input.request.reason,
        audit.user_id,
        [...preview.sources].sort(
          (a, b) =>
            ["LOW", "NORMAL", "HIGH", "CRITICAL"].indexOf(
              b.priority ?? "NORMAL",
            ) -
            ["LOW", "NORMAL", "HIGH", "CRITICAL"].indexOf(
              a.priority ?? "NORMAL",
            ),
        )[0].priority ?? "NORMAL",
      ],
    );
    await tx.query(
      "INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by) VALUES($1,$2::uuid,$3::jsonb,$4,$5)",
      [
        producerId,
        first.piece_technique_version_id,
        JSON.stringify(first.technical_snapshot),
        first.technical_snapshot_sha256,
        audit.user_id,
      ],
    );
    // Copying from the live gamme would silently change an older validated source.
    // The snapshot is compared with current source operations before this call.
    if (!snapshot.gamme?.id)
      throw new HttpError(
        422,
        "CONSOLIDATION_GAMME_MISSING",
        "La gamme figée est absente.",
      );
    const operationCount = await copyPieceOperationsToOf(tx, {
      of_id: producerId,
      piece_technique_id: first.piece_technique_id,
      gamme_id: snapshot.gamme.id,
    });
    if (!operationCount)
      throw new HttpError(
        422,
        "CONSOLIDATION_GAMME_MISSING",
        "La gamme ne contient aucune opération.",
      );
    const group = (
      await tx.query<{ id: string }>(
        `INSERT INTO public.production_consolidations(producer_of_id,idempotency_key,request_hash,surplus_quantity,reason,created_by)
      VALUES($1,$2::uuid,$3,$4,$5,$6) RETURNING id::text`,
        [
          producerId,
          input.idempotency_key,
          requestHash,
          input.request.surplus_quantity,
          input.request.reason,
          audit.user_id,
        ],
      )
    ).rows[0];
    for (const s of preview.sources) {
      // Requirements and their reservations follow the physical producer.
      // The commercial source and its child genealogy remain traceable.
      await tx.query(
        `INSERT INTO public.production_consolidation_component_transfers(consolidation_id,requirement_id,source_of_id)
        SELECT $1::uuid,id,consuming_of_id FROM public.of_component_requirements WHERE consuming_of_id=$2 AND status<>'CANCELLED'`,
        [group.id, s.id],
      );
      await tx.query(
        `UPDATE public.of_component_requirements SET consuming_of_id=$1,updated_at=now() WHERE consuming_of_id=$2 AND status<>'CANCELLED'`,
        [producerId, s.id],
      );
      await tx.query(
        `UPDATE public.stock_reservations SET of_id=$1,updated_at=now(),updated_by=$3 WHERE of_id=$2 AND of_component_requirement_id IN(SELECT requirement_id FROM public.production_consolidation_component_transfers WHERE consolidation_id=$4::uuid) AND status='ACTIVE'`,
        [producerId, s.id, audit.user_id, group.id],
      );
      await tx.query(
        `INSERT INTO public.production_consolidation_allocations(consolidation_id,source_of_id,quantity,due_date,source_updated_at)
        VALUES($1::uuid,$2,$3,$4::date,$5::timestamptz)`,
        [group.id, s.id, s.quantite_lancee, s.date_fin_prevue, s.updated_at],
      );
      await tx.query(
        "UPDATE public.ordres_fabrication SET updated_at=now(),updated_by=$2 WHERE id=$1",
        [s.id, audit.user_id],
      );
      await preparationAudit(
        tx,
        audit,
        s.id,
        "production.consolidation.cover",
        {
          consolidation_id: group.id,
          producer_of_id: producerId,
          quantity: s.quantite_lancee,
        },
      );
    }
    await createConsolidationSurplusComponents(
      tx,
      {
        group_id: group.id,
        producer_id: producerId,
        piece_id: first.piece_technique_id,
        version_id: first.piece_technique_version_id!,
        client_id: first.client_id,
        surplus: input.request.surplus_quantity,
        snapshot: first.technical_snapshot,
      },
      audit,
    );
    const producerEvaluation = await evaluateOfPreparation(tx, producerId);
    await tx.query(
      `INSERT INTO public.of_stock_reviews(of_id,source_hash,decision,reason,reviewed_by) VALUES($1,$2,'NO_REUSE',$3,$4)`,
      [
        producerId,
        producerEvaluation.stock_hash,
        `Regroupement validé : besoins déjà nets de stock. ${input.request.reason}`,
        audit.user_id,
      ],
    );
    const prepared = await generateSelfInspectionTx(
      tx,
      producerId,
      producerEvaluation.of.updated_at,
      audit,
    );
    if (!prepared.ready || prepared.sheet?.state !== "READY")
      throw new HttpError(
        422,
        "CONSOLIDATION_PREPARATION_INCOMPLETE",
        "La fiche du regroupement n’a pas pu être préparée. Aucun OF n’a été regroupé.",
      );
    await tx.query(
      `UPDATE public.ordres_fabrication SET technical_preparation=technical_preparation||jsonb_build_object('self_inspection_sheet_id',$2::text,'prepared_source_hash',$3::text),technical_validated_at=now(),technical_validated_by=$4 WHERE id=$1`,
      [producerId, prepared.sheet.id, prepared.source_hash, audit.user_id],
    );
    await preparationAudit(
      tx,
      audit,
      producerId,
      "production.consolidation.create",
      {
        consolidation_id: group.id,
        ...preview,
        sources: preview.sources.map((s) => s.id),
      },
    );
    return {
      id: group.id,
      producer_of_id: producerId,
      numero,
      quantity: preview.quantity,
      idempotent_replay: false,
    };
  });
}

export async function repoGetConsolidation(id: string) {
  const group = (
    await pool.query(
      `SELECT c.*,o.numero,o.updated_at::text AS producer_updated_at,o.statut::text AS producer_status,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'source_of_id',a.source_of_id,'numero',s.numero,'quantity',a.quantity,'received_quantity',a.received_quantity,'due_date',a.due_date,'state',a.state) ORDER BY a.due_date,a.source_of_id)
      FROM public.production_consolidation_allocations a JOIN public.ordres_fabrication s ON s.id=a.source_of_id WHERE a.consolidation_id=c.id),'[]'::jsonb) AS allocations
    FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id WHERE c.id=$1::uuid`,
      [id],
    )
  ).rows[0];
  if (!group)
    throw new HttpError(
      404,
      "CONSOLIDATION_NOT_FOUND",
      "Regroupement introuvable.",
    );
  return group;
}

export async function repoDissolveConsolidation(
  id: string,
  body: { expected_updated_at: string; reason: string },
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    const group = (
      await tx.query<{
        producer_of_id: number;
        state: string;
        surplus_of_ids: string[];
      }>(
        "SELECT producer_of_id::bigint::int,state,surplus_of_ids FROM public.production_consolidations WHERE id=$1::uuid FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!group)
      throw new HttpError(
        404,
        "CONSOLIDATION_NOT_FOUND",
        "Regroupement introuvable.",
      );
    if (group.state === "DISSOLVED")
      return { id, state: "DISSOLVED", idempotent_replay: true };
    const producer = (
      await tx.query<{
        updated_at: string;
        statut: string;
        quantite_bonne: number;
        quantite_rebut: number;
      }>(
        "SELECT updated_at::text,statut::text,quantite_bonne,quantite_rebut FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE",
        [group.producer_of_id],
      )
    ).rows[0];
    if (producer.updated_at !== body.expected_updated_at)
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "Le producteur a changé. Rechargez le dossier.",
      );
    const engaged = (
      await tx.query<{ engaged: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM public.planning_events WHERE (of_id=$1 OR of_operation_id IN(SELECT id FROM public.of_operations WHERE of_id=$1)) AND archived_at IS NULL AND status<>'CANCELLED')
      OR EXISTS(SELECT 1 FROM public.of_operations WHERE of_id=$1 AND status::text NOT IN ('TODO','READY'))
      OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE consolidation_id=$2::uuid AND received_quantity>0)
      OR EXISTS(SELECT 1 FROM public.stock_reservations WHERE of_id=$1 AND status IN ('ACTIVE','CONSUMED') AND (status='CONSUMED' OR of_component_requirement_id IS NULL OR of_component_requirement_id NOT IN(SELECT requirement_id FROM public.production_consolidation_component_transfers WHERE consolidation_id=$2::uuid))) AS engaged`,
        [group.producer_of_id, id],
      )
    ).rows[0].engaged;
    if (
      producer.statut !== "BROUILLON" ||
      Number(producer.quantite_bonne) > 0 ||
      Number(producer.quantite_rebut) > 0 ||
      engaged
    )
      throw new HttpError(
        409,
        "CONSOLIDATION_ENGAGED",
        "Le regroupement est engagé. Corrigez son reliquat par une révision contrôlée.",
      );
    const extraIds = group.surplus_of_ids.map(Number);
    const extraEngaged = (
      await tx.query(
        `SELECT 1 FROM public.ordres_fabrication o WHERE o.id=ANY($1::bigint[]) AND (o.statut<>'BROUILLON' OR o.quantite_bonne>0 OR o.quantite_rebut>0
      OR EXISTS(SELECT 1 FROM public.planning_events e LEFT JOIN public.of_operations op ON op.id=e.of_operation_id WHERE COALESCE(op.of_id,e.of_id)=o.id AND e.archived_at IS NULL AND e.status<>'CANCELLED')
      OR EXISTS(SELECT 1 FROM public.stock_reservations r WHERE r.of_id=o.id AND r.status IN ('ACTIVE','CONSUMED'))) LIMIT 1`,
        [extraIds],
      )
    ).rows[0];
    if (extraEngaged)
      throw new HttpError(
        409,
        "CONSOLIDATION_SURPLUS_ENGAGED",
        "Un composant du stock supplémentaire est déjà engagé. Révisez son reliquat avant dissolution.",
      );
    await tx.query(
      `UPDATE public.of_component_requirements SET status='CANCELLED',updated_at=now() WHERE (consuming_of_id=$1 OR consuming_of_id=ANY($2::bigint[])) AND id NOT IN(SELECT requirement_id FROM public.production_consolidation_component_transfers WHERE consolidation_id=$3::uuid)`,
      [group.producer_of_id, extraIds, id],
    );
    await tx.query(
      `UPDATE public.ordres_fabrication SET statut='ANNULE',updated_at=now(),updated_by=$2 WHERE id=ANY($1::bigint[])`,
      [extraIds, audit.user_id],
    );
    await tx.query(
      `UPDATE public.stock_reservations r SET of_id=t.source_of_id,updated_at=now(),updated_by=$2 FROM public.production_consolidation_component_transfers t WHERE t.consolidation_id=$1::uuid AND r.of_component_requirement_id=t.requirement_id AND r.status='ACTIVE'`,
      [id, audit.user_id],
    );
    await tx.query(
      `UPDATE public.of_component_requirements r SET consuming_of_id=t.source_of_id,updated_at=now() FROM public.production_consolidation_component_transfers t WHERE t.consolidation_id=$1::uuid AND r.id=t.requirement_id`,
      [id],
    );
    const sources = (
      await tx.query<{ source_of_id: number }>(
        `UPDATE public.production_consolidation_allocations SET state='CANCELLED' WHERE consolidation_id=$1::uuid RETURNING source_of_id::bigint::int`,
        [id],
      )
    ).rows;
    await tx.query(
      `UPDATE public.production_consolidations SET state='DISSOLVED',dissolved_at=now(),dissolved_by=$2,dissolution_reason=$3 WHERE id=$1::uuid`,
      [id, audit.user_id, body.reason],
    );
    await tx.query(
      `UPDATE public.ordres_fabrication SET statut='ANNULE',updated_at=now(),updated_by=$2 WHERE id=$1`,
      [group.producer_of_id, audit.user_id],
    );
    for (const s of sources)
      await preparationAudit(
        tx,
        audit,
        s.source_of_id,
        "production.consolidation.restore",
        { consolidation_id: id, reason: body.reason },
      );
    await preparationAudit(
      tx,
      audit,
      group.producer_of_id,
      "production.consolidation.dissolve",
      { consolidation_id: id, reason: body.reason },
    );
    return { id, state: "DISSOLVED", idempotent_replay: false };
  });
}
