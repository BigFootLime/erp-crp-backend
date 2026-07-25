// Analyse d'impact métrologique (#229).
//
// Ce dépôt matérialise une LISTE EXPLICABLE d'usages d'un instrument sur une
// fenêtre bornée. Il n'annule aucun contrôle, ne déstocke aucun lot, n'annule
// aucun BL, ne crée aucun avoir, ne bloque aucune expédition et ne déclenche
// aucun rappel client. Les seules écritures hors métrologie sont… aucune.

import crypto from "node:crypto";
import type { PoolClient } from "pg";

import { generateMetrologieImpactCode } from "../../../shared/codes/code-generator.service";
import { HttpError } from "../../../utils/httpError";

import {
  assertImpactClosureAllowed,
  assertImpactDecision,
  assertImpactTransition,
  assertOptimisticVersion,
  roleHasMetrologyCapability,
  type MetrologyImpactStatus,
} from "../domain/metrology-policy";
import {
  computeImpactWindow,
  describeTruncation,
  IMPACT_ITEM_HARD_LIMIT,
  suggestImpactPriority,
  type ImpactTrigger,
  type ImpactVolumes,
} from "../domain/metrology-impact";
import type {
  CreateImpactBodyDTO,
  DecideImpactItemBodyDTO,
  ListImpactItemsQueryDTO,
  ListImpactsQueryDTO,
  TransitionImpactBodyDTO,
  UsageQueryDTO,
} from "../validators/metrology-360.validators";
import type {
  MetrologyImpactDetailDTO,
  MetrologyImpactItemDTO,
  MetrologyImpactListItemDTO,
  MetrologyUsageEntryDTO,
  Paginated,
  UserRef,
} from "../types/metrology-360.types";
import {
  acquireIdempotency,
  db,
  insertAuditLog,
  insertMetrologyEvent,
  isRecord,
  rethrowMapped,
  saveReceipt,
  sortDirection,
  toInt,
  withTransaction,
  type MetrologyActor,
} from "./metrology-shared.repository";
import { mapImpactListRow } from "./metrology-registry.repository";

function mapUserRef(row: {
  id: number | null;
  username: string | null;
  name: string | null;
  surname: string | null;
}): UserRef | null {
  if (!row.id || !row.username) return null;
  const parts = [row.surname ?? "", row.name ?? ""].map((s) => s.trim()).filter(Boolean);
  return { id: row.id, username: row.username, label: parts.join(" ").trim() || row.username };
}

/* ========================================================================== */
/* Collecte bornée des usages                                                 */
/* ========================================================================== */

type UsageRow = {
  quality_control_id: string;
  control_reference: string | null;
  control_type: string | null;
  control_date: string | null;
  characteristic_key: string | null;
  of_id: string | null;
  lot_id: string | null;
  bon_livraison_id: string | null;
  article_id: string | null;
  affaire_id: string | null;
};

/**
 * Usages de l'instrument dans la fenêtre. La requête est BORNÉE (LIMIT dur) et
 * le total réel est compté à part : une troncature silencieuse se lirait comme
 * « tout est couvert » alors que non.
 *
 * On s'appuie sur `quality_control_points.instrument_id` (#228), la seule
 * référence fiable de l'instrument réellement utilisé sur une mesure.
 */
