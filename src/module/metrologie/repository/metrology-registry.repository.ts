// Registre Métrologie 360 (#229) : catégories, équipements, plans versionnés,
// échéances, éligibilité et command center.
//
// Toute écriture est transactionnelle, verrouillée (verrou optimiste +
// `FOR UPDATE`), idempotente lorsqu'elle a un effet, et tracée dans le même
// commit (journal métier + audit). Aucun code métier n'est calculé côté client.

import crypto from "node:crypto";
import type { PoolClient } from "pg";

import { generateMetrologieEquipementCode } from "../../../shared/codes/code-generator.service";
import { HttpError } from "../../../utils/httpError";

import {
  assertEquipmentReleaseAllowed,
  assertEquipmentTransition,
  assertOptimisticVersion,
  assertPlanContentMutable,
  assertPlanTransition,
  roleHasMetrologyCapability,
  transitionRequiresRelease,
  type MetrologyEquipmentState,
} from "../domain/metrology-policy";
import {
  buildInstrumentSnapshot,
  evaluateInstrumentEligibility,
  type MetrologyUsageRequirement,
} from "../domain/metrology-eligibility";
import {
  computeNextDueDate,
  deriveEffectiveState,
  evaluateDue,
  type DueEvaluation,
  type SchedulePlan,
} from "../domain/metrology-schedule";
import type {
  CreateEquipmentBodyDTO,
  CreatePlanBodyDTO,
  EligibilityQueryDTO,
  EquipmentTransitionBodyDTO,
  ListCategoriesQueryDTO,
  ListEquipmentQueryDTO,
  PlanTransitionBodyDTO,
  QuarantineBodyDTO,
  RevisePlanBodyDTO,
  SchedulePreviewQueryDTO,
  TimelineQueryDTO,
  UpdateEquipmentBodyDTO,
  UpsertCategoryBodyDTO,
} from "../validators/metrology-360.validators";
import type {
  MetrologyCategoryDTO,
  MetrologyCenterDTO,
  MetrologyDueDTO,
  MetrologyEligibilityResultDTO,
  MetrologyEquipmentDTO,
  MetrologyEquipmentDetailDTO,
  MetrologyEquipmentListItemDTO,
  MetrologyPlanVersionDTO,
  MetrologyTimelineEntryDTO,
  Paginated,
  UserRef,
} from "../types/metrology-360.types";
import {
  acquireIdempotency,
  db,
  insertAuditLog,
  insertMetrologyEvent,
  isRecord,
  loadInstrumentCandidates,
  loadInstrumentState,
  loadMetrologyPolicy,
  rethrowMapped,
  saveReceipt,
  sortDirection,
  toInt,
  toNumber,
  withTransaction,
  type DbQueryer,
  type MetrologyActor,
} from "./metrology-shared.repository";
import { openImpactDossier } from "./metrology-impact.repository";

/* ========================================================================== */
/* Mappers                                                                    */
/* ========================================================================== */

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

function mapDue(due: DueEvaluation): MetrologyDueDTO {
  return {
    status: due.status,
    next_due_date: due.next_due_date,
    days_remaining: due.days_remaining,
    days_overdue: due.days_overdue,
  };
}

function capabilitiesFor(role: string | null): Record<string, boolean> {
  return {
    read: roleHasMetrologyCapability(role, "read"),
    equipment_write: roleHasMetrologyCapability(role, "equipment_write"),
    plan_manage: roleHasMetrologyCapability(role, "plan_manage"),
    execution_record: roleHasMetrologyCapability(role, "execution_record"),
    verdict_validate: roleHasMetrologyCapability(role, "verdict_validate"),
    documents_read: roleHasMetrologyCapability(role, "documents_read"),
    documents_write: roleHasMetrologyCapability(role, "documents_write"),
    quarantine_set: roleHasMetrologyCapability(role, "quarantine_set"),
    repair_manage: roleHasMetrologyCapability(role, "repair_manage"),
    equipment_release: roleHasMetrologyCapability(role, "equipment_release"),
    impact_read: roleHasMetrologyCapability(role, "impact_read"),
    impact_create: roleHasMetrologyCapability(role, "impact_create"),
    impact_decide: roleHasMetrologyCapability(role, "impact_decide"),
    categories_manage: roleHasMetrologyCapability(role, "categories_manage"),
  };
}

/* ========================================================================== */
/* Catégories                                                                 */
/* ========================================================================== */

export async function repoListCategories(
  filters: ListCategoriesQueryDTO
): Promise<{ items: MetrologyCategoryDTO[] }> {
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.active === "true") where.push("c.active = TRUE");
  else if (filters.active === "false") where.push("c.active = FALSE");
  if (filters.q) {
    const p = push(`%${filters.q.replace(/%/g, "\\%")}%`);
    where.push(`(c.code ILIKE ${p} OR c.label ILIKE ${p})`);
  }

  const res = await db().query<
    MetrologyCategoryDTO & { in_use: boolean; default_periodicity_months: number | null }
  >(
    `
      SELECT
        c.code, c.parent_code, c.label, c.description, c.version, c.active, c.display_order,
        c.requires_range, c.requires_resolution, c.requires_uncertainty, c.requires_unit,
        c.default_unit, c.default_periodicity_months, c.default_operation_type,
        EXISTS (
          SELECT 1 FROM public.metrologie_equipements e
          WHERE e.categorie_code = c.code OR e.sous_categorie_code = c.code
        ) AS in_use
      FROM public.metrologie_categories c
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.display_order ASC, c.label ASC
      LIMIT 500
    `,
    values
  );
  return { items: res.rows };
}

