// Repository Méthodes — familles machine, centres de frais tarifés, sélecteur machines.
//
// Les trois référentiels restent des tables distinctes : une famille n'est pas
// un centre de frais, un centre de frais n'est pas une machine. Aucune
// classification n'est déduite d'un libellé ni d'un code : ce qui n'est pas
// renseigné sort en `null` et l'interface le dit.

import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  assertDesignationTemplateAllowed,
  assertRateSupersedes,
  assertOptimisticVersion,
  pickApplicableRate,
  type CostCenterRate,
} from "../domain/methodes-policy";
import type {
  AuditContext,
  CostCenterDTO,
  CostCenterRateDTO,
  MachineFamilyDTO,
  MachineOptionDTO,
} from "../types/methodes.types";

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

/** Le driver PG renvoie les NUMERIC en chaîne : on ne laisse jamais fuir un `"50.00"`. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function insertAudit(
  tx: Pick<PoolClient, "query">,
  audit: AuditContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> | null
): Promise<void> {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: audit.page_key,
      entity_type: entityType,
      entity_id: entityId,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

/* -------------------------------------------------------------------------- */
/* 1) Familles machine                                                        */
/* -------------------------------------------------------------------------- */

const FAMILY_COLS = `
  f.code, f.libelle, f.description, f.programme_requis, f.est_favori,
  f.ordre_affichage, f.actif, f.created_at::text AS created_at, f.updated_at::text AS updated_at
`;