async function collectUsages(
  q: Pick<PoolClient, "query">,
  params: { equipementId: string; from: Date; to: Date; limit: number }
): Promise<{ rows: UsageRow[]; total: number }> {
  const countRes = await q.query<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM public.quality_control_points p
      JOIN public.quality_control c ON c.id = p.quality_control_id
      WHERE p.instrument_id = $1::uuid
        AND COALESCE(p.measured_at, c.control_date) >= $2::timestamptz
        AND COALESCE(p.measured_at, c.control_date) <= $3::timestamptz
    `,
    [params.equipementId, params.from.toISOString(), params.to.toISOString()]
  );

  const res = await q.query<UsageRow>(
    `
      SELECT
        c.id::text                 AS quality_control_id,
        c.reference                AS control_reference,
        c.control_type::text       AS control_type,
        COALESCE(p.measured_at, c.control_date)::text AS control_date,
        p.characteristic_key,
        c.of_id::text              AS of_id,
        c.lot_id::text             AS lot_id,
        c.bon_livraison_id::text   AS bon_livraison_id,
        c.article_id::text         AS article_id,
        c.affaire_id::text         AS affaire_id
      FROM public.quality_control_points p
      JOIN public.quality_control c ON c.id = p.quality_control_id
      WHERE p.instrument_id = $1::uuid
        AND COALESCE(p.measured_at, c.control_date) >= $2::timestamptz
        AND COALESCE(p.measured_at, c.control_date) <= $3::timestamptz
      ORDER BY COALESCE(p.measured_at, c.control_date) DESC, c.id, p.characteristic_key
      LIMIT $4
    `,
    [params.equipementId, params.from.toISOString(), params.to.toISOString(), params.limit]
  );

  return { rows: res.rows, total: toInt(countRes.rows[0]?.total, 0) };
}

function computeVolumes(rows: UsageRow[], total: number): ImpactVolumes {
  const controls = new Set(rows.map((row) => row.quality_control_id));
  const ofs = new Set(rows.map((row) => row.of_id).filter(Boolean));
  const lots = new Set(rows.map((row) => row.lot_id).filter(Boolean));
  const bls = new Set(rows.map((row) => row.bon_livraison_id).filter(Boolean));
  return {
    controls: controls.size,
    work_orders: ofs.size,
    lots: lots.size,
    deliveries: bls.size,
    truncated: total > rows.length,
  };
}

/* ========================================================================== */
/* Ouverture d'un dossier                                                     */
/* ========================================================================== */

export type OpenImpactParams = {
  equipementId: string;
  executionId: string | null;
  certificatId: string | null;
  trigger: ImpactTrigger;
  actor: MetrologyActor;
  correlationId: string;
  approvedWindow: { from: Date; to: Date; reason: string } | null;
  exclusions: string | null;
  ownerUserId: number | null;
};

/**
 * Ouverture idempotente : appelée depuis la transaction « hors tolérance », la
 * quarantaine manuelle ou l'invalidation de certificat. Un dossier déjà ouvert
 * pour la même exécution est réutilisé (index unique partiel côté base).
 */
export async function openImpactDossier(
  client: PoolClient,
  params: OpenImpactParams
): Promise<{ id: string; code: string; created: boolean; volumes: ImpactVolumes }> {
  if (params.executionId) {
    const existing = await client.query<{ id: string; code: string; volumes: unknown }>(
      `SELECT id::text AS id, code, volumes FROM public.metrologie_impact_dossier
        WHERE execution_id = $1::uuid AND status <> 'CANCELLED' LIMIT 1`,
      [params.executionId]
    );
    const row = existing.rows[0];
    if (row) {
      const volumes = isRecord(row.volumes) ? row.volumes : {};
      return {
        id: row.id,
        code: row.code,
        created: false,
        volumes: {
          controls: toInt(volumes.controls, 0),
          work_orders: toInt(volumes.work_orders, 0),
          lots: toInt(volumes.lots, 0),
          deliveries: toInt(volumes.deliveries, 0),
          truncated: volumes.truncated === true,
        },
      };
    }
  }

  const equipRes = await client.query<{
    created_at: string;
    criticite: string;
    last_conforme_at: string | null;
  }>(
    `SELECT created_at::text AS created_at, criticite, last_conforme_at::text AS last_conforme_at
       FROM public.metrologie_equipements WHERE id = $1::uuid`,
    [params.equipementId]
  );
  const equip = equipRes.rows[0] ?? null;
  if (!equip) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");

  const eventAtRes = params.executionId
    ? await client.query<{ ended_at: string | null }>(
        `SELECT COALESCE(ended_at, started_at)::text AS ended_at
           FROM public.metrologie_execution WHERE id = $1::uuid`,
        [params.executionId]
      )
    : null;

  const window = computeImpactWindow({
    trigger: params.trigger,
    eventAt: new Date(eventAtRes?.rows[0]?.ended_at ?? new Date().toISOString()),
    lastConformeProofAt: equip.last_conforme_at ? new Date(equip.last_conforme_at) : null,
    equipmentCreatedAt: new Date(equip.created_at),
    approvedFrom: params.approvedWindow?.from ?? null,
    approvedTo: params.approvedWindow?.to ?? null,
    approvedReason: params.approvedWindow?.reason ?? null,
  });

  const usages = await collectUsages(client, {
    equipementId: params.equipementId,
    from: window.from,
    to: window.to,
    limit: IMPACT_ITEM_HARD_LIMIT,
  });
  const volumes = computeVolumes(usages.rows, usages.total);
  const priority = suggestImpactPriority({ volumes, criticite: equip.criticite });
  const code = await generateMetrologieImpactCode(client, { date: window.to });

  const truncationNote = describeTruncation(usages.rows.length, usages.total);
  const method = truncationNote ? `${window.method} ${truncationNote}` : window.method;

  let dossierId: string;
  try {
    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.metrologie_impact_dossier (
          code, equipement_id, execution_id, certificat_id, trigger_type,
          status, priority, window_from, window_to, window_source,
          method, scope, exclusions, volumes, truncated, owner_user_id,
          correlation_id, created_by, updated_by
        )
        VALUES (
          $1,$2::uuid,$3::uuid,$4::uuid,$5,
          'OPEN',$6,$7::timestamptz,$8::timestamptz,$9,
          $10,$11::jsonb,$12,$13::jsonb,$14,$15,
          $16::uuid,$17,$17
        )
        RETURNING id::text AS id
      `,
      [
        code,
        params.equipementId,
        params.executionId,
        params.certificatId,
        params.trigger,
        priority,
        window.from.toISOString(),
        window.to.toISOString(),
        window.source,
        method,
        JSON.stringify({
          span_days: window.span_days,
          identified_usages: usages.total,
          materialized_usages: usages.rows.length,
          hard_limit: IMPACT_ITEM_HARD_LIMIT,
        }),
        params.exclusions,
        JSON.stringify(volumes),
        volumes.truncated,
        params.ownerUserId,
        params.correlationId,
        params.actor.user_id,
      ]
    );
    dossierId = ins.rows[0]?.id ?? "";
  } catch (err) {
    rethrowMapped(err);
  }
  if (!dossierId) throw new HttpError(500, "METROLOGY_IMPACT_CREATE_FAILED", "Ouverture du dossier impossible.");

  for (const row of usages.rows) {
    await client.query(
      `
        INSERT INTO public.metrologie_impact_item (
          dossier_id, quality_control_id, control_reference, control_type, control_date,
          characteristic_key, of_id, lot_id, bon_livraison_id, article_id, affaire_id
        )
        VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6,$7::bigint,$8::uuid,$9::uuid,$10::uuid,$11::bigint)
        ON CONFLICT (dossier_id, quality_control_id, characteristic_key) DO NOTHING
      `,
      [
        dossierId,
        row.quality_control_id,
        row.control_reference,
        row.control_type,
        row.control_date,
        row.characteristic_key,
        row.of_id,
        row.lot_id,
        row.bon_livraison_id,
        row.article_id,
        row.affaire_id,
      ]
    );
  }

  await insertMetrologyEvent(client, {
    equipement_id: params.equipementId,
    entity_type: "IMPACT",
    entity_id: dossierId,
    event_type: "IMPACT_DOSSIER_OPENED",
    actor: params.actor,
    old_values: null,
    new_values: {
      code,
      trigger: params.trigger,
      window_from: window.from.toISOString(),
      window_to: window.to.toISOString(),
      window_source: window.source,
      volumes,
      // Ce que le module n'a PAS fait, écrit noir sur blanc dans le journal.
      automatic_actions: "none",
    },
    correlation_id: params.correlationId,
    rule_code: "IMPACT_BOUNDED_WINDOW",
    reason: method,
  });
  await insertAuditLog(client, params.actor, {
    action: "metrologie.impacts.open",
    entity_type: "metrologie_impact_dossier",
    entity_id: dossierId,
    details: { code, equipement_id: params.equipementId, volumes, trigger: params.trigger },
  });

  return { id: dossierId, code, created: true, volumes };
}