export async function repoUpsertCategory(params: {
  body: UpsertCategoryBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyCategoryDTO> {
  const { body, actor } = params;
  return withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.category.upsert",
      requestPayload: body,
    });
    if (claim.replay) return claim.replay as unknown as MetrologyCategoryDTO;

    const before = await client.query<{ code: string; active: boolean; label: string }>(
      `SELECT code, active, label FROM public.metrologie_categories WHERE code = $1 FOR UPDATE`,
      [body.code]
    );
    const existing = before.rows[0] ?? null;

    // Une catégorie utilisée ne se supprime pas : on la désactive. Le trigger
    // le garantit côté base, l'API le rend explicite côté message.
    if (existing && !body.active) {
      const used = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM public.metrologie_equipements
          WHERE (categorie_code = $1 OR sous_categorie_code = $1) AND deleted_at IS NULL`,
        [body.code]
      );
      const total = toInt(used.rows[0]?.total, 0);
      if (total > 0) {
        // Désactivation autorisée : elle empêche les NOUVEAUX usages sans
        // toucher aux équipements déjà rattachés.
        await insertMetrologyEvent(client, {
          equipement_id: null,
          entity_type: "CATEGORIE",
          entity_id: body.code,
          event_type: "CATEGORIE_DEACTIVATED_WHILE_USED",
          actor,
          old_values: { active: true },
          new_values: { active: false, equipements_rattaches: total },
          correlation_id: crypto.randomUUID(),
          reason: "Désactivation d'une catégorie encore rattachée à des équipements.",
        });
      }
    }

    try {
      await client.query(
        `
          INSERT INTO public.metrologie_categories (
            code, parent_code, label, description, active, display_order,
            requires_range, requires_resolution, requires_uncertainty, requires_unit,
            default_unit, default_periodicity_months, default_operation_type,
            created_by, updated_by
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
          ON CONFLICT (code) DO UPDATE SET
            parent_code = EXCLUDED.parent_code,
            label = EXCLUDED.label,
            description = EXCLUDED.description,
            active = EXCLUDED.active,
            display_order = EXCLUDED.display_order,
            requires_range = EXCLUDED.requires_range,
            requires_resolution = EXCLUDED.requires_resolution,
            requires_uncertainty = EXCLUDED.requires_uncertainty,
            requires_unit = EXCLUDED.requires_unit,
            default_unit = EXCLUDED.default_unit,
            default_periodicity_months = EXCLUDED.default_periodicity_months,
            default_operation_type = EXCLUDED.default_operation_type,
            version = public.metrologie_categories.version + 1,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
        `,
        [
          body.code,
          body.parent_code,
          body.label,
          body.description,
          body.active,
          body.display_order,
          body.requires_range,
          body.requires_resolution,
          body.requires_uncertainty,
          body.requires_unit,
          body.default_unit,
          body.default_periodicity_months,
          body.default_operation_type,
          actor.user_id,
        ]
      );
    } catch (err) {
      rethrowMapped(err);
    }

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: null,
      entity_type: "CATEGORIE",
      entity_id: body.code,
      event_type: existing ? "CATEGORIE_UPDATED" : "CATEGORIE_CREATED",
      actor,
      old_values: existing ? { label: existing.label, active: existing.active } : null,
      new_values: { label: body.label, active: body.active },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
    });
    await insertAuditLog(client, actor, {
      action: existing ? "metrologie.categories.update" : "metrologie.categories.create",
      entity_type: "metrologie_categories",
      entity_id: body.code,
      details: { label: body.label, active: body.active },
    });

    const reloaded = await client.query<MetrologyCategoryDTO>(
      `
        SELECT
          c.code, c.parent_code, c.label, c.description, c.version, c.active, c.display_order,
          c.requires_range, c.requires_resolution, c.requires_uncertainty, c.requires_unit,
          c.default_unit, c.default_periodicity_months, c.default_operation_type,
          EXISTS (
            SELECT 1 FROM public.metrologie_equipements e
            WHERE e.categorie_code = c.code OR e.sous_categorie_code = c.code
          ) AS in_use
        FROM public.metrologie_categories c
        WHERE c.code = $1
      `,
      [body.code]
    );
    const out = reloaded.rows[0];
    if (!out) throw new HttpError(500, "METROLOGY_CATEGORY_RELOAD_FAILED", "Catégorie introuvable après écriture.");

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.category.upsert",
      aggregateType: "CATEGORIE",
      aggregateId: body.code,
      requestPayload: body,
      resultPayload: out,
      correlationId,
    });
    return out;
  });
}

/* ========================================================================== */
/* Équipements — lecture                                                      */
/* ========================================================================== */

const EQUIPMENT_LIST_SELECT = `
  SELECT
    e.id::text                                  AS id,
    e.code,
    e.designation,
    e.categorie_code,
    cat.label                                   AS categorie_label,
    e.etat,
    e.criticite,
    e.site,
    e.zone,
    e.localisation_precise,
    e.numero_serie,
    COALESCE(pv.next_due_date, legacy.next_due_date)::text AS next_due_date,
    COALESCE(pv.alert_window_days, 30)          AS alert_window_days,
    e.updated_at::text                          AS updated_at,
    COALESCE(imp.open_count, 0)                 AS open_impact_count
  FROM public.metrologie_equipements e
  LEFT JOIN public.metrologie_categories cat ON cat.code = e.categorie_code
  LEFT JOIN LATERAL (
    SELECT p.next_due_date, p.alert_window_days
    FROM public.metrologie_plan_version p
    WHERE p.equipement_id = e.id AND p.status = 'ACTIVE'
    ORDER BY p.next_due_date ASC NULLS LAST, p.version DESC
    LIMIT 1
  ) pv ON TRUE
  LEFT JOIN LATERAL (
    SELECT lp.next_due_date
    FROM public.metrologie_plan lp
    WHERE lp.equipement_id = e.id AND lp.deleted_at IS NULL AND lp.statut <> 'SUSPENDU'
    ORDER BY lp.created_at DESC
    LIMIT 1
  ) legacy ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS open_count
    FROM public.metrologie_impact_dossier d
    WHERE d.equipement_id = e.id AND d.status IN ('OPEN', 'IN_REVIEW')
  ) imp ON TRUE
`;

type EquipmentListRow = {
  id: string;
  code: string | null;
  designation: string;
  categorie_code: string | null;
  categorie_label: string | null;
  etat: MetrologyEquipmentState;
  criticite: "NORMAL" | "CRITIQUE";
  site: string | null;
  zone: string | null;
  localisation_precise: string | null;
  numero_serie: string | null;
  next_due_date: string | null;
  alert_window_days: number;
  updated_at: string;
  open_impact_count: number;
};

function mapEquipmentListItem(row: EquipmentListRow, at: Date): MetrologyEquipmentListItemDTO {
  const due = evaluateDue({
    nextDueDate: row.next_due_date ? row.next_due_date.slice(0, 10) : null,
    alertWindowDays: row.alert_window_days,
    at,
  });
  return {
    id: row.id,
    code: row.code,
    designation: row.designation,
    categorie_code: row.categorie_code,
    categorie_label: row.categorie_label,
    etat: row.etat,
    etat_effectif: deriveEffectiveState({ storedState: row.etat, due }),
    criticite: row.criticite,
    site: row.site,
    zone: row.zone,
    localisation_precise: row.localisation_precise,
    numero_serie: row.numero_serie,
    next_due_date: due.next_due_date,
    due_status: due.status,
    days_overdue: due.days_overdue,
    days_remaining: due.days_remaining,
    open_impact_count: toInt(row.open_impact_count, 0),
    updated_at: row.updated_at,
  };
}

/**
 * Les segments du command center sont des filtres SERVEUR. `due_soon` et
 * `overdue` sont calculés en SQL sur la même règle que le domaine : la page
 * courante n'est jamais re-triée côté navigateur.
 */
function segmentClause(segment: ListEquipmentQueryDTO["segment"]): string | null {
  switch (segment) {
    case "due_soon":
      return `(e.etat IN ('ACTIVE','QUALIFIED')
               AND COALESCE(pv.next_due_date, legacy.next_due_date) IS NOT NULL
               AND COALESCE(pv.next_due_date, legacy.next_due_date) >= CURRENT_DATE
               AND COALESCE(pv.next_due_date, legacy.next_due_date)
                   <= CURRENT_DATE + (COALESCE(pv.alert_window_days, 30) || ' days')::interval)`;
    case "overdue":
      return `(e.etat IN ('ACTIVE','QUALIFIED')
               AND COALESCE(pv.next_due_date, legacy.next_due_date) IS NOT NULL
               AND COALESCE(pv.next_due_date, legacy.next_due_date) < CURRENT_DATE)`;
    case "quarantine":
      return `e.etat = 'QUARANTINE'`;
    case "out_of_tolerance":
      return `e.etat = 'OUT_OF_TOLERANCE'`;
    case "repair":
      return `e.etat = 'UNDER_REPAIR'`;
    case "retired":
      return `e.etat = 'RETIRED'`;
    case "all":
    default:
      return null;
  }
}

function equipmentSortColumn(sortBy: ListEquipmentQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "code":
      return "e.code";
    case "designation":
      return "e.designation";
    case "created_at":
      return "e.created_at";
    case "etat":
      return "e.etat";
    case "next_due_date":
      return "COALESCE(pv.next_due_date, legacy.next_due_date)";
    case "updated_at":
    default:
      return "e.updated_at";
  }
}

export async function repoListEquipment(
  filters: ListEquipmentQueryDTO
): Promise<Paginated<MetrologyEquipmentListItemDTO>> {
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const where: string[] = ["e.deleted_at IS NULL"];
  if (filters.q) {
    const p = push(`%${filters.q.replace(/%/g, "\\%")}%`);
    where.push(
      `(COALESCE(e.code,'') ILIKE ${p}
        OR e.designation ILIKE ${p}
        OR COALESCE(e.numero_serie,'') ILIKE ${p}
        OR COALESCE(e.modele,'') ILIKE ${p}
        OR COALESCE(e.localisation_precise,'') ILIKE ${p}
        OR COALESCE(e.zone,'') ILIKE ${p})`
    );
  }
  if (filters.categorie_code) where.push(`e.categorie_code = ${push(filters.categorie_code)}`);
  if (filters.etat) where.push(`e.etat = ${push(filters.etat)}`);
  if (filters.criticite) where.push(`e.criticite = ${push(filters.criticite)}`);
  if (filters.site) where.push(`e.site = ${push(filters.site)}`);

  const segment = segmentClause(filters.segment);
  if (segment) where.push(segment);

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const offset = (filters.page - 1) * filters.pageSize;

  const countRes = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM (${EQUIPMENT_LIST_SELECT} ${whereSql}) s`,
    values
  );
  const total = toInt(countRes.rows[0]?.total, 0);

  const dataRes = await db().query<EquipmentListRow>(
    `${EQUIPMENT_LIST_SELECT} ${whereSql}
     ORDER BY ${equipmentSortColumn(filters.sortBy)} ${sortDirection(filters.sortDir)} NULLS LAST, e.id ASC
     LIMIT ${push(filters.pageSize)} OFFSET ${push(offset)}`,
    values
  );

  const at = new Date();
  return {
    items: dataRes.rows.map((row) => mapEquipmentListItem(row, at)),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

type EquipmentRow = {
  id: string;
  code: string | null;
  designation: string;
  categorie_code: string | null;
  categorie_label: string | null;
  sous_categorie_code: string | null;
  marque: string | null;
  modele: string | null;
  numero_serie: string | null;
  criticite: "NORMAL" | "CRITIQUE";
  etat: MetrologyEquipmentState;
  etat_motif: string | null;
  etat_changed_at: string | null;
  statut: string;
  proprietaire_service: string | null;
  site: string | null;
  magasin: string | null;
  zone: string | null;
  localisation_precise: string | null;
  date_mise_en_service: string | null;
  date_retrait: string | null;
  unite: string | null;
  plage_min: string | null;
  plage_max: string | null;
  resolution: string | null;
  mpe: string | null;
  incertitude: string | null;
  methodes: string[] | null;
  conditions_utilisation: string | null;
  restrictions: string | null;
  etalon_reference: string | null;
  exige_certificat: boolean;
  specifications: unknown;
  quarantine_reason: string | null;
  quarantined_at: string | null;
  last_conforme_at: string | null;
  last_conforme_execution_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  responsable_id: number | null;
  responsable_username: string | null;
  responsable_name: string | null;
  responsable_surname: string | null;
  created_by_id: number | null;
  created_by_username: string | null;
  created_by_name: string | null;
  created_by_surname: string | null;
  updated_by_id: number | null;
  updated_by_username: string | null;
  updated_by_name: string | null;
  updated_by_surname: string | null;
};

const EQUIPMENT_DETAIL_SELECT = `
  SELECT
    e.id::text AS id, e.code, e.designation, e.categorie_code, cat.label AS categorie_label,
    e.sous_categorie_code, e.marque, e.modele, e.numero_serie, e.criticite,
    e.etat, e.etat_motif, e.etat_changed_at::text AS etat_changed_at, e.statut,
    e.proprietaire_service, e.site, e.magasin, e.zone, e.localisation_precise,
    e.date_mise_en_service::text AS date_mise_en_service,
    e.date_retrait::text AS date_retrait,
    e.unite, e.plage_min::text AS plage_min, e.plage_max::text AS plage_max,
    e.resolution::text AS resolution, e.mpe::text AS mpe, e.incertitude::text AS incertitude,
    e.methodes, e.conditions_utilisation, e.restrictions, e.etalon_reference,
    e.exige_certificat, e.specifications,
    e.quarantine_reason, e.quarantined_at::text AS quarantined_at,
    e.last_conforme_at::text AS last_conforme_at,
    e.last_conforme_execution_id::text AS last_conforme_execution_id,
    e.notes, e.created_at::text AS created_at, e.updated_at::text AS updated_at,
    ru.id AS responsable_id, ru.username AS responsable_username,
    ru.name AS responsable_name, ru.surname AS responsable_surname,
    cb.id AS created_by_id, cb.username AS created_by_username,
    cb.name AS created_by_name, cb.surname AS created_by_surname,
    ub.id AS updated_by_id, ub.username AS updated_by_username,
    ub.name AS updated_by_name, ub.surname AS updated_by_surname
  FROM public.metrologie_equipements e
  LEFT JOIN public.metrologie_categories cat ON cat.code = e.categorie_code
  LEFT JOIN public.users ru ON ru.id = e.responsable_user_id
  LEFT JOIN public.users cb ON cb.id = e.created_by
  LEFT JOIN public.users ub ON ub.id = e.updated_by
`;

function mapEquipment(row: EquipmentRow, due: DueEvaluation): MetrologyEquipmentDTO {
  return {
    id: row.id,
    code: row.code,
    designation: row.designation,
    categorie_code: row.categorie_code,
    categorie_label: row.categorie_label,
    sous_categorie_code: row.sous_categorie_code,
    marque: row.marque,
    modele: row.modele,
    numero_serie: row.numero_serie,
    criticite: row.criticite,
    etat: row.etat,
    etat_effectif: deriveEffectiveState({ storedState: row.etat, due }),
    etat_motif: row.etat_motif,
    etat_changed_at: row.etat_changed_at,
    statut_legacy: row.statut,
    proprietaire_service: row.proprietaire_service,
    responsable: mapUserRef({
      id: row.responsable_id,
      username: row.responsable_username,
      name: row.responsable_name,
      surname: row.responsable_surname,
    }),
    site: row.site,
    magasin: row.magasin,
    zone: row.zone,
    localisation_precise: row.localisation_precise,
    date_mise_en_service: row.date_mise_en_service,
    date_retrait: row.date_retrait,
    unite: row.unite,
    plage_min: toNumber(row.plage_min),
    plage_max: toNumber(row.plage_max),
    resolution: toNumber(row.resolution),
    mpe: toNumber(row.mpe),
    incertitude: toNumber(row.incertitude),
    methodes: row.methodes ?? [],
    conditions_utilisation: row.conditions_utilisation,
    restrictions: row.restrictions,
    etalon_reference: row.etalon_reference,
    exige_certificat: row.exige_certificat === true,
    specifications: isRecord(row.specifications) ? row.specifications : {},
    quarantine_reason: row.quarantine_reason,
    quarantined_at: row.quarantined_at,
    last_conforme_at: row.last_conforme_at,
    last_conforme_execution_id: row.last_conforme_execution_id,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: mapUserRef({
      id: row.created_by_id,
      username: row.created_by_username,
      name: row.created_by_name,
      surname: row.created_by_surname,
    }),
    updated_by: mapUserRef({
      id: row.updated_by_id,
      username: row.updated_by_username,
      name: row.updated_by_name,
      surname: row.updated_by_surname,
    }),
  };
}

type PlanRow = {
  id: string;
  equipement_id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  operation_type: "ETALONNAGE" | "VERIFICATION";
  methode: string | null;
  procedure_ref: string | null;
  periodicite_valeur: number;
  periodicite_unite: "DAY" | "WEEK" | "MONTH" | "YEAR";
  base_calcul: "LAST_PROOF" | "FIXED_DATE";
  alert_window_days: number;
  criteres: unknown;
  tolerance_min: string | null;
  tolerance_max: string | null;
  unite: string | null;
  prestataire_type: "INTERNE" | "EXTERNE";
  prestataire_label: string | null;
  fournisseur_id: string | null;
  role_habilite: string | null;
  criticite: "NORMAL" | "CRITIQUE";
  blocking_strategy: "BLOCK" | "WARN" | "NONE";
  exige_certificat: boolean;
  effective_from: string | null;
  last_proof_date: string | null;
  last_proof_execution_id: string | null;
  next_due_date: string | null;
  notes: string | null;
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapPlan(row: PlanRow, at: Date): MetrologyPlanVersionDTO {
  const criteres = isRecord(row.criteres) ? row.criteres : {};
  const due = evaluateDue({
    nextDueDate: row.next_due_date ? row.next_due_date.slice(0, 10) : null,
    alertWindowDays: row.alert_window_days,
    at,
  });
  return {
    id: row.id,
    equipement_id: row.equipement_id,
    version: row.version,
    status: row.status,
    operation_type: row.operation_type,
    methode: row.methode,
    procedure_ref: row.procedure_ref,
    periodicite_valeur: row.periodicite_valeur,
    periodicite_unite: row.periodicite_unite,
    base_calcul: row.base_calcul,
    alert_window_days: row.alert_window_days,
    tolerance_min: toNumber(row.tolerance_min),
    tolerance_max: toNumber(row.tolerance_max),
    unite: row.unite,
    min_points: toNumber(criteres.min_points),
    prestataire_type: row.prestataire_type,
    prestataire_label: row.prestataire_label,
    fournisseur_id: row.fournisseur_id,
    role_habilite: row.role_habilite,
    criticite: row.criticite,
    blocking_strategy: row.blocking_strategy,
    exige_certificat: row.exige_certificat === true,
    effective_from: row.effective_from,
    last_proof_date: row.last_proof_date,
    last_proof_execution_id: row.last_proof_execution_id,
    next_due_date: row.next_due_date,
    due: mapDue(due),
    notes: row.notes,
    published_at: row.published_at,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const PLAN_SELECT = `
  SELECT
    p.id::text AS id, p.equipement_id::text AS equipement_id, p.version, p.status,
    p.operation_type, p.methode, p.procedure_ref,
    p.periodicite_valeur, p.periodicite_unite, p.base_calcul, p.alert_window_days,
    p.criteres, p.tolerance_min::text AS tolerance_min, p.tolerance_max::text AS tolerance_max,
    p.unite, p.prestataire_type, p.prestataire_label, p.fournisseur_id::text AS fournisseur_id,
    p.role_habilite, p.criticite, p.blocking_strategy, p.exige_certificat,
    p.effective_from::text AS effective_from,
    p.last_proof_date::text AS last_proof_date,
    p.last_proof_execution_id::text AS last_proof_execution_id,
    p.next_due_date::text AS next_due_date,
    p.notes, p.published_at::text AS published_at, p.archived_at::text AS archived_at,
    p.created_at::text AS created_at, p.updated_at::text AS updated_at
  FROM public.metrologie_plan_version p
`;

export async function repoGetEquipmentDetail(params: {
  id: string;
  actor: MetrologyActor;
}): Promise<MetrologyEquipmentDetailDTO | null> {
  const coreRes = await db().query<EquipmentRow>(
    `${EQUIPMENT_DETAIL_SELECT} WHERE e.id = $1::uuid AND e.deleted_at IS NULL LIMIT 1`,
    [params.id]
  );
  const core = coreRes.rows[0] ?? null;
  if (!core) return null;

  const at = new Date();
  const plansRes = await db().query<PlanRow>(
    `${PLAN_SELECT} WHERE p.equipement_id = $1::uuid ORDER BY p.operation_type ASC, p.version DESC`,
    [params.id]
  );
  const plans = plansRes.rows.map((row) => mapPlan(row, at));

  const activePlan = plans
    .filter((plan) => plan.status === "ACTIVE")
    .sort((left, right) => compareNullableDate(left.next_due_date, right.next_due_date))[0];

  const instrument = await loadInstrumentState(db(), params.id);
  const due = evaluateDue({
    nextDueDate: instrument?.next_due_date ?? activePlan?.next_due_date ?? null,
    alertWindowDays: activePlan?.alert_window_days ?? 30,
    at,
  });

  const [executions, certificats, impacts] = await Promise.all([
    listRecentExecutions(params.id),
    listCertificates(params.id),
    listRecentImpacts(params.id),
  ]);

  return {
    equipement: mapEquipment(core, due),
    due: mapDue(due),
    plans,
    executions,
    certificats,
    impacts,
    capabilities: capabilitiesFor(params.actor.role),
  };
}

function compareNullableDate(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

async function listRecentExecutions(
  equipementId: string
): Promise<MetrologyEquipmentDetailDTO["executions"]> {
  const res = await db().query(
    `
      SELECT
        x.id::text AS id, x.code, x.equipement_id::text AS equipement_id,
        x.operation_type, x.status, x.verdict,
        x.started_at::text AS started_at, x.ended_at::text AS ended_at,
        x.provider_label, x.next_due_date::text AS next_due_date,
        x.updated_at::text AS updated_at,
        ou.id AS operator_id, ou.username AS operator_username,
        ou.name AS operator_name, ou.surname AS operator_surname,
        (SELECT COUNT(*)::int FROM public.metrologie_certificats c
          WHERE c.execution_id = x.id AND c.deleted_at IS NULL) AS certificate_count
      FROM public.metrologie_execution x
      LEFT JOIN public.users ou ON ou.id = x.operator_user_id
      WHERE x.equipement_id = $1::uuid
      ORDER BY x.started_at DESC, x.id DESC
      LIMIT 50
    `,
    [equipementId]
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    code: String(row.code),
    equipement_id: String(row.equipement_id),
    operation_type: row.operation_type as MetrologyEquipmentDetailDTO["executions"][number]["operation_type"],
    status: row.status as MetrologyEquipmentDetailDTO["executions"][number]["status"],
    verdict: (row.verdict ?? null) as MetrologyEquipmentDetailDTO["executions"][number]["verdict"],
    started_at: String(row.started_at),
    ended_at: (row.ended_at ?? null) as string | null,
    operator: mapUserRef({
      id: (row.operator_id ?? null) as number | null,
      username: (row.operator_username ?? null) as string | null,
      name: (row.operator_name ?? null) as string | null,
      surname: (row.operator_surname ?? null) as string | null,
    }),
    provider_label: (row.provider_label ?? null) as string | null,
    next_due_date: (row.next_due_date ?? null) as string | null,
    certificate_count: toInt(row.certificate_count, 0),
    updated_at: String(row.updated_at),
  }));
}

async function listCertificates(
  equipementId: string
): Promise<MetrologyEquipmentDetailDTO["certificats"]> {
  const res = await db().query(
    `
      SELECT
        c.id::text AS id, c.equipement_id::text AS equipement_id,
        c.execution_id::text AS execution_id, c.document_kind,
        c.date_etalonnage::text AS date_etalonnage, c.date_echeance::text AS date_echeance,
        c.resultat, c.statut, c.emetteur, c.numero_externe, c.organisme, c.commentaire,
        c.confidentiality, c.cancel_reason, c.cancelled_at::text AS cancelled_at,
        c.replaced_by_id::text AS replaced_by_id,
        c.file_original_name, c.mime_type, c.size_bytes::text AS size_bytes, c.sha256,
        (c.storage_path IS NOT NULL) AS has_file,
        c.created_at::text AS created_at,
        cb.id AS created_by_id, cb.username AS created_by_username,
        cb.name AS created_by_name, cb.surname AS created_by_surname
      FROM public.metrologie_certificats c
      LEFT JOIN public.users cb ON cb.id = c.created_by
      WHERE c.equipement_id = $1::uuid AND c.deleted_at IS NULL
      ORDER BY c.date_etalonnage DESC, c.created_at DESC
      LIMIT 100
    `,
    [equipementId]
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    equipement_id: String(row.equipement_id),
    execution_id: (row.execution_id ?? null) as string | null,
    document_kind: row.document_kind as MetrologyEquipmentDetailDTO["certificats"][number]["document_kind"],
    date_etalonnage: String(row.date_etalonnage),
    date_echeance: (row.date_echeance ?? null) as string | null,
    resultat: row.resultat as MetrologyEquipmentDetailDTO["certificats"][number]["resultat"],
    statut: row.statut as MetrologyEquipmentDetailDTO["certificats"][number]["statut"],
    emetteur: (row.emetteur ?? null) as string | null,
    numero_externe: (row.numero_externe ?? null) as string | null,
    organisme: (row.organisme ?? null) as string | null,
    commentaire: (row.commentaire ?? null) as string | null,
    confidentiality:
      row.confidentiality as MetrologyEquipmentDetailDTO["certificats"][number]["confidentiality"],
    cancel_reason: (row.cancel_reason ?? null) as string | null,
    cancelled_at: (row.cancelled_at ?? null) as string | null,
    replaced_by_id: (row.replaced_by_id ?? null) as string | null,
    file_original_name: (row.file_original_name ?? null) as string | null,
    mime_type: (row.mime_type ?? null) as string | null,
    size_bytes: toNumber(row.size_bytes),
    sha256: (row.sha256 ?? null) as string | null,
    has_file: row.has_file === true,
    created_at: String(row.created_at),
    created_by: mapUserRef({
      id: (row.created_by_id ?? null) as number | null,
      username: (row.created_by_username ?? null) as string | null,
      name: (row.created_by_name ?? null) as string | null,
      surname: (row.created_by_surname ?? null) as string | null,
    }),
  }));
}

async function listRecentImpacts(
  equipementId: string
): Promise<MetrologyEquipmentDetailDTO["impacts"]> {
  const res = await db().query(
    `
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
      WHERE d.equipement_id = $1::uuid
      ORDER BY d.created_at DESC
      LIMIT 20
    `,
    [equipementId]
  );
  return res.rows.map(mapImpactListRow);
}

export function mapImpactListRow(
  row: Record<string, unknown>
): MetrologyEquipmentDetailDTO["impacts"][number] {
  const volumes = isRecord(row.volumes) ? row.volumes : {};
  return {
    id: String(row.id),
    code: String(row.code),
    equipement_id: String(row.equipement_id),
    equipement_code: (row.equipement_code ?? null) as string | null,
    equipement_designation: (row.equipement_designation ?? null) as string | null,
    trigger_type: row.trigger_type as "VERDICT_NON_CONFORME" | "CERTIFICAT_INVALIDE" | "MANUEL",
    status: row.status as MetrologyEquipmentDetailDTO["impacts"][number]["status"],
    priority: row.priority as "LOW" | "NORMAL" | "HIGH" | "CRITICAL",
    window_from: String(row.window_from),
    window_to: String(row.window_to),
    volumes: {
      controls: toInt(volumes.controls, 0),
      work_orders: toInt(volumes.work_orders, 0),
      lots: toInt(volumes.lots, 0),
      deliveries: toInt(volumes.deliveries, 0),
      truncated: row.truncated === true,
    },
    pending_items: toInt(row.pending_items, 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/* ========================================================================== */
/* Équipements — écriture                                                     */
/* ========================================================================== */

type EquipmentLock = {
  id: string;
  code: string | null;
  etat: MetrologyEquipmentState;
  updated_at: string;
  created_at: string;
  criticite: string;
  designation: string;
};

async function lockEquipment(client: PoolClient, id: string): Promise<EquipmentLock> {
  const res = await client.query<EquipmentLock>(
    `
      SELECT id::text AS id, code, etat, criticite, designation,
             updated_at::text AS updated_at, created_at::text AS created_at
      FROM public.metrologie_equipements
      WHERE id = $1::uuid AND deleted_at IS NULL
      FOR UPDATE
    `,
    [id]
  );
  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(404, "NOT_FOUND", "Équipement de métrologie introuvable.");
  return row;
}

async function assertCategoryUsable(
  q: DbQueryer,
  code: string,
  field: string
): Promise<{
  requires_range: boolean;
  requires_resolution: boolean;
  requires_uncertainty: boolean;
  requires_unit: boolean;
}> {
  const res = await q.query<{
    active: boolean;
    requires_range: boolean;
    requires_resolution: boolean;
    requires_uncertainty: boolean;
    requires_unit: boolean;
  }>(
    `SELECT active, requires_range, requires_resolution, requires_uncertainty, requires_unit
       FROM public.metrologie_categories WHERE code = $1`,
    [code]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(422, "METROLOGY_CATEGORY_UNKNOWN", "Catégorie d'équipement inconnue.", {
      fields: { [field]: ["Catégorie inconnue."] },
    });
  }
  if (!row.active) {
    throw new HttpError(422, "METROLOGY_CATEGORY_INACTIVE", "Cette catégorie est désactivée.", {
      fields: { [field]: ["Catégorie désactivée : choisissez une catégorie active."] },
    });
  }
  return row;
}

/**
 * Les exigences déclarées par la catégorie sont vérifiées SERVEUR : une MMT sans
 * plage ni unité n'est pas un enregistrement valide, quoi qu'affiche l'UI.
 */
function assertSpecificationsMatchCategory(
  requirements: {
    requires_range: boolean;
    requires_resolution: boolean;
    requires_uncertainty: boolean;
    requires_unit: boolean;
  },
  body: CreateEquipmentBodyDTO | UpdateEquipmentBodyDTO
): void {
  const fields: Record<string, string[]> = {};
  if (requirements.requires_unit && !body.unite) {
    fields.unite = ["Cette catégorie exige une unité normalisée."];
  }
  if (requirements.requires_range && (body.plage_min === null || body.plage_max === null)) {
    if (body.plage_min === null) fields.plage_min = ["Cette catégorie exige une plage de mesure."];
    if (body.plage_max === null) fields.plage_max = ["Cette catégorie exige une plage de mesure."];
  }
  if (requirements.requires_resolution && body.resolution === null) {
    fields.resolution = ["Cette catégorie exige une résolution."];
  }
  if (requirements.requires_uncertainty && body.incertitude === null && body.mpe === null) {
    fields.incertitude = ["Cette catégorie exige une incertitude ou une EMT."];
  }
  if (Object.keys(fields).length > 0) {
    throw new HttpError(
      422,
      "METROLOGY_SPECIFICATIONS_INCOMPLETE",
      "Spécifications incomplètes pour cette catégorie.",
      { fields }
    );
  }
}

export async function repoCreateEquipment(params: {
  body: CreateEquipmentBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyEquipmentDetailDTO> {
  const { body, actor } = params;
  const id = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.equipment.create",
      requestPayload: body,
    });
    if (claim.replay && typeof claim.replay.id === "string") return claim.replay.id;

    const requirements = await assertCategoryUsable(client, body.categorie_code, "categorie_code");
    if (body.sous_categorie_code) {
      await assertCategoryUsable(client, body.sous_categorie_code, "sous_categorie_code");
    }
    assertSpecificationsMatchCategory(requirements, body);

    // Le code visible est alloué par le serveur, dans la transaction, et devient
    // immuable (trigger). Un code proposé par le client n'est jamais retenu.
    const code = await generateMetrologieEquipementCode(client);

    let newId: string;
    try {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.metrologie_equipements (
            code, designation, categorie, categorie_code, sous_categorie_code,
            marque, modele, numero_serie, criticite, statut, etat, notes,
            proprietaire_service, responsable_user_id, site, magasin, zone, localisation_precise,
            date_mise_en_service,
            unite, plage_min, plage_max, resolution, mpe, incertitude, methodes,
            conditions_utilisation, restrictions, etalon_reference, exige_certificat, specifications,
            created_by, updated_by
          )
          VALUES (
            $1,$2,$3,$3,$4,
            $5,$6,$7,$8,'ACTIF','DRAFT',$9,
            $10,$11,$12,$13,$14,$15,
            $16::date,
            $17,$18,$19,$20,$21,$22,$23::text[],
            $24,$25,$26,$27,$28::jsonb,
            $29,$29
          )
          RETURNING id::text AS id
        `,
        [
          code,
          body.designation,
          body.categorie_code,
          body.sous_categorie_code,
          body.marque,
          body.modele,
          body.numero_serie,
          body.criticite,
          body.notes,
          body.proprietaire_service,
          body.responsable_user_id,
          body.site,
          body.magasin,
          body.zone,
          body.localisation_precise,
          body.date_mise_en_service,
          body.unite,
          body.plage_min,
          body.plage_max,
          body.resolution,
          body.mpe,
          body.incertitude,
          body.methodes,
          body.conditions_utilisation,
          body.restrictions,
          body.etalon_reference,
          body.exige_certificat,
          JSON.stringify(body.specifications ?? {}),
          actor.user_id,
        ]
      );
      newId = ins.rows[0]?.id ?? "";
    } catch (err) {
      rethrowMapped(err);
    }
    if (!newId) throw new HttpError(500, "METROLOGY_EQUIPMENT_CREATE_FAILED", "Création impossible.");

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: newId,
      entity_type: "EQUIPEMENT",
      entity_id: newId,
      event_type: "EQUIPEMENT_CREATED",
      actor,
      old_values: null,
      new_values: { code, designation: body.designation, categorie_code: body.categorie_code, etat: "DRAFT" },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.equipements.create",
      entity_type: "metrologie_equipements",
      entity_id: newId,
      details: { code, designation: body.designation, criticite: body.criticite },
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.equipment.create",
      aggregateType: "EQUIPEMENT",
      aggregateId: newId,
      requestPayload: body,
      resultPayload: { id: newId, code },
      correlationId,
    });
    return newId;
  });

  const detail = await repoGetEquipmentDetail({ id, actor });
  if (!detail) throw new HttpError(500, "METROLOGY_EQUIPMENT_RELOAD_FAILED", "Équipement introuvable après création.");
  return detail;
}

export async function repoUpdateEquipment(params: {
  id: string;
  body: UpdateEquipmentBodyDTO;
  actor: MetrologyActor;
}): Promise<MetrologyEquipmentDetailDTO> {
  const { id, body, actor } = params;
  await withTransaction(async (client) => {
    const current = await lockEquipment(client, id);
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
    });

    const requirements = await assertCategoryUsable(client, body.categorie_code, "categorie_code");
    if (body.sous_categorie_code) {
      await assertCategoryUsable(client, body.sous_categorie_code, "sous_categorie_code");
    }
    assertSpecificationsMatchCategory(requirements, body);

    try {
      await client.query(
        `
          UPDATE public.metrologie_equipements SET
            designation = $2,
            categorie = $3,
            categorie_code = $3,
            sous_categorie_code = $4,
            marque = $5, modele = $6, numero_serie = $7, criticite = $8, notes = $9,
            proprietaire_service = $10, responsable_user_id = $11,
            site = $12, magasin = $13, zone = $14, localisation_precise = $15,
            date_mise_en_service = $16::date, date_retrait = $17::date,
            unite = $18, plage_min = $19, plage_max = $20, resolution = $21,
            mpe = $22, incertitude = $23, methodes = $24::text[],
            conditions_utilisation = $25, restrictions = $26, etalon_reference = $27,
            exige_certificat = $28, specifications = $29::jsonb,
            updated_at = now(), updated_by = $30
          WHERE id = $1::uuid
        `,
        [
          id,
          body.designation,
          body.categorie_code,
          body.sous_categorie_code,
          body.marque,
          body.modele,
          body.numero_serie,
          body.criticite,
          body.notes,
          body.proprietaire_service,
          body.responsable_user_id,
          body.site,
          body.magasin,
          body.zone,
          body.localisation_precise,
          body.date_mise_en_service,
          body.date_retrait,
          body.unite,
          body.plage_min,
          body.plage_max,
          body.resolution,
          body.mpe,
          body.incertitude,
          body.methodes,
          body.conditions_utilisation,
          body.restrictions,
          body.etalon_reference,
          body.exige_certificat,
          JSON.stringify(body.specifications ?? {}),
          actor.user_id,
        ]
      );
    } catch (err) {
      rethrowMapped(err);
    }

    await insertMetrologyEvent(client, {
      equipement_id: id,
      entity_type: "EQUIPEMENT",
      entity_id: id,
      event_type: "EQUIPEMENT_UPDATED",
      actor,
      old_values: { designation: current.designation, criticite: current.criticite },
      new_values: { designation: body.designation, criticite: body.criticite },
      correlation_id: crypto.randomUUID(),
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.equipements.update",
      entity_type: "metrologie_equipements",
      entity_id: id,
      details: { designation: body.designation },
    });
  });

  const detail = await repoGetEquipmentDetail({ id, actor });
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");
  return detail;
}

export async function repoTransitionEquipment(params: {
  id: string;
  body: EquipmentTransitionBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyEquipmentDetailDTO> {
  const { id, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.equipment.transition",
      requestPayload: { id, ...body },
    });
    if (claim.replay) return;

    const current = await lockEquipment(client, id);
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
    });
    assertEquipmentTransition(current.etat, body.target_state);

    // Une remise en service après quarantaine / hors tolérance / réparation
    // n'est jamais un simple changement de statut.
    if (transitionRequiresRelease(current.etat, body.target_state)) {
      if (!roleHasMetrologyCapability(actor.role, "equipment_release")) {
        throw new HttpError(
          403,
          "METROLOGY_CAPABILITY_REQUIRED",
          "La capacité Métrologie 'equipment_release' est requise pour remettre un instrument en service."
        );
      }
      const proof = await loadReleaseProof(client, id, body.proof_execution_id ?? null);
      assertEquipmentReleaseAllowed({
        hasValidConformeProof: proof.valid,
        proofExecutionId: proof.executionId,
        repairRequired: current.etat === "UNDER_REPAIR" || current.etat === "OUT_OF_TOLERANCE",
        repairDone: proof.repairDone,
        reason: body.reason,
      });
    }

    await client.query(
      `
        UPDATE public.metrologie_equipements
        SET etat = $2, etat_motif = $3, etat_changed_at = now(), etat_changed_by = $4,
            quarantine_reason = CASE WHEN $2 IN ('QUARANTINE','OUT_OF_TOLERANCE') THEN quarantine_reason ELSE NULL END,
            quarantined_at = CASE WHEN $2 IN ('QUARANTINE','OUT_OF_TOLERANCE') THEN quarantined_at ELSE NULL END,
            quarantined_by = CASE WHEN $2 IN ('QUARANTINE','OUT_OF_TOLERANCE') THEN quarantined_by ELSE NULL END,
            date_retrait = CASE WHEN $2 = 'RETIRED' THEN COALESCE(date_retrait, CURRENT_DATE) ELSE date_retrait END,
            updated_at = now(), updated_by = $4
        WHERE id = $1::uuid
      `,
      [id, body.target_state, body.reason, actor.user_id]
    );

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: id,
      entity_type: "EQUIPEMENT",
      entity_id: id,
      event_type: `EQUIPEMENT_STATE_${body.target_state}`,
      actor,
      old_values: { etat: current.etat },
      new_values: { etat: body.target_state, proof_execution_id: body.proof_execution_id ?? null },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.equipements.transition",
      entity_type: "metrologie_equipements",
      entity_id: id,
      details: { from: current.etat, to: body.target_state, reason: body.reason },
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.equipment.transition",
      aggregateType: "EQUIPEMENT",
      aggregateId: id,
      requestPayload: { id, ...body },
      resultPayload: { id, etat: body.target_state },
      correlationId,
    });
  });

  const detail = await repoGetEquipmentDetail({ id, actor });
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");
  return detail;
}

async function loadReleaseProof(
  client: PoolClient,
  equipementId: string,
  requestedExecutionId: string | null
): Promise<{ valid: boolean; executionId: string | null; repairDone: boolean }> {
  const res = await client.query<{ id: string; verdict: string; ended_at: string; operation_type: string }>(
    `
      SELECT id::text AS id, verdict, ended_at::text AS ended_at, operation_type
      FROM public.metrologie_execution
      WHERE equipement_id = $1::uuid
        AND status = 'VALIDATED'
        AND verdict IN ('CONFORME', 'CONFORME_AVEC_RESTRICTION')
        AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY ended_at DESC NULLS LAST
      LIMIT 1
    `,
    [equipementId, requestedExecutionId]
  );
  const proof = res.rows[0] ?? null;

  const repair = await client.query<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM public.metrologie_execution
      WHERE equipement_id = $1::uuid
        AND status = 'VALIDATED'
        AND operation_type IN ('AJUSTAGE', 'REPARATION')
        AND ($2::timestamptz IS NULL OR ended_at >= $2::timestamptz)
    `,
    [equipementId, null]
  );

  return {
    valid: Boolean(proof),
    executionId: proof?.id ?? null,
    repairDone: toInt(repair.rows[0]?.total, 0) > 0,
  };
}

export async function repoQuarantineEquipment(params: {
  id: string;
  body: QuarantineBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyEquipmentDetailDTO> {
  const { id, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.equipment.quarantine",
      requestPayload: { id, ...body },
    });
    if (claim.replay) return;

    const current = await lockEquipment(client, id);
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
    });
    if (current.etat !== "QUARANTINE") {
      assertEquipmentTransition(current.etat, "QUARANTINE");
    }

    await client.query(
      `
        UPDATE public.metrologie_equipements
        SET etat = 'QUARANTINE', etat_motif = $2, etat_changed_at = now(), etat_changed_by = $3,
            quarantine_reason = $2, quarantined_at = now(), quarantined_by = $3,
            updated_at = now(), updated_by = $3
        WHERE id = $1::uuid
      `,
      [id, body.reason, actor.user_id]
    );

    const correlationId = crypto.randomUUID();
    let dossierId: string | null = null;
    if (body.open_impact_analysis) {
      const dossier = await openImpactDossier(client, {
        equipementId: id,
        executionId: null,
        certificatId: null,
        trigger: "MANUEL",
        actor,
        correlationId,
        approvedWindow: null,
        exclusions: null,
        ownerUserId: null,
      });
      dossierId = dossier.id;
    }

    await insertMetrologyEvent(client, {
      equipement_id: id,
      entity_type: "EQUIPEMENT",
      entity_id: id,
      event_type: "EQUIPEMENT_QUARANTINE",
      actor,
      old_values: { etat: current.etat },
      new_values: { etat: "QUARANTINE", impact_dossier_id: dossierId },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.equipements.quarantine",
      entity_type: "metrologie_equipements",
      entity_id: id,
      details: { reason: body.reason, impact_dossier_id: dossierId },
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.equipment.quarantine",
      aggregateType: "EQUIPEMENT",
      aggregateId: id,
      requestPayload: { id, ...body },
      resultPayload: { id, etat: "QUARANTINE", impact_dossier_id: dossierId },
      correlationId,
    });
  });

  const detail = await repoGetEquipmentDetail({ id, actor });
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");
  return detail;
}

/* ========================================================================== */
/* Plans versionnés                                                           */
/* ========================================================================== */

function planCriteria(body: CreatePlanBodyDTO | RevisePlanBodyDTO): Record<string, unknown> {
  return { min_points: body.min_points };
}

export async function repoCreatePlanVersion(params: {
  equipementId: string;
  body: CreatePlanBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyPlanVersionDTO> {
  const { equipementId, body, actor } = params;
  const planId = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.plan.create",
      requestPayload: { equipementId, ...body },
    });
    if (claim.replay && typeof claim.replay.id === "string") return claim.replay.id;

    await lockEquipment(client, equipementId);

    const versionRes = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM public.metrologie_plan_version
        WHERE equipement_id = $1::uuid AND operation_type = $2`,
      [equipementId, body.operation_type]
    );
    const version = toInt(versionRes.rows[0]?.next_version, 1);

    let newId: string;
    try {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.metrologie_plan_version (
            equipement_id, version, status, operation_type, methode, procedure_ref,
            periodicite_valeur, periodicite_unite, base_calcul, alert_window_days,
            criteres, tolerance_min, tolerance_max, unite,
            prestataire_type, prestataire_label, fournisseur_id, role_habilite,
            criticite, blocking_strategy, exige_certificat, effective_from, notes,
            created_by, updated_by
          )
          VALUES (
            $1::uuid,$2,'DRAFT',$3,$4,$5,
            $6,$7,$8,$9,
            $10::jsonb,$11,$12,$13,
            $14,$15,$16::uuid,$17,
            $18,$19,$20,$21::date,$22,
            $23,$23
          )
          RETURNING id::text AS id
        `,
        [
          equipementId,
          version,
          body.operation_type,
          body.methode,
          body.procedure_ref,
          body.periodicite_valeur,
          body.periodicite_unite,
          body.base_calcul,
          body.alert_window_days,
          JSON.stringify(planCriteria(body)),
          body.tolerance_min,
          body.tolerance_max,
          body.unite,
          body.prestataire_type,
          body.prestataire_label,
          body.fournisseur_id ?? null,
          body.role_habilite,
          body.criticite,
          body.blocking_strategy,
          body.exige_certificat,
          body.effective_from,
          body.notes,
          actor.user_id,
        ]
      );
      newId = ins.rows[0]?.id ?? "";
    } catch (err) {
      rethrowMapped(err);
    }
    if (!newId) throw new HttpError(500, "METROLOGY_PLAN_CREATE_FAILED", "Création du plan impossible.");

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: equipementId,
      entity_type: "PLAN",
      entity_id: newId,
      event_type: "PLAN_VERSION_CREATED",
      actor,
      old_values: null,
      new_values: { version, operation_type: body.operation_type, status: "DRAFT" },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.plans.create",
      entity_type: "metrologie_plan_version",
      entity_id: newId,
      details: { equipement_id: equipementId, version, operation_type: body.operation_type },
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.plan.create",
      aggregateType: "PLAN",
      aggregateId: newId,
      requestPayload: { equipementId, ...body },
      resultPayload: { id: newId, version },
      correlationId,
    });
    return newId;
  });

  return loadPlan(planId);
}