function mapFamily(row: Record<string, unknown>): MachineFamilyDTO {
  return {
    code: String(row.code),
    libelle: String(row.libelle),
    description: (row.description as string | null) ?? null,
    programme_requis: Boolean(row.programme_requis),
    est_favori: Boolean(row.est_favori),
    ordre_affichage: Number(row.ordre_affichage),
    actif: Boolean(row.actif),
    machines_count: Number(row.machines_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function repoListMachineFamilies(params: { includeInactive: boolean }): Promise<MachineFamilyDTO[]> {
  const res = await db.query(
    `SELECT ${FAMILY_COLS},
            (SELECT COUNT(*) FROM public.machines m
              WHERE m.machine_family_code = f.code AND m.archived_at IS NULL) AS machines_count
       FROM public.production_machine_families f
      WHERE ($1::boolean OR f.actif)
      ORDER BY f.ordre_affichage, f.code`,
    [params.includeInactive]
  );
  return res.rows.map(mapFamily);
}

export async function repoGetMachineFamily(code: string): Promise<MachineFamilyDTO | null> {
  const res = await db.query(
    `SELECT ${FAMILY_COLS},
            (SELECT COUNT(*) FROM public.machines m
              WHERE m.machine_family_code = f.code AND m.archived_at IS NULL) AS machines_count
       FROM public.production_machine_families f WHERE f.code = $1`,
    [code]
  );
  const row = res.rows[0];
  return row ? mapFamily(row) : null;
}

export type CreateMachineFamilyInput = {
  code: string;
  libelle: string;
  description?: string | null;
  programme_requis?: boolean;
  est_favori?: boolean;
  ordre_affichage?: number;
};

/** Le référentiel s'étend par INSERT : aucun enum PostgreSQL à faire évoluer. */
export async function repoCreateMachineFamily(
  input: CreateMachineFamilyInput,
  audit: AuditContext
): Promise<MachineFamilyDTO> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query(`SELECT 1 FROM public.production_machine_families WHERE code = $1`, [input.code]);
    if ((exists.rowCount ?? 0) > 0) {
      throw new HttpError(409, "MACHINE_FAMILY_ALREADY_EXISTS", `La famille ${input.code} existe déjà.`);
    }
    await client.query(
      `INSERT INTO public.production_machine_families
         (code, libelle, description, programme_requis, est_favori, ordre_affichage, actif, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7)`,
      [
        input.code,
        input.libelle,
        input.description ?? null,
        input.programme_requis ?? false,
        input.est_favori ?? false,
        input.ordre_affichage ?? 100,
        audit.user_id,
      ]
    );
    await insertAudit(client, audit, "methodes.famille_machine.create", "machine_family", input.code, {
      libelle: input.libelle,
      programme_requis: input.programme_requis ?? false,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return (await repoGetMachineFamily(input.code)) as MachineFamilyDTO;
}

export type UpdateMachineFamilyInput = {
  libelle?: string;
  description?: string | null;
  programme_requis?: boolean;
  est_favori?: boolean;
  ordre_affichage?: number;
  actif?: boolean;
};

/**
 * Le CODE d'une famille n'est jamais modifié : il est référencé par les
 * machines, les centres de frais et les opérations déjà saisies. Une famille
 * qui ne sert plus se désactive (`actif = false`) et reste lisible.
 */
export async function repoUpdateMachineFamily(
  code: string,
  input: UpdateMachineFamilyInput,
  audit: AuditContext
): Promise<MachineFamilyDTO | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT code FROM public.production_machine_families WHERE code = $1 FOR UPDATE`, [
      code,
    ]);
    if (current.rowCount === 0) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.libelle !== undefined) push("libelle", input.libelle);
    if (input.description !== undefined) push("description", input.description);
    if (input.programme_requis !== undefined) push("programme_requis", input.programme_requis);
    if (input.est_favori !== undefined) push("est_favori", input.est_favori);
    if (input.ordre_affichage !== undefined) push("ordre_affichage", input.ordre_affichage);
    if (input.actif !== undefined) push("actif", input.actif);
    values.push(audit.user_id);
    sets.push(`updated_by = $${values.length}`);
    sets.push("updated_at = now()");
    values.push(code);

    await client.query(
      `UPDATE public.production_machine_families SET ${sets.join(", ")} WHERE code = $${values.length}`,
      values
    );
    await insertAudit(client, audit, "methodes.famille_machine.update", "machine_family", code, { ...input });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return repoGetMachineFamily(code);
}

/* -------------------------------------------------------------------------- */
/* 2) Centres de frais + tarifs versionnés                                    */
/* -------------------------------------------------------------------------- */

const COST_CENTER_COLS = `
  cf.id::text AS id, cf.code, cf.designation, cf.type_cf, cf.section,
  cf.machine_family_code, cf.statut, cf.devise, cf.designation_auto, cf.designation_modele,
  cf.commentaire, cf.archived_at::text AS archived_at,
  cf.created_at::text AS created_at, cf.updated_at::text AS updated_at,
  fam.libelle AS machine_family_libelle
`;

// Tarif applicable AUJOURD'HUI, en une seule requête : la vérité du taux ne se
// reconstitue pas côté Node à partir d'une liste partielle.
const CURRENT_RATE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT r.id, r.taux_horaire, r.date_effet
      FROM public.production_cost_center_rates r
     WHERE r.cf_id = cf.id
       AND r.date_effet <= CURRENT_DATE
       AND (r.date_fin IS NULL OR r.date_fin >= CURRENT_DATE)
     ORDER BY r.date_effet DESC
     LIMIT 1
  ) rate ON true
`;

function mapCostCenter(row: Record<string, unknown>): CostCenterDTO {
  const taux = toNumber(row.taux_horaire);
  return {
    id: String(row.id),
    code: String(row.code),
    designation: String(row.designation),
    type_cf: (row.type_cf as string | null) ?? null,
    section: (row.section as string | null) ?? null,
    machine_family_code: (row.machine_family_code as string | null) ?? null,
    machine_family_libelle: (row.machine_family_libelle as string | null) ?? null,
    statut: String(row.statut ?? "ACTIF"),
    devise: String(row.devise ?? "EUR"),
    designation_auto: Boolean(row.designation_auto),
    designation_modele: (row.designation_modele as string | null) ?? null,
    commentaire: (row.commentaire as string | null) ?? null,
    archived_at: (row.archived_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: (row.updated_at as string | null) ?? null,
    taux_horaire: taux,
    taux_statut: taux === null ? "ABSENT" : "CENTRE_FRAIS",
    taux_date_effet: (row.taux_date_effet as string | null) ?? null,
    taux_id: (row.taux_id as string | null) ?? null,
    taux_historique_count: Number(row.taux_historique_count ?? 0),
    machines_count: Number(row.machines_count ?? 0),
  };
}

export type ListCostCentersParams = {
  search: string | null;
  statut: string | null;
  machine_family_code: string | null;
  include_archived: boolean;
};

export async function repoListCostCenters(params: ListCostCentersParams): Promise<CostCenterDTO[]> {
  const res = await db.query(
    `SELECT ${COST_CENTER_COLS},
            rate.taux_horaire,
            rate.date_effet::text AS taux_date_effet,
            rate.id::text         AS taux_id,
            (SELECT COUNT(*) FROM public.production_cost_center_rates r WHERE r.cf_id = cf.id) AS taux_historique_count,
            (SELECT COUNT(*) FROM public.machines m WHERE m.cf_id = cf.id AND m.archived_at IS NULL) AS machines_count
       FROM public.centres_frais cf
       LEFT JOIN public.production_machine_families fam ON fam.code = cf.machine_family_code
       ${CURRENT_RATE_LATERAL}
      WHERE ($1::text IS NULL OR cf.code ILIKE '%' || $1 || '%' OR cf.designation ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR cf.statut = $2)
        AND ($3::text IS NULL OR cf.machine_family_code = $3)
        AND ($4::boolean OR cf.archived_at IS NULL)
      ORDER BY cf.code`,
    [params.search, params.statut, params.machine_family_code, params.include_archived]
  );
  return res.rows.map(mapCostCenter);
}

export async function repoGetCostCenter(cfId: string): Promise<CostCenterDTO | null> {
  const res = await db.query(
    `SELECT ${COST_CENTER_COLS},
            rate.taux_horaire,
            rate.date_effet::text AS taux_date_effet,
            rate.id::text         AS taux_id,
            (SELECT COUNT(*) FROM public.production_cost_center_rates r WHERE r.cf_id = cf.id) AS taux_historique_count,
            (SELECT COUNT(*) FROM public.machines m WHERE m.cf_id = cf.id AND m.archived_at IS NULL) AS machines_count
       FROM public.centres_frais cf
       LEFT JOIN public.production_machine_families fam ON fam.code = cf.machine_family_code
       ${CURRENT_RATE_LATERAL}
      WHERE cf.id = $1`,
    [cfId]
  );
  const row = res.rows[0];
  return row ? mapCostCenter(row) : null;
}

export type CreateCostCenterInput = {
  code: string;
  designation: string;
  type_cf?: string | null;
  section?: string | null;
  machine_family_code?: string | null;
  statut?: string;
  devise?: string;
  designation_auto?: boolean;
  designation_modele?: string | null;
  commentaire?: string | null;
};

export async function repoCreateCostCenter(input: CreateCostCenterInput, audit: AuditContext): Promise<CostCenterDTO> {
  if (input.designation_modele) assertDesignationTemplateAllowed(input.designation_modele);

  const client = await db.connect();
  let createdId: string;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(`SELECT 1 FROM public.centres_frais WHERE upper(btrim(code)) = upper(btrim($1))`, [
      input.code,
    ]);
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new HttpError(409, "COST_CENTER_CODE_TAKEN", `Le code de centre de frais ${input.code} est déjà utilisé.`);
    }
    const res = await client.query<{ id: string }>(
      `INSERT INTO public.centres_frais
         (code, designation, type_cf, section, machine_family_code, statut, devise,
          designation_auto, designation_modele, commentaire, created_by, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11, now())
       RETURNING id::text AS id`,
      [
        input.code.trim(),
        input.designation.trim(),
        input.type_cf ?? null,
        input.section ?? null,
        input.machine_family_code ?? null,
        input.statut ?? "ACTIF",
        input.devise ?? "EUR",
        input.designation_auto ?? false,
        input.designation_modele ?? null,
        input.commentaire ?? null,
        audit.user_id,
      ]
    );
    createdId = res.rows[0].id;
    await insertAudit(client, audit, "methodes.centre_frais.create", "cost_center", createdId, {
      code: input.code,
      machine_family_code: input.machine_family_code ?? null,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return (await repoGetCostCenter(createdId)) as CostCenterDTO;
}

export type UpdateCostCenterInput = Partial<Omit<CreateCostCenterInput, "code">> & {
  code?: string;
  expected_updated_at?: string | null;
};

export async function repoUpdateCostCenter(
  cfId: string,
  input: UpdateCostCenterInput,
  audit: AuditContext
): Promise<CostCenterDTO | null> {
  if (input.designation_modele) assertDesignationTemplateAllowed(input.designation_modele);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ updated_at: string | null; created_at: string; code: string }>(
      `SELECT updated_at::text AS updated_at, created_at::text AS created_at, code
         FROM public.centres_frais WHERE id = $1 FOR UPDATE`,
      [cfId]
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    // `centres_frais.updated_at` est nullable historiquement : la création fait
    // foi tant qu'aucune modification n'a eu lieu.
    assertOptimisticVersion({
      expectedUpdatedAt: input.expected_updated_at,
      currentUpdatedAt: row.updated_at ?? row.created_at,
      label: "le centre de frais",
    });

    if (input.code !== undefined && input.code.trim().toUpperCase() !== row.code.trim().toUpperCase()) {
      const duplicate = await client.query(
        `SELECT 1 FROM public.centres_frais WHERE upper(btrim(code)) = upper(btrim($1)) AND id <> $2`,
        [input.code, cfId]
      );
      if ((duplicate.rowCount ?? 0) > 0) {
        throw new HttpError(409, "COST_CENTER_CODE_TAKEN", `Le code de centre de frais ${input.code} est déjà utilisé.`);
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.code !== undefined) push("code", input.code.trim());
    if (input.designation !== undefined) push("designation", input.designation.trim());
    if (input.type_cf !== undefined) push("type_cf", input.type_cf);
    if (input.section !== undefined) push("section", input.section);
    if (input.machine_family_code !== undefined) push("machine_family_code", input.machine_family_code);
    if (input.statut !== undefined) {
      push("statut", input.statut);
      push("archived_at", input.statut === "ARCHIVE" ? new Date().toISOString() : null);
    }
    if (input.devise !== undefined) push("devise", input.devise);
    if (input.designation_auto !== undefined) push("designation_auto", input.designation_auto);
    if (input.designation_modele !== undefined) push("designation_modele", input.designation_modele);
    if (input.commentaire !== undefined) push("commentaire", input.commentaire);
    values.push(audit.user_id);
    sets.push(`updated_by = $${values.length}`);
    sets.push("updated_at = now()");
    values.push(cfId);

    await client.query(`UPDATE public.centres_frais SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
    await insertAudit(client, audit, "methodes.centre_frais.update", "cost_center", cfId, { ...input });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return repoGetCostCenter(cfId);
}

function mapRate(row: Record<string, unknown>, at: string): CostCenterRateDTO {
  const dateEffet = String(row.date_effet);
  const dateFin = (row.date_fin as string | null) ?? null;
  return {
    id: String(row.id),
    cf_id: String(row.cf_id),
    taux_horaire: toNumber(row.taux_horaire) ?? 0,
    devise: String(row.devise),
    date_effet: dateEffet,
    date_fin: dateFin,
    source: String(row.source),
    commentaire: (row.commentaire as string | null) ?? null,
    superseded_at: (row.superseded_at as string | null) ?? null,
    superseded_by: (row.superseded_by as string | null) ?? null,
    created_at: String(row.created_at),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    en_vigueur: dateEffet <= at && (dateFin === null || dateFin >= at),
  };
}

const RATE_COLS = `
  id::text AS id, cf_id::text AS cf_id, taux_horaire, devise,
  date_effet::text AS date_effet, date_fin::text AS date_fin, source, commentaire,
  superseded_at::text AS superseded_at, superseded_by::text AS superseded_by,
  created_at::text AS created_at, created_by
`;

/** Historique complet, du plus récent au plus ancien. Rien n'est masqué. */
export async function repoListCostCenterRates(cfId: string): Promise<CostCenterRateDTO[]> {
  const exists = await db.query(`SELECT 1 FROM public.centres_frais WHERE id = $1`, [cfId]);
  if (exists.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Centre de frais introuvable");
  const res = await db.query(
    `SELECT ${RATE_COLS} FROM public.production_cost_center_rates
      WHERE cf_id = $1 ORDER BY date_effet DESC, created_at DESC`,
    [cfId]
  );
  const at = today();
  return res.rows.map((row) => mapRate(row, at));
}

export type AddCostCenterRateInput = {
  taux_horaire: number;
  devise?: string;
  date_effet: string;
  source: string;
  commentaire?: string | null;
};

/**
 * Ajoute un tarif. Le tarif ouvert n'est PAS écrasé : il est clos la veille de
 * la nouvelle date d'effet et pointe vers son successeur. L'historique reste
 * intégralement lisible.
 */
export async function repoAddCostCenterRate(
  cfId: string,
  input: AddCostCenterRateInput,
  audit: AuditContext
): Promise<CostCenterRateDTO[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cf = await client.query<{ devise: string }>(
      `SELECT devise FROM public.centres_frais WHERE id = $1 FOR UPDATE`,
      [cfId]
    );
    if (cf.rowCount === 0) {
      await client.query("ROLLBACK").catch(() => {});
      throw new HttpError(404, "NOT_FOUND", "Centre de frais introuvable");
    }

    const openRes = await client.query(
      `SELECT ${RATE_COLS} FROM public.production_cost_center_rates
        WHERE cf_id = $1 AND date_fin IS NULL
        ORDER BY date_effet DESC LIMIT 1`,
      [cfId]
    );
    const openRow = openRes.rows[0];
    const openRate: CostCenterRate | null = openRow
      ? {
          id: String(openRow.id),
          taux_horaire: toNumber(openRow.taux_horaire) ?? 0,
          devise: String(openRow.devise),
          date_effet: String(openRow.date_effet),
          date_fin: null,
        }
      : null;

    assertRateSupersedes(openRate, input.date_effet);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.production_cost_center_rates
         (cf_id, taux_horaire, devise, date_effet, source, commentaire, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id::text AS id`,
      [
        cfId,
        input.taux_horaire,
        input.devise ?? cf.rows[0].devise ?? "EUR",
        input.date_effet,
        input.source.trim(),
        input.commentaire ?? null,
        audit.user_id,
      ]
    );

    if (openRate) {
      await client.query(
        `UPDATE public.production_cost_center_rates
            SET date_fin = ($2::date - INTERVAL '1 day')::date,
                superseded_at = now(),
                superseded_by = $3
          WHERE id = $1`,
        [openRate.id, input.date_effet, inserted.rows[0].id]
      );
    }

    await insertAudit(client, audit, "methodes.centre_frais.tarif.create", "cost_center_rate", inserted.rows[0].id, {
      cf_id: cfId,
      taux_horaire: input.taux_horaire,
      date_effet: input.date_effet,
      source: input.source,
      remplace: openRate?.id ?? null,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return repoListCostCenterRates(cfId);
}

/** Tarif applicable à une date, pour le gel du snapshot d'opération. */
export async function repoResolveCostCenterRate(
  tx: Pick<PoolClient, "query">,
  cfId: string,
  at: string
): Promise<CostCenterRate | null> {
  const res = await tx.query(
    `SELECT id::text AS id, taux_horaire, devise, date_effet::text AS date_effet, date_fin::text AS date_fin
       FROM public.production_cost_center_rates
      WHERE cf_id = $1 AND date_effet <= $2::date AND (date_fin IS NULL OR date_fin >= $2::date)`,
    [cfId, at]
  );
  const rates: CostCenterRate[] = res.rows.map((row) => ({
    id: String(row.id),
    taux_horaire: toNumber(row.taux_horaire) ?? 0,
    devise: String(row.devise),
    date_effet: String(row.date_effet),
    date_fin: (row.date_fin as string | null) ?? null,
  }));
  return pickApplicableRate(rates, at);
}

/* -------------------------------------------------------------------------- */
/* 3) Sélecteur de machines                                                   */
/* -------------------------------------------------------------------------- */

export type ListMachineOptionsParams = {
  machine_family_code: string | null;
  search: string | null;
  /** `true` = renvoyer aussi les machines non sélectionnables, en les marquant. */
  include_unselectable: boolean;
};

/**
 * Sélecteur de machines pour l'éditeur de gamme.
 *
 * `machine_family_code` filtre sur le RÉFÉRENTIEL, jamais sur le libellé ni sur
 * le code : une machine dont la famille n'est pas renseignée n'apparaît sous
 * aucune famille, et l'interface affiche « famille non renseignée » plutôt que
 * de la ranger au hasard.
 */
export async function repoListMachineOptions(params: ListMachineOptionsParams): Promise<MachineOptionDTO[]> {
  const res = await db.query(
    `SELECT m.id::text AS id, m.code, m.name, m.display_name,
            m.machine_family_code, fam.libelle AS machine_family_libelle,
            m.cf_id::text AS cf_id, cf.code AS cf_code,
            m.status::text AS status, m.is_available,
            m.valid_from::text AS valid_from, m.valid_to::text AS valid_to,
            m.archived_at::text AS archived_at
       FROM public.machines m
       LEFT JOIN public.production_machine_families fam ON fam.code = m.machine_family_code
       LEFT JOIN public.centres_frais cf ON cf.id = m.cf_id
      WHERE m.archived_at IS NULL
        AND ($1::text IS NULL OR m.machine_family_code = $1)
        AND ($2::text IS NULL OR m.code ILIKE '%' || $2 || '%' OR m.name ILIKE '%' || $2 || '%')
      ORDER BY fam.ordre_affichage NULLS LAST, m.code`,
    [params.machine_family_code, params.search]
  );

  const at = today();
  const options: MachineOptionDTO[] = res.rows.map((row) => {
    const status = String(row.status);
    const validFrom = (row.valid_from as string | null) ?? null;
    const validTo = (row.valid_to as string | null) ?? null;
    let reason: string | null = null;
    if (status !== "ACTIVE") reason = `Machine ${status === "IN_MAINTENANCE" ? "en maintenance" : "hors service"}.`;
    else if (validFrom && at < validFrom) reason = `Valide à partir du ${validFrom}.`;
    else if (validTo && at > validTo) reason = `Hors service depuis le ${validTo}.`;
    return {
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      display_name: (row.display_name as string | null) ?? null,
      machine_family_code: (row.machine_family_code as string | null) ?? null,
      machine_family_libelle: (row.machine_family_libelle as string | null) ?? null,
      cf_id: (row.cf_id as string | null) ?? null,
      cf_code: (row.cf_code as string | null) ?? null,
      status,
      is_available: Boolean(row.is_available),
      valid_from: validFrom,
      valid_to: validTo,
      selectable: reason === null,
      unselectable_reason: reason,
    };
  });

  return params.include_unselectable ? options : options.filter((option) => option.selectable);
}