/* ========================================================================== */
/* API publique                                                               */
/* ========================================================================== */

export async function repoCreateImpact(params: {
  equipementId: string;
  body: CreateImpactBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyImpactDetailDTO> {
  const { equipementId, body, actor } = params;
  const dossierId = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.impact.create",
      requestPayload: { equipementId, ...body },
    });
    if (claim.replay && typeof claim.replay.id === "string") return claim.replay.id;

    await client.query(
      `SELECT 1 FROM public.metrologie_equipements WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
      [equipementId]
    );

    const correlationId = crypto.randomUUID();
    const dossier = await openImpactDossier(client, {
      equipementId,
      executionId: body.execution_id ?? null,
      certificatId: body.certificat_id ?? null,
      trigger: body.trigger_type,
      actor,
      correlationId,
      approvedWindow:
        body.window_from && body.window_to
          ? {
              from: new Date(body.window_from),
              to: new Date(body.window_to),
              reason: body.window_reason ?? "",
            }
          : null,
      exclusions: body.exclusions,
      ownerUserId: body.owner_user_id,
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.impact.create",
      aggregateType: "IMPACT",
      aggregateId: dossier.id,
      requestPayload: { equipementId, ...body },
      resultPayload: { id: dossier.id, code: dossier.code },
      correlationId,
    });
    return dossier.id;
  });

  const detail = await repoGetImpact({
    id: dossierId,
    actor,
    itemsQuery: { page: 1, pageSize: 25, sortDir: "desc", sortBy: "control_date" },
  });
  if (!detail) throw new HttpError(500, "METROLOGY_IMPACT_RELOAD_FAILED", "Dossier introuvable après ouverture.");
  return detail;
}

const IMPACT_LIST_SELECT = `
  SELECT
    d.id::text AS id, d.code, d.equipement_id::text AS equipement_id,
    e.code AS equipement_code, e.designation AS equipement_designation,
    d.trigger_type, d.status, d.priority,
    d.window_from::text AS window_from, d.window_to::text AS window_to,
    d.volumes, d.truncated,
    d.created_at::text AS created_at, d.updated_at::text AS updated_at,
    (SELECT COUNT(*)::int FROM public.metrologie_impact_item i
      WHERE i.dossier_id = d.id AND i.decision = 'PENDING') AS pending_items
  FROM public.metrologie_impact_dossier d
  JOIN public.metrologie_equipements e ON e.id = d.equipement_id
`;

export async function repoListImpacts(
  query: ListImpactsQueryDTO
): Promise<Paginated<MetrologyImpactListItemDTO>> {
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (query.equipement_id) where.push(`d.equipement_id = ${push(query.equipement_id)}::uuid`);
  if (query.status) where.push(`d.status = ${push(query.status)}`);
  if (query.priority) where.push(`d.priority = ${push(query.priority)}`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM public.metrologie_impact_dossier d ${whereSql.replace(/\be\./g, "d.")}`,
    values
  );

  const sortColumn =
    query.sortBy === "priority"
      ? `CASE d.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END`
      : `d.${query.sortBy}`;

  const offset = (query.page - 1) * query.pageSize;
  const res = await db().query(
    `${IMPACT_LIST_SELECT} ${whereSql}
     ORDER BY ${sortColumn} ${sortDirection(query.sortDir)}, d.id DESC
     LIMIT ${push(query.pageSize)} OFFSET ${push(offset)}`,
    values
  );

  return {
    items: res.rows.map(mapImpactListRow),
    total: toInt(countRes.rows[0]?.total, 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function repoGetImpact(params: {
  id: string;
  actor: MetrologyActor;
  itemsQuery: ListImpactItemsQueryDTO;
}): Promise<MetrologyImpactDetailDTO | null> {
  const res = await db().query(
    `
      ${IMPACT_LIST_SELECT}
      , LATERAL (SELECT 1) noop
      WHERE d.id = $1::uuid
      LIMIT 1
    `.replace(", LATERAL (SELECT 1) noop", ""),
    [params.id]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  const extraRes = await db().query(
    `
      SELECT
        d.execution_id::text AS execution_id, d.certificat_id::text AS certificat_id,
        d.window_source, d.method, d.scope, d.exclusions, d.truncated,
        d.conclusion, d.closed_at::text AS closed_at,
        ou.id AS owner_id, ou.username AS owner_username, ou.name AS owner_name, ou.surname AS owner_surname
      FROM public.metrologie_impact_dossier d
      LEFT JOIN public.users ou ON ou.id = d.owner_user_id
      WHERE d.id = $1::uuid
    `,
    [params.id]
  );
  const extra = extraRes.rows[0] ?? {};

  const items = await repoListImpactItems({ dossierId: params.id, query: params.itemsQuery });

  return {
    ...mapImpactListRow(row),
    execution_id: (extra.execution_id ?? null) as string | null,
    certificat_id: (extra.certificat_id ?? null) as string | null,
    window_source: String(extra.window_source ?? "LAST_CONFORME_PROOF"),
    method: String(extra.method ?? ""),
    scope: isRecord(extra.scope) ? extra.scope : {},
    exclusions: (extra.exclusions ?? null) as string | null,
    truncated: extra.truncated === true,
    owner: mapUserRef({
      id: (extra.owner_id ?? null) as number | null,
      username: (extra.owner_username ?? null) as string | null,
      name: (extra.owner_name ?? null) as string | null,
      surname: (extra.owner_surname ?? null) as string | null,
    }),
    conclusion: (extra.conclusion ?? null) as string | null,
    closed_at: (extra.closed_at ?? null) as string | null,
    items,
    capabilities: {
      impact_decide: roleHasMetrologyCapability(params.actor.role, "impact_decide"),
      impact_create: roleHasMetrologyCapability(params.actor.role, "impact_create"),
    },
  };
}

export async function repoListImpactItems(params: {
  dossierId: string;
  query: ListImpactItemsQueryDTO;
}): Promise<Paginated<MetrologyImpactItemDTO>> {
  const values: unknown[] = [params.dossierId];
  const where: string[] = ["i.dossier_id = $1::uuid"];
  if (params.query.decision) {
    values.push(params.query.decision);
    where.push(`i.decision = $${values.length}`);
  }

  const countRes = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM public.metrologie_impact_item i WHERE ${where.join(" AND ")}`,
    values
  );

  const offset = (params.query.page - 1) * params.query.pageSize;
  values.push(params.query.pageSize, offset);
  const res = await db().query(
    `
      SELECT
        i.id::text AS id, i.quality_control_id::text AS quality_control_id,
        i.control_reference, i.control_type, i.control_date::text AS control_date,
        i.characteristic_key, i.of_id::text AS of_id, i.lot_id::text AS lot_id,
        i.bon_livraison_id::text AS bon_livraison_id, i.article_id::text AS article_id,
        i.affaire_id::text AS affaire_id,
        i.decision, i.decision_reason, i.decided_at::text AS decided_at,
        i.non_conformity_id::text AS non_conformity_id,
        du.id AS decided_by_id, du.username AS decided_by_username,
        du.name AS decided_by_name, du.surname AS decided_by_surname
      FROM public.metrologie_impact_item i
      LEFT JOIN public.users du ON du.id = i.decided_by
      WHERE ${where.join(" AND ")}
      ORDER BY i.${params.query.sortBy} ${sortDirection(params.query.sortDir)} NULLS LAST, i.id
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  );

  return {
    items: res.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      quality_control_id: (row.quality_control_id ?? null) as string | null,
      control_reference: (row.control_reference ?? null) as string | null,
      control_type: (row.control_type ?? null) as string | null,
      control_date: (row.control_date ?? null) as string | null,
      characteristic_key: (row.characteristic_key ?? null) as string | null,
      of_id: row.of_id === null || row.of_id === undefined ? null : Number(row.of_id),
      lot_id: (row.lot_id ?? null) as string | null,
      bon_livraison_id: (row.bon_livraison_id ?? null) as string | null,
      article_id: (row.article_id ?? null) as string | null,
      affaire_id:
        row.affaire_id === null || row.affaire_id === undefined ? null : Number(row.affaire_id),
      decision: row.decision as MetrologyImpactItemDTO["decision"],
      decision_reason: (row.decision_reason ?? null) as string | null,
      decided_by: mapUserRef({
        id: (row.decided_by_id ?? null) as number | null,
        username: (row.decided_by_username ?? null) as string | null,
        name: (row.decided_by_name ?? null) as string | null,
        surname: (row.decided_by_surname ?? null) as string | null,
      }),
      decided_at: (row.decided_at ?? null) as string | null,
      non_conformity_id: (row.non_conformity_id ?? null) as string | null,
    })),
    total: toInt(countRes.rows[0]?.total, 0),
    page: params.query.page,
    pageSize: params.query.pageSize,
  };
}