export async function repoRevisePlanVersion(params: {
  equipementId: string;
  planId: string;
  body: RevisePlanBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyPlanVersionDTO> {
  const { equipementId, planId, body, actor } = params;
  const newPlanId = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.plan.revise",
      requestPayload: { equipementId, planId, ...body },
    });
    if (claim.replay && typeof claim.replay.id === "string") return claim.replay.id;

    await lockEquipment(client, equipementId);
    const source = await client.query<{
      id: string;
      version: number;
      status: "DRAFT" | "ACTIVE" | "ARCHIVED";
      operation_type: string;
      updated_at: string;
    }>(
      `SELECT id::text AS id, version, status, operation_type, updated_at::text AS updated_at
         FROM public.metrologie_plan_version
        WHERE id = $1::uuid AND equipement_id = $2::uuid
        FOR UPDATE`,
      [planId, equipementId]
    );
    const current = source.rows[0] ?? null;
    if (!current) throw new HttpError(404, "NOT_FOUND", "Version de plan introuvable.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
    });

    // Réviser un brouillon = l'éditer sur place. Réviser une version publiée =
    // créer la version suivante : la publiée reste figée.
    if (current.status === "DRAFT") {
      await client.query(
        `
          UPDATE public.metrologie_plan_version SET
            operation_type = $2, methode = $3, procedure_ref = $4,
            periodicite_valeur = $5, periodicite_unite = $6, base_calcul = $7,
            alert_window_days = $8, criteres = $9::jsonb,
            tolerance_min = $10, tolerance_max = $11, unite = $12,
            prestataire_type = $13, prestataire_label = $14, fournisseur_id = $15::uuid,
            role_habilite = $16, criticite = $17, blocking_strategy = $18,
            exige_certificat = $19, effective_from = $20::date, notes = $21,
            updated_at = now(), updated_by = $22
          WHERE id = $1::uuid
        `,
        [
          planId,
          body.operation_type,
          body.methode,
          body.procedure_ref,
          body.periodicite_valeur,
          body.periodicite_unite,
          body.base_calcul,
          body.alert_window_days,
          JSON.stringify(planCriteria(body)),
          body.tolerance_min,
          body.tolerance_max,
          body.unite,
          body.prestataire_type,
          body.prestataire_label,
          body.fournisseur_id ?? null,
          body.role_habilite,
          body.criticite,
          body.blocking_strategy,
          body.exige_certificat,
          body.effective_from,
          body.notes,
          actor.user_id,
        ]
      );

      await insertMetrologyEvent(client, {
        equipement_id: equipementId,
        entity_type: "PLAN",
        entity_id: planId,
        event_type: "PLAN_VERSION_EDITED",
        actor,
        old_values: { version: current.version, status: current.status },
        new_values: { version: current.version },
        correlation_id: crypto.randomUUID(),
        idempotency_key: claim.idempotencyKey,
        reason: body.revision_reason,
      });
      await saveReceipt({
        client,
        actor,
        claim,
        commandType: "metrology.plan.revise",
        aggregateType: "PLAN",
        aggregateId: planId,
        requestPayload: { equipementId, planId, ...body },
        resultPayload: { id: planId, version: current.version },
        correlationId: crypto.randomUUID(),
      });
      return planId;
    }

    assertPlanContentMutable("DRAFT"); // Documente l'intention : le contenu publié est figé.
    const versionRes = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM public.metrologie_plan_version
        WHERE equipement_id = $1::uuid AND operation_type = $2`,
      [equipementId, body.operation_type]
    );
    const version = toInt(versionRes.rows[0]?.next_version, current.version + 1);

    let createdId: string;
    try {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.metrologie_plan_version (
            equipement_id, version, status, operation_type, methode, procedure_ref,
            periodicite_valeur, periodicite_unite, base_calcul, alert_window_days,
            criteres, tolerance_min, tolerance_max, unite,
            prestataire_type, prestataire_label, fournisseur_id, role_habilite,
            criticite, blocking_strategy, exige_certificat, effective_from, notes,
            created_by, updated_by
          )
          VALUES (
            $1::uuid,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$9,
            $10::jsonb,$11,$12,$13,$14,$15,$16::uuid,$17,$18,$19,$20,$21::date,$22,$23,$23
          )
          RETURNING id::text AS id
        `,
        [
          equipementId,
          version,
          body.operation_type,
          body.methode,
          body.procedure_ref,
          body.periodicite_valeur,
          body.periodicite_unite,
          body.base_calcul,
          body.alert_window_days,
          JSON.stringify(planCriteria(body)),
          body.tolerance_min,
          body.tolerance_max,
          body.unite,
          body.prestataire_type,
          body.prestataire_label,
          body.fournisseur_id ?? null,
          body.role_habilite,
          body.criticite,
          body.blocking_strategy,
          body.exige_certificat,
          body.effective_from,
          body.notes,
          actor.user_id,
        ]
      );
      createdId = ins.rows[0]?.id ?? "";
    } catch (err) {
      rethrowMapped(err);
    }
    if (!createdId) throw new HttpError(500, "METROLOGY_PLAN_REVISE_FAILED", "Révision impossible.");

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: equipementId,
      entity_type: "PLAN",
      entity_id: createdId,
      event_type: "PLAN_VERSION_REVISED",
      actor,
      old_values: { from_plan_id: planId, from_version: current.version },
      new_values: { version, status: "DRAFT" },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.revision_reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.plans.revise",
      entity_type: "metrologie_plan_version",
      entity_id: createdId,
      details: { equipement_id: equipementId, from_version: current.version, version },
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.plan.revise",
      aggregateType: "PLAN",
      aggregateId: createdId,
      requestPayload: { equipementId, planId, ...body },
      resultPayload: { id: createdId, version },
      correlationId,
    });
    return createdId;
  });

  return loadPlan(newPlanId);
}

export async function repoTransitionPlanVersion(params: {
  equipementId: string;
  planId: string;
  body: PlanTransitionBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyPlanVersionDTO> {
  const { equipementId, planId, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.plan.transition",
      requestPayload: { equipementId, planId, ...body },
    });
    if (claim.replay) return;

    const equipment = await lockEquipment(client, equipementId);
    const res = await client.query<{
      id: string;
      status: "DRAFT" | "ACTIVE" | "ARCHIVED";
      version: number;
      operation_type: string;
      updated_at: string;
      periodicite_valeur: number;
      periodicite_unite: "DAY" | "WEEK" | "MONTH" | "YEAR";
      base_calcul: "LAST_PROOF" | "FIXED_DATE";
      alert_window_days: number;
      effective_from: string | null;
    }>(
      `SELECT id::text AS id, status, version, operation_type, updated_at::text AS updated_at,
              periodicite_valeur, periodicite_unite, base_calcul, alert_window_days,
              effective_from::text AS effective_from
         FROM public.metrologie_plan_version
        WHERE id = $1::uuid AND equipement_id = $2::uuid
        FOR UPDATE`,
      [planId, equipementId]
    );
    const current = res.rows[0] ?? null;
    if (!current) throw new HttpError(404, "NOT_FOUND", "Version de plan introuvable.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: current.updated_at,
    });
    assertPlanTransition(current.status, body.target_status);

    if (body.target_status === "ACTIVE") {
      // Publier une version archive la précédente : une seule règle applicable
      // à la fois, jamais deux périodicités concurrentes.
      await client.query(
        `
          UPDATE public.metrologie_plan_version
          SET status = 'ARCHIVED', archived_at = now(), updated_at = now(), updated_by = $3
          WHERE equipement_id = $1::uuid AND operation_type = $2 AND status = 'ACTIVE'
        `,
        [equipementId, current.operation_type, actor.user_id]
      );

      const proof = await client.query<{ ended_at: string | null }>(
        `SELECT ended_at::text AS ended_at
           FROM public.metrologie_execution
          WHERE equipement_id = $1::uuid AND status = 'VALIDATED'
            AND verdict IN ('CONFORME','CONFORME_AVEC_RESTRICTION')
          ORDER BY ended_at DESC NULLS LAST LIMIT 1`,
        [equipementId]
      );
      const schedule = computeNextDueDate({
        plan: {
          periodicite_valeur: current.periodicite_valeur,
          periodicite_unite: current.periodicite_unite,
          base_calcul: current.base_calcul,
          alert_window_days: current.alert_window_days,
          effective_from: current.effective_from,
        },
        lastProofDate: proof.rows[0]?.ended_at ?? null,
        fallbackDate: equipment.created_at,
      });

      await client.query(
        `
          UPDATE public.metrologie_plan_version
          SET status = 'ACTIVE', published_at = now(),
              last_proof_date = $2::date, next_due_date = $3::date,
              updated_at = now(), updated_by = $4
          WHERE id = $1::uuid
        `,
        [planId, proof.rows[0]?.ended_at?.slice(0, 10) ?? null, schedule.next_due_date, actor.user_id]
      );

      // Miroir hérité : `metrologie_plan` reste exact pour les KPI existants.
      await syncLegacyPlan(client, {
        equipementId,
        actorId: actor.user_id,
        periodiciteMois: monthsFromPeriodicity(current.periodicite_valeur, current.periodicite_unite),
        lastDoneDate: proof.rows[0]?.ended_at?.slice(0, 10) ?? null,
        nextDueDate: schedule.next_due_date,
      });
    } else {
      await client.query(
        `
          UPDATE public.metrologie_plan_version
          SET status = 'ARCHIVED', archived_at = now(), updated_at = now(), updated_by = $2
          WHERE id = $1::uuid
        `,
        [planId, actor.user_id]
      );
    }

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: equipementId,
      entity_type: "PLAN",
      entity_id: planId,
      event_type: `PLAN_VERSION_${body.target_status}`,
      actor,
      old_values: { status: current.status },
      new_values: { status: body.target_status, version: current.version },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.plans.transition",
      entity_type: "metrologie_plan_version",
      entity_id: planId,
      details: { from: current.status, to: body.target_status },
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.plan.transition",
      aggregateType: "PLAN",
      aggregateId: planId,
      requestPayload: { equipementId, planId, ...body },
      resultPayload: { id: planId, status: body.target_status },
      correlationId,
    });
  });

  return loadPlan(planId);
}