export async function repoDecideImpactItem(params: {
  dossierId: string;
  itemId: string;
  body: DecideImpactItemBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyImpactItemDTO> {
  const { dossierId, itemId, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.impact.decide",
      requestPayload: { dossierId, itemId, ...body },
    });
    if (claim.replay) return;

    assertImpactDecision({ decision: body.decision, reason: body.reason });

    const res = await client.query<{
      id: string;
      decision: string;
      equipement_id: string;
      dossier_status: MetrologyImpactStatus;
    }>(
      `
        SELECT i.id::text AS id, i.decision, d.equipement_id::text AS equipement_id,
               d.status AS dossier_status
        FROM public.metrologie_impact_item i
        JOIN public.metrologie_impact_dossier d ON d.id = i.dossier_id
        WHERE i.id = $1::uuid AND i.dossier_id = $2::uuid
        FOR UPDATE OF i
      `,
      [itemId, dossierId]
    );
    const current = res.rows[0] ?? null;
    if (!current) throw new HttpError(404, "NOT_FOUND", "Usage introuvable dans ce dossier.");
    if (current.dossier_status === "CLOSED" || current.dossier_status === "CANCELLED") {
      throw new HttpError(
        409,
        "METROLOGY_IMPACT_CLOSED",
        "Ce dossier d'impact est clos : aucune nouvelle décision n'y est enregistrée."
      );
    }
    if (current.decision !== "PENDING") {
      throw new HttpError(
        409,
        "METROLOGY_IMPACT_ALREADY_DECIDED",
        "Cet usage a déjà été décidé : la décision est définitive."
      );
    }

    await client.query(
      `
        UPDATE public.metrologie_impact_item
        SET decision = $2, decision_reason = $3, decided_by = $4, decided_at = now(),
            non_conformity_id = $5::uuid, updated_at = now()
        WHERE id = $1::uuid
      `,
      [itemId, body.decision, body.reason, actor.user_id, body.non_conformity_id ?? null]
    );

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: current.equipement_id,
      entity_type: "IMPACT",
      entity_id: dossierId,
      event_type: `IMPACT_ITEM_${body.decision}`,
      actor,
      old_values: { item_id: itemId, decision: "PENDING" },
      new_values: {
        item_id: itemId,
        decision: body.decision,
        non_conformity_id: body.non_conformity_id ?? null,
        // La décision est TRACÉE ici ; son exécution appartient au module
        // concerné (Qualité, Stock, ADV) et reste une action humaine.
        executed_by_this_module: false,
      },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.impacts.decide",
      entity_type: "metrologie_impact_item",
      entity_id: itemId,
      details: { dossier_id: dossierId, decision: body.decision },
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.impact.decide",
      aggregateType: "IMPACT",
      aggregateId: dossierId,
      requestPayload: { dossierId, itemId, ...body },
      resultPayload: { item_id: itemId, decision: body.decision },
      correlationId,
    });
  });

  const items = await repoListImpactItems({
    dossierId,
    query: { page: 1, pageSize: 200, sortDir: "desc", sortBy: "control_date" },
  });
  const item = items.items.find((entry) => entry.id === itemId);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Usage introuvable après décision.");
  return item;
}