export function monthsFromPeriodicity(
  value: number,
  unit: "DAY" | "WEEK" | "MONTH" | "YEAR"
): number {
  switch (unit) {
    case "DAY":
      return Math.max(1, Math.round(value / 30));
    case "WEEK":
      return Math.max(1, Math.round((value * 7) / 30));
    case "YEAR":
      return Math.max(1, value * 12);
    case "MONTH":
    default:
      return Math.max(1, value);
  }
}

/**
 * Miroir de la table héritée `metrologie_plan`. Les KPI, alertes et écrans déjà
 * en production la lisent : la laisser diverger ferait mentir des tableaux de
 * bord réels.
 */
export async function syncLegacyPlan(
  client: PoolClient,
  params: {
    equipementId: string;
    actorId: number;
    periodiciteMois: number;
    lastDoneDate: string | null;
    nextDueDate: string | null;
    statut?: "EN_COURS" | "SUSPENDU" | "EN_RETARD" | "HORS_TOLERANCE";
  }
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.metrologie_plan
      WHERE equipement_id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
    [params.equipementId]
  );
  const statut = params.statut ?? "EN_COURS";

  if (existing.rows[0]) {
    await client.query(
      `
        UPDATE public.metrologie_plan
        SET periodicite_mois = $2,
            last_done_date = COALESCE($3::date, last_done_date),
            next_due_date = $4::date,
            statut = $5,
            updated_at = now(), updated_by = $6
        WHERE id = $1::uuid
      `,
      [
        existing.rows[0].id,
        params.periodiciteMois,
        params.lastDoneDate,
        params.nextDueDate,
        statut,
        params.actorId,
      ]
    );
    return;
  }

  await client.query(
    `
      INSERT INTO public.metrologie_plan (
        equipement_id, periodicite_mois, last_done_date, next_due_date, statut, created_by, updated_by
      )
      VALUES ($1::uuid, $2, $3::date, $4::date, $5, $6, $6)
    `,
    [
      params.equipementId,
      params.periodiciteMois,
      params.lastDoneDate,
      params.nextDueDate,
      statut,
      params.actorId,
    ]
  );
}

async function loadPlan(planId: string): Promise<MetrologyPlanVersionDTO> {
  const res = await db().query<PlanRow>(`${PLAN_SELECT} WHERE p.id = $1::uuid LIMIT 1`, [planId]);
  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(404, "NOT_FOUND", "Version de plan introuvable.");
  return mapPlan(row, new Date());
}

/* ========================================================================== */
/* Aperçu d'échéance                                                          */
/* ========================================================================== */

export async function repoSchedulePreview(params: {
  equipementId: string;
  query: SchedulePreviewQueryDTO;
}): Promise<{
  next_due_date: string | null;
  source: string;
  base_date: string | null;
  due: MetrologyDueDTO;
}> {
  const equipment = await db().query<{ created_at: string; date_mise_en_service: string | null }>(
    `SELECT created_at::text AS created_at, date_mise_en_service::text AS date_mise_en_service
       FROM public.metrologie_equipements WHERE id = $1::uuid AND deleted_at IS NULL`,
    [params.equipementId]
  );
  const equip = equipment.rows[0] ?? null;
  if (!equip) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");

  let plan: SchedulePlan | null = null;
  if (params.query.plan_version_id) {
    const res = await db().query<{
      periodicite_valeur: number;
      periodicite_unite: "DAY" | "WEEK" | "MONTH" | "YEAR";
      base_calcul: "LAST_PROOF" | "FIXED_DATE";
      alert_window_days: number;
      effective_from: string | null;
    }>(
      `SELECT periodicite_valeur, periodicite_unite, base_calcul, alert_window_days,
              effective_from::text AS effective_from
         FROM public.metrologie_plan_version WHERE id = $1::uuid AND equipement_id = $2::uuid`,
      [params.query.plan_version_id, params.equipementId]
    );
    const row = res.rows[0] ?? null;
    if (!row) throw new HttpError(404, "NOT_FOUND", "Version de plan introuvable.");
    plan = row;
  } else if (params.query.periodicite_valeur) {
    plan = {
      periodicite_valeur: params.query.periodicite_valeur,
      periodicite_unite: params.query.periodicite_unite ?? "MONTH",
      base_calcul: params.query.base_calcul ?? "LAST_PROOF",
      alert_window_days: params.query.alert_window_days ?? 30,
      effective_from: params.query.effective_from ?? null,
    };
  }

  if (!plan) {
    throw new HttpError(
      422,
      "METROLOGY_SCHEDULE_INPUT_REQUIRED",
      "Fournissez une version de plan ou une périodicité à simuler."
    );
  }

  const proof = await db().query<{ ended_at: string | null }>(
    `SELECT ended_at::text AS ended_at FROM public.metrologie_execution
      WHERE equipement_id = $1::uuid AND status = 'VALIDATED'
        AND verdict IN ('CONFORME','CONFORME_AVEC_RESTRICTION')
      ORDER BY ended_at DESC NULLS LAST LIMIT 1`,
    [params.equipementId]
  );

  const result = computeNextDueDate({
    plan,
    lastProofDate: params.query.last_proof_date ?? proof.rows[0]?.ended_at?.slice(0, 10) ?? null,
    certificateDueDate: params.query.certificate_due_date ?? null,
    fallbackDate: equip.date_mise_en_service ?? equip.created_at,
  });

  return {
    next_due_date: result.next_due_date,
    source: result.source,
    base_date: result.base_date,
    due: mapDue(
      evaluateDue({
        nextDueDate: result.next_due_date,
        alertWindowDays: plan.alert_window_days,
        at: new Date(),
      })
    ),
  };
}