export async function repoTransitionImpact(params: {
  id: string;
  body: TransitionImpactBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyImpactDetailDTO> {
  const { id, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.impact.transition",
      requestPayload: { id, ...body },
    });
    if (claim.replay) return;

    const res = await client.query<{
      id: string;
      status: MetrologyImpactStatus;
      equipement_id: string;
      updated_at: string;
    }>(
      `SELECT id::text AS id, status, equipement_id::text AS equipement_id,
              updated_at::text AS updated_at
         FROM public.metrologie_impact_dossier WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    const current = res.rows[0] ?? null;
    if (!current) throw new HttpError(404, "NOT_FOUND", "Dossier d'impact introuvable.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
    });
    assertImpactTransition(current.status, body.target_status);

    if (body.target_status === "CLOSED") {
      const pending = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM public.metrologie_impact_item
          WHERE dossier_id = $1::uuid AND decision = 'PENDING'`,
        [id]
      );
      assertImpactClosureAllowed({
        pendingItems: toInt(pending.rows[0]?.total, 0),
        conclusion: body.conclusion,
      });
      await client.query(
        `
          UPDATE public.metrologie_impact_dossier
          SET status = 'CLOSED', conclusion = $2, closed_at = now(), closed_by = $3,
              updated_at = now(), updated_by = $3
          WHERE id = $1::uuid
        `,
        [id, body.conclusion, actor.user_id]
      );
    } else {
      await client.query(
        `
          UPDATE public.metrologie_impact_dossier
          SET status = $2, updated_at = now(), updated_by = $3
          WHERE id = $1::uuid
        `,
        [id, body.target_status, actor.user_id]
      );
    }

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: current.equipement_id,
      entity_type: "IMPACT",
      entity_id: id,
      event_type: `IMPACT_DOSSIER_${body.target_status}`,
      actor,
      old_values: { status: current.status },
      new_values: { status: body.target_status },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.conclusion,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.impacts.transition",
      entity_type: "metrologie_impact_dossier",
      entity_id: id,
      details: { from: current.status, to: body.target_status },
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.impact.transition",
      aggregateType: "IMPACT",
      aggregateId: id,
      requestPayload: { id, ...body },
      resultPayload: { id, status: body.target_status },
      correlationId,
    });
  });

  const detail = await repoGetImpact({
    id,
    actor,
    itemsQuery: { page: 1, pageSize: 25, sortDir: "desc", sortBy: "control_date" },
  });
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Dossier d'impact introuvable.");
  return detail;
}