/* ========================================================================== */
/* Éligibilité                                                                */
/* ========================================================================== */

export async function repoEvaluateEligibility(params: {
  query: EligibilityQueryDTO;
  actor: MetrologyActor;
}): Promise<MetrologyEligibilityResultDTO> {
  const { query, actor } = params;
  const at = new Date();
  const policy = await loadMetrologyPolicy(db());

  const requirement: MetrologyUsageRequirement = {
    characteristic_key: query.characteristic_key,
    requires_instrument: true,
    instrument_category: query.instrument_category ?? null,
    method: query.method ?? null,
    unit: query.unit ?? null,
    nominal: query.nominal ?? null,
    tolerance_min: query.tolerance_min ?? null,
    tolerance_max: query.tolerance_max ?? null,
    requires_certificate: query.requires_certificate === "true",
  };

  const rights = { canRecordMeasurement: roleHasMetrologyCapability(actor.role, "execution_record") };

  const instruments =
    query.mode === "single"
      ? [await loadInstrumentState(db(), query.instrument_id as string)]
      : await loadInstrumentCandidates(db(), {
          category: query.instrument_category ?? null,
          search: null,
          limit: query.limit,
        });

  const results = instruments.map((instrument) => {
    const eligibility = evaluateInstrumentEligibility({ requirement, instrument, at, policy, rights });
    return {
      instrument_id: instrument?.id ?? (query.instrument_id ?? ""),
      code: instrument?.code ?? null,
      designation: instrument?.designation ?? null,
      eligible: eligibility.eligible,
      severity: eligibility.severity,
      reason_code: eligibility.code,
      message: eligibility.message,
      reasons: eligibility.reasons.map((reason) => ({
        code: reason.code,
        severity: reason.severity,
        message: reason.message,
      })),
      due: mapDue(eligibility.due),
    };
  });

  // Les instruments utilisables d'abord : l'atelier doit voir le bon outil en
  // tête, pas devoir lire toute la liste.
  results.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    if (left.severity !== right.severity) return left.severity === "OK" ? -1 : 1;
    return (left.code ?? "").localeCompare(right.code ?? "");
  });

  return { mode: query.mode, evaluated_at: at.toISOString(), policy, results };
}

/**
 * Point d'entrée réutilisé par le module Qualité pour construire le snapshot
 * immuable. La règle vit ici et NULLE PART AILLEURS.
 */