/* ========================================================================== */
/* Usages instrument → contrôles → OF / lots / BL                             */
/* ========================================================================== */

export async function repoInstrumentUsage(params: {
  equipementId: string;
  query: UsageQueryDTO;
}): Promise<Paginated<MetrologyUsageEntryDTO>> {
  const values: unknown[] = [params.equipementId];
  const where: string[] = ["p.instrument_id = $1::uuid"];
  if (params.query.from) {
    values.push(params.query.from);
    where.push(`COALESCE(p.measured_at, c.control_date) >= $${values.length}::timestamptz`);
  }
  if (params.query.to) {
    values.push(params.query.to);
    where.push(`COALESCE(p.measured_at, c.control_date) <= $${values.length}::timestamptz`);
  }

  const countRes = await db().query<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM public.quality_control_points p
      JOIN public.quality_control c ON c.id = p.quality_control_id
      WHERE ${where.join(" AND ")}
    `,
    values
  );

  const offset = (params.query.page - 1) * params.query.pageSize;
  values.push(params.query.pageSize, offset);
  const res = await db().query(
    `
      SELECT
        c.id::text AS quality_control_id, c.reference AS control_reference,
        c.control_type::text AS control_type,
        COALESCE(p.measured_at, c.control_date)::text AS control_date,
        p.characteristic_key, p.instrument_snapshot,
        c.of_id::text AS of_id, c.lot_id::text AS lot_id,
        c.bon_livraison_id::text AS bon_livraison_id, c.affaire_id::text AS affaire_id
      FROM public.quality_control_points p
      JOIN public.quality_control c ON c.id = p.quality_control_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(p.measured_at, c.control_date) ${sortDirection(params.query.sortDir)}
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  );

  return {
    items: res.rows.map((row: Record<string, unknown>) => ({
      quality_control_id: String(row.quality_control_id),
      control_reference: (row.control_reference ?? null) as string | null,
      control_type: (row.control_type ?? null) as string | null,
      control_date: (row.control_date ?? null) as string | null,
      characteristic_key: (row.characteristic_key ?? null) as string | null,
      of_id: row.of_id === null || row.of_id === undefined ? null : Number(row.of_id),
      lot_id: (row.lot_id ?? null) as string | null,
      bon_livraison_id: (row.bon_livraison_id ?? null) as string | null,
      affaire_id:
        row.affaire_id === null || row.affaire_id === undefined ? null : Number(row.affaire_id),
      snapshot: isRecord(row.instrument_snapshot)
        ? (row.instrument_snapshot as MetrologyUsageEntryDTO["snapshot"])
        : null,
    })),
    total: toInt(countRes.rows[0]?.total, 0),
    page: params.query.page,
    pageSize: params.query.pageSize,
  };
}