export async function repoBuildInstrumentSnapshot(params: {
  q: DbQueryer;
  instrumentId: string;
  requirement: MetrologyUsageRequirement;
  at: Date;
}) {
  const instrument = await loadInstrumentState(params.q, params.instrumentId);
  if (!instrument) return null;
  const policy = await loadMetrologyPolicy(params.q);
  const eligibility = evaluateInstrumentEligibility({
    requirement: params.requirement,
    instrument,
    at: params.at,
    policy,
  });
  return {
    instrument,
    eligibility,
    snapshot: buildInstrumentSnapshot({ instrument, eligibility, at: params.at }),
  };
}

/* ========================================================================== */
/* Command center                                                             */
/* ========================================================================== */

export async function repoCenter(params: {
  site: string | null;
  categorieCode: string | null;
  horizonDays: number;
}): Promise<MetrologyCenterDTO> {
  const values: unknown[] = [params.horizonDays];
  const filters: string[] = ["e.deleted_at IS NULL"];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (params.site) filters.push(`e.site = ${push(params.site)}`);
  if (params.categorieCode) filters.push(`e.categorie_code = ${push(params.categorieCode)}`);
  const whereSql = `WHERE ${filters.join(" AND ")}`;

  // The quarantine query does not consume the horizon. Build its placeholders
  // independently so optional filters remain contiguous from `$1`.
  const quarantinedValues: unknown[] = [];
  const quarantinedFilters: string[] = ["e.deleted_at IS NULL"];
  const pushQuarantined = (value: unknown) => {
    quarantinedValues.push(value);
    return `$${quarantinedValues.length}`;
  };
  if (params.site) quarantinedFilters.push(`e.site = ${pushQuarantined(params.site)}`);
  if (params.categorieCode) quarantinedFilters.push(`e.categorie_code = ${pushQuarantined(params.categorieCode)}`);
  const quarantinedWhereSql = `WHERE ${quarantinedFilters.join(" AND ")}`;

  const kpiRes = await db().query<Record<string, string>>(
    `
      WITH scoped AS (
        SELECT
          e.id, e.etat, e.criticite,
          COALESCE(pv.next_due_date, legacy.next_due_date) AS next_due_date
        FROM public.metrologie_equipements e
        LEFT JOIN LATERAL (
          SELECT p.next_due_date FROM public.metrologie_plan_version p
          WHERE p.equipement_id = e.id AND p.status = 'ACTIVE'
          ORDER BY p.next_due_date ASC NULLS LAST LIMIT 1
        ) pv ON TRUE
        LEFT JOIN LATERAL (
          SELECT lp.next_due_date FROM public.metrologie_plan lp
          WHERE lp.equipement_id = e.id AND lp.deleted_at IS NULL AND lp.statut <> 'SUSPENDU'
          ORDER BY lp.created_at DESC LIMIT 1
        ) legacy ON TRUE
        ${whereSql}
      )
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE etat IN ('ACTIVE','QUALIFIED'))::text AS usable,
        COUNT(*) FILTER (
          WHERE etat IN ('ACTIVE','QUALIFIED') AND next_due_date IS NOT NULL
            AND next_due_date >= CURRENT_DATE
            AND next_due_date <= CURRENT_DATE + ($1::int || ' days')::interval
        )::text AS due_soon,
        COUNT(*) FILTER (
          WHERE etat IN ('ACTIVE','QUALIFIED') AND next_due_date IS NOT NULL AND next_due_date < CURRENT_DATE
        )::text AS overdue,
        COUNT(*) FILTER (
          WHERE etat IN ('ACTIVE','QUALIFIED') AND criticite = 'CRITIQUE'
            AND next_due_date IS NOT NULL AND next_due_date < CURRENT_DATE
        )::text AS overdue_critical,
        COUNT(*) FILTER (WHERE etat = 'QUARANTINE')::text AS quarantine,
        COUNT(*) FILTER (WHERE etat = 'OUT_OF_TOLERANCE')::text AS out_of_tolerance,
        COUNT(*) FILTER (WHERE etat = 'UNDER_REPAIR')::text AS under_repair,
        COUNT(*) FILTER (WHERE etat = 'RETIRED')::text AS retired
      FROM scoped
    `,
    values
  );
  const kpiRow = kpiRes.rows[0] ?? {};

  const impactRes = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM public.metrologie_impact_dossier WHERE status IN ('OPEN','IN_REVIEW')`
  );

  const coverageRes = await db().query<{
    key: string;
    label: string;
    total: string;
    overdue: string;
    due_soon: string;
  }>(
    `
      SELECT
        COALESCE(e.categorie_code, 'NON_CLASSE') AS key,
        COALESCE(cat.label, 'Non classé') AS label,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (
          WHERE COALESCE(pv.next_due_date, legacy.next_due_date) < CURRENT_DATE
        )::text AS overdue,
        COUNT(*) FILTER (
          WHERE COALESCE(pv.next_due_date, legacy.next_due_date) >= CURRENT_DATE
            AND COALESCE(pv.next_due_date, legacy.next_due_date)
                <= CURRENT_DATE + ($1::int || ' days')::interval
        )::text AS due_soon
      FROM public.metrologie_equipements e
      LEFT JOIN public.metrologie_categories cat ON cat.code = e.categorie_code
      LEFT JOIN LATERAL (
        SELECT p.next_due_date FROM public.metrologie_plan_version p
        WHERE p.equipement_id = e.id AND p.status = 'ACTIVE'
        ORDER BY p.next_due_date ASC NULLS LAST LIMIT 1
      ) pv ON TRUE
      LEFT JOIN LATERAL (
        SELECT lp.next_due_date FROM public.metrologie_plan lp
        WHERE lp.equipement_id = e.id AND lp.deleted_at IS NULL AND lp.statut <> 'SUSPENDU'
        ORDER BY lp.created_at DESC LIMIT 1
      ) legacy ON TRUE
      ${whereSql}
      GROUP BY 1, 2
      ORDER BY 3 DESC
      LIMIT 20
    `,
    values
  );

  const at = new Date();
  const upcoming = await db().query<EquipmentListRow>(
    `${EQUIPMENT_LIST_SELECT} ${whereSql}
       AND e.etat IN ('ACTIVE','QUALIFIED')
       AND COALESCE(pv.next_due_date, legacy.next_due_date) IS NOT NULL
       AND COALESCE(pv.next_due_date, legacy.next_due_date)
           <= CURRENT_DATE + ($1::int || ' days')::interval
     ORDER BY COALESCE(pv.next_due_date, legacy.next_due_date) ASC
     LIMIT 12`,
    values
  );

  const quarantined = await db().query<EquipmentListRow>(
    `${EQUIPMENT_LIST_SELECT} ${quarantinedWhereSql}
       AND e.etat IN ('QUARANTINE','OUT_OF_TOLERANCE','UNDER_REPAIR')
     ORDER BY e.updated_at DESC
     LIMIT 12`,
    quarantinedValues
  );

  const openImpacts = await db().query(
    `
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
      WHERE d.status IN ('OPEN','IN_REVIEW')
      ORDER BY
        CASE d.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
        d.created_at DESC
      LIMIT 12
    `
  );

  return {
    kpis: {
      total: toInt(kpiRow.total, 0),
      usable: toInt(kpiRow.usable, 0),
      due_soon: toInt(kpiRow.due_soon, 0),
      overdue: toInt(kpiRow.overdue, 0),
      overdue_critical: toInt(kpiRow.overdue_critical, 0),
      quarantine: toInt(kpiRow.quarantine, 0),
      out_of_tolerance: toInt(kpiRow.out_of_tolerance, 0),
      under_repair: toInt(kpiRow.under_repair, 0),
      retired: toInt(kpiRow.retired, 0),
      open_impacts: toInt(impactRes.rows[0]?.total, 0),
    },
    coverage: coverageRes.rows.map((row) => ({
      key: row.key,
      label: row.label,
      total: toInt(row.total, 0),
      overdue: toInt(row.overdue, 0),
      due_soon: toInt(row.due_soon, 0),
    })),
    upcoming: upcoming.rows.map((row) => mapEquipmentListItem(row, at)),
    quarantined: quarantined.rows.map((row) => mapEquipmentListItem(row, at)),
    open_impacts: openImpacts.rows.map(mapImpactListRow),
    generated_at: at.toISOString(),
  };
}

/* ========================================================================== */
/* Timeline                                                                   */
/* ========================================================================== */

export async function repoTimeline(params: {
  equipementId: string;
  query: TimelineQueryDTO;
}): Promise<Paginated<MetrologyTimelineEntryDTO>> {
  const offset = (params.query.page - 1) * params.query.pageSize;
  const values: unknown[] = [params.equipementId];
  const where: string[] = ["l.equipement_id = $1::uuid"];
  if (params.query.entity_type) {
    values.push(params.query.entity_type);
    where.push(`l.entity_type = $${values.length}`);
  }

  const countRes = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM public.metrologie_event_log l WHERE ${where.join(" AND ")}`,
    values
  );

  values.push(params.query.pageSize, offset);
  const res = await db().query(
    `
      SELECT
        l.id::text AS id, l.entity_type, l.entity_id, l.event_type, l.reason, l.rule_code,
        l.correlation_id::text AS correlation_id, l.created_at::text AS created_at,
        u.id AS user_id, u.username, u.name, u.surname
      FROM public.metrologie_event_log l
      LEFT JOIN public.users u ON u.id = l.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at ${sortDirection(params.query.sortDir)}, l.id DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  );

  return {
    items: res.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      entity_type: (row.entity_type ?? null) as string | null,
      entity_id: (row.entity_id ?? null) as string | null,
      event_type: String(row.event_type),
      reason: (row.reason ?? null) as string | null,
      rule_code: (row.rule_code ?? null) as string | null,
      correlation_id: (row.correlation_id ?? null) as string | null,
      user: mapUserRef({
        id: (row.user_id ?? null) as number | null,
        username: (row.username ?? null) as string | null,
        name: (row.name ?? null) as string | null,
        surname: (row.surname ?? null) as string | null,
      }),
      created_at: String(row.created_at),
    })),
    total: toInt(countRes.rows[0]?.total, 0),
    page: params.query.page,
    pageSize: params.query.pageSize,
  };
}
