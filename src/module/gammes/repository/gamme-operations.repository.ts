// Opérations de gamme — création, modification, suppression, numérotation,
// réordonnancement et publication.
//
// Ce fichier applique la politique `methodes-policy.ts` ; il ne la redéfinit
// pas. Rappels structurants :
//   - `phase` = numéro d'opération MÉTIER, jamais renuméroté par un reorder ;
//   - `ordre` = position d'affichage, seule valeur touchée par le reorder ;
//   - les temps sont stockés en HEURES DÉCIMALES, saisis en minutes ;
//   - `taux_horaire` est FIGÉ depuis le tarif du centre de frais, jamais saisi ;
//   - `temps_total` et `cout_mo` sont CALCULÉS, jamais reçus du client.

import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  assertGammeEditable,
  assertGammePublishable,
  assertMachineFamilyConsistent,
  assertMachineSelectable,
  assertOptimisticVersion,
  assertPhaseAvailable,
  assertCostCenterSelectable,
  assertFamilySelectable,
  assertProgramNumberRequirement,
  collectPublicationBlockers,
  computeLabourCost,
  computeOperationTimes,
  hoursToMinutes,
  minutesToHours,
  nextPhaseNumber,
  normalizeProgramNumber,
  resolveOperationDesignation,
  suggestInsertPhase,
  toIsoDate,
  type CostCenterRef,
  type MachineFamilyRef,
  type MachineRef,
} from "../../methodes/domain/methodes-policy";
import { repoResolveCostCenterRate } from "../../methodes/repository/methodes.repository";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import type { OperationTypeDTO } from "../validators/gammes.validators";

/* -------------------------------------------------------------------------- */
/* Colonnes et DTO                                                            */
/* -------------------------------------------------------------------------- */

export const OP_COLS = `
  o.id::text AS id, o.piece_technique_id::text AS piece_technique_id, o.gamme_id::text AS gamme_id,
  o.ordre, o.phase, o.designation, o.designation_2, o.designation_auto, o.type_operation,
  o.machine_id::text AS machine_id, o.poste_id::text AS poste_id, o.cf_id::text AS cf_id,
  o.machine_family_code, o.numero_programme,
  o.tp::float8 AS tp, o.tf_unit::float8 AS tf_unit, o.qte::float8 AS qte, o.coef::float8 AS coef,
  o.taux_horaire::float8 AS taux_horaire, o.taux_horaire_source, o.taux_horaire_effective_at::text AS taux_horaire_effective_at,
  o.taux_horaire_legacy::float8 AS taux_horaire_legacy, o.cf_rate_id::text AS cf_rate_id,
  o.prix::float8 AS prix, o.temps_fabrication::float8 AS temps_fabrication,
  o.temps_total::float8 AS temps_total, o.cout_mo::float8 AS cout_mo, o.consignes,
  o.updated_at::text AS updated_at, o.created_at::text AS created_at
`;

const OP_JOINS = `
  LEFT JOIN public.centres_frais cf ON cf.id = o.cf_id
  LEFT JOIN public.production_machine_families fam ON fam.code = o.machine_family_code
  LEFT JOIN public.machines m ON m.id = o.machine_id
`;

const OP_JOIN_COLS = `
  cf.code AS cf_code, cf.designation AS cf_designation, cf.devise AS cf_devise,
  fam.libelle AS machine_family_libelle, fam.programme_requis AS famille_programme_requis,
  m.code AS machine_code, m.name AS machine_name, m.status::text AS machine_status,
  m.archived_at::text AS machine_archived_at,
  m.valid_from::text AS machine_valid_from, m.valid_to::text AS machine_valid_to
`;

export type GammeOperationDTO = {
  id: string;
  piece_technique_id: string;
  gamme_id: string | null;
  ordre: number | null;
  phase: number | null;
  designation: string;
  designation_2: string | null;
  designation_auto: boolean;
  type_operation: OperationTypeDTO | null;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  machine_status: string | null;
  /** `true` si la machine posée n'est plus sélectionnable aujourd'hui. */
  machine_obsolete: boolean;
  poste_id: string | null;
  cf_id: string | null;
  cf_code: string | null;
  cf_designation: string | null;
  machine_family_code: string | null;
  machine_family_libelle: string | null;
  famille_programme_requis: boolean;
  numero_programme: string | null;
  /* Heures décimales — unité de stockage. */
  tp: number;
  tf_unit: number;
  qte: number;
  coef: number;
  temps_fabrication: number;
  temps_total: number;
  /* Minutes — unité de saisie et d'affichage. */
  temps_preparation_minutes: number | null;
  temps_unitaire_minutes: number | null;
  temps_fabrication_minutes: number | null;
  temps_final_minutes: number | null;
  /* Coûts. `null` = inconnu, jamais 0 par défaut. */
  taux_horaire: number | null;
  taux_horaire_source: string | null;
  taux_horaire_effective_at: string | null;
  taux_horaire_legacy: number | null;
  cf_rate_id: string | null;
  cout_mo: number | null;
  devise: string | null;
  prix: number | null;
  consignes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function toNum(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapOperation(row: Record<string, unknown>, at: string): GammeOperationDTO {
  const tauxSource = (row.taux_horaire_source as string | null) ?? null;
  const tauxConnu = tauxSource === "ABSENT" || tauxSource === null ? null : toNum(row.taux_horaire, 0);
  const tempsTotal = toNum(row.temps_total, 0);
  const machineStatus = (row.machine_status as string | null) ?? null;
  const machineArchived = (row.machine_archived_at as string | null) ?? null;
  const validFrom = (row.machine_valid_from as string | null) ?? null;
  const validTo = (row.machine_valid_to as string | null) ?? null;
  // Une machine devenue inutilisable n'est pas retirée de l'opération : on le
  // SIGNALE, l'historique de la gamme n'est pas réécrit dans le dos des Méthodes.
  const machineObsolete =
    Boolean(row.machine_id) &&
    (machineArchived !== null ||
      (machineStatus !== null && machineStatus !== "ACTIVE") ||
      (validFrom !== null && at < validFrom) ||
      (validTo !== null && at > validTo));

  return {
    id: String(row.id),
    piece_technique_id: String(row.piece_technique_id),
    gamme_id: (row.gamme_id as string | null) ?? null,
    ordre: row.ordre === null || row.ordre === undefined ? null : Number(row.ordre),
    phase: row.phase === null || row.phase === undefined ? null : Number(row.phase),
    designation: String(row.designation ?? ""),
    designation_2: (row.designation_2 as string | null) ?? null,
    designation_auto: Boolean(row.designation_auto),
    type_operation: (row.type_operation as OperationTypeDTO | null) ?? null,
    machine_id: (row.machine_id as string | null) ?? null,
    machine_code: (row.machine_code as string | null) ?? null,
    machine_name: (row.machine_name as string | null) ?? null,
    machine_status: machineStatus,
    machine_obsolete: machineObsolete,
    poste_id: (row.poste_id as string | null) ?? null,
    cf_id: (row.cf_id as string | null) ?? null,
    cf_code: (row.cf_code as string | null) ?? null,
    cf_designation: (row.cf_designation as string | null) ?? null,
    machine_family_code: (row.machine_family_code as string | null) ?? null,
    machine_family_libelle: (row.machine_family_libelle as string | null) ?? null,
    famille_programme_requis: Boolean(row.famille_programme_requis),
    numero_programme: (row.numero_programme as string | null) ?? null,
    tp: toNum(row.tp, 0),
    tf_unit: toNum(row.tf_unit, 0),
    qte: toNum(row.qte, 1),
    coef: toNum(row.coef, 1),
    temps_fabrication: toNum(row.temps_fabrication, 0),
    temps_total: tempsTotal,
    temps_preparation_minutes: hoursToMinutes(toNum(row.tp, 0)),
    temps_unitaire_minutes: hoursToMinutes(toNum(row.tf_unit, 0)),
    temps_fabrication_minutes: hoursToMinutes(toNum(row.temps_fabrication, 0)),
    temps_final_minutes: hoursToMinutes(tempsTotal),
    taux_horaire: tauxConnu,
    taux_horaire_source: tauxSource,
    taux_horaire_effective_at: (row.taux_horaire_effective_at as string | null) ?? null,
    taux_horaire_legacy: row.taux_horaire_legacy === null || row.taux_horaire_legacy === undefined ? null : toNum(row.taux_horaire_legacy),
    cf_rate_id: (row.cf_rate_id as string | null) ?? null,
    cout_mo: computeLabourCost(tempsTotal, tauxConnu),
    devise: (row.cf_devise as string | null) ?? null,
    prix: row.prix === null || row.prix === undefined ? null : toNum(row.prix),
    consignes: (row.consignes as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Contexte de gamme et référentiels                                          */
/* -------------------------------------------------------------------------- */

type GammeContext = {
  gamme_id: string;
  piece_technique_id: string;
  piece_technique_version_id: string;
  statut: string;
  updated_at: string;
};

async function loadGammeContext(tx: Pick<PoolClient, "query">, gammeId: string, lock: boolean): Promise<GammeContext> {
  const res = await tx.query<GammeContext>(
    `SELECT g.id::text AS gamme_id, ptv.piece_technique_id::text AS piece_technique_id,
            g.piece_technique_version_id::text AS piece_technique_version_id,
            g.statut, g.updated_at::text AS updated_at
       FROM public.gammes g
       JOIN public.piece_technique_versions ptv ON ptv.id = g.piece_technique_version_id
      WHERE g.id = $1
      ${lock ? "FOR UPDATE OF g" : ""}`,
    [gammeId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable");
  return row;
}

async function loadFamily(tx: Pick<PoolClient, "query">, code: string | null): Promise<MachineFamilyRef | null> {
  if (!code) return null;
  const res = await tx.query(
    `SELECT code, libelle, programme_requis, actif FROM public.production_machine_families WHERE code = $1`,
    [code]
  );
  const row = res.rows[0];
  return row
    ? {
        code: String(row.code),
        libelle: String(row.libelle),
        programme_requis: Boolean(row.programme_requis),
        actif: Boolean(row.actif),
      }
    : null;
}

async function loadMachine(tx: Pick<PoolClient, "query">, machineId: string | null): Promise<MachineRef | null> {
  if (!machineId) return null;
  const res = await tx.query(
    `SELECT id::text AS id, code, name, status::text AS status, archived_at::text AS archived_at,
            valid_from::text AS valid_from, valid_to::text AS valid_to, machine_family_code
       FROM public.machines WHERE id = $1`,
    [machineId]
  );
  const row = res.rows[0];
  return row
    ? {
        id: String(row.id),
        code: String(row.code),
        name: String(row.name),
        status: String(row.status),
        archived_at: (row.archived_at as string | null) ?? null,
        valid_from: (row.valid_from as string | null) ?? null,
        valid_to: (row.valid_to as string | null) ?? null,
        machine_family_code: (row.machine_family_code as string | null) ?? null,
      }
    : null;
}

async function loadCostCenter(tx: Pick<PoolClient, "query">, cfId: string | null): Promise<CostCenterRef | null> {
  if (!cfId) return null;
  const res = await tx.query(
    `SELECT id::text AS id, code, designation, statut, devise, machine_family_code,
            designation_auto, designation_modele
       FROM public.centres_frais WHERE id = $1`,
    [cfId]
  );
  const row = res.rows[0];
  return row
    ? {
        id: String(row.id),
        code: String(row.code),
        designation: String(row.designation),
        statut: String(row.statut ?? "ACTIF"),
        devise: String(row.devise ?? "EUR"),
        machine_family_code: (row.machine_family_code as string | null) ?? null,
        designation_auto: Boolean(row.designation_auto),
        designation_modele: (row.designation_modele as string | null) ?? null,
      }
    : null;
}

async function loadFamilyMap(tx: Pick<PoolClient, "query">): Promise<Map<string, MachineFamilyRef>> {
  const res = await tx.query(`SELECT code, libelle, programme_requis, actif FROM public.production_machine_families`);
  const map = new Map<string, MachineFamilyRef>();
  for (const row of res.rows) {
    map.set(String(row.code), {
      code: String(row.code),
      libelle: String(row.libelle),
      programme_requis: Boolean(row.programme_requis),
      actif: Boolean(row.actif),
    });
  }
  return map;
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
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

export async function repoListGammeOperations(gammeId: string): Promise<GammeOperationDTO[]> {
  const gamme = await db.query(`SELECT 1 FROM public.gammes WHERE id = $1`, [gammeId]);
  if (gamme.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable");
  const res = await db.query(
    `SELECT ${OP_COLS}, ${OP_JOIN_COLS}
       FROM public.pieces_techniques_operations o
       ${OP_JOINS}
      WHERE o.gamme_id = $1
      ORDER BY o.ordre NULLS LAST, o.phase NULLS LAST, o.id`,
    [gammeId]
  );
  const at = toIsoDate(new Date());
  return res.rows.map((row) => mapOperation(row, at));
}

export type NextPhaseResult = {
  /** Phase proposée. `null` = aucun entier libre : renumérotation explicite requise. */
  phase: number | null;
  mode: "APPEND" | "INSERT";
  phase_before: number | null;
  phase_after: number | null;
  message: string | null;
};

/**
 * Prochaine phase. Sans `afterOperationId` : `max(phase) + 10`. Avec : un
 * entier libre entre l'opération visée et la suivante — sans jamais décaler
 * les phases existantes.
 */
export async function repoNextPhase(gammeId: string, afterOperationId: string | null): Promise<NextPhaseResult> {
  const gamme = await db.query(`SELECT 1 FROM public.gammes WHERE id = $1`, [gammeId]);
  if (gamme.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable");

  const res = await db.query<{ id: string; phase: number | null }>(
    `SELECT id::text AS id, phase FROM public.pieces_techniques_operations
      WHERE gamme_id = $1 ORDER BY phase NULLS LAST, ordre NULLS LAST, id`,
    [gammeId]
  );
  const rows = res.rows;

  if (!afterOperationId) {
    return {
      phase: nextPhaseNumber(rows.map((row) => row.phase)),
      mode: "APPEND",
      phase_before: rows.length > 0 ? rows[rows.length - 1].phase : null,
      phase_after: null,
      message: null,
    };
  }

  const index = rows.findIndex((row) => row.id === afterOperationId);
  if (index < 0) throw new HttpError(404, "NOT_FOUND", "Opération de référence introuvable dans cette gamme");
  const before = rows[index]?.phase ?? null;
  const after = rows[index + 1]?.phase ?? null;
  const phase = suggestInsertPhase(before, after);
  return {
    phase,
    mode: "INSERT",
    phase_before: before,
    phase_after: after,
    message:
      phase === null
        ? `Aucun numéro libre entre ${before} et ${after} : choisissez un autre point d'insertion ou renumérotez explicitement les phases.`
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Écriture                                                                   */
/* -------------------------------------------------------------------------- */

export type OperationWriteInput = {
  numero_operation?: number | null;
  /** Insertion contrôlée : la phase est calculée APRÈS cette opération. */
  insert_after_operation_id?: string | null;
  designation?: string | null;
  designation_2?: string | null;
  type_operation?: OperationTypeDTO | null;
  machine_family_code?: string | null;
  machine_id?: string | null;
  poste_id?: string | null;
  cf_id?: string | null;
  numero_programme?: string | null;
  /** Unité de saisie de l'interface. Prioritaire sur la variante en heures. */
  temps_preparation_minutes?: number | null;
  temps_unitaire_minutes?: number | null;
  /** Contrat historique, en heures décimales. Conservé pour les appelants existants. */
  temps_preparation?: number | null;
  temps_cycle?: number | null;
  qte?: number | null;
  coef?: number | null;
  prix?: number | null;
  consignes?: string | null;
  expected_updated_at?: string | null;
};

/**
 * Une durée peut arriver en minutes (interface) ou en heures (contrat
 * historique). Les deux ensemble et divergentes = erreur explicite : un doute
 * d'unité ne se tranche pas en silence.
 */
function resolveHours(
  minutes: number | null | undefined,
  hours: number | null | undefined,
  fallback: number,
  field: string
): number {
  const hasMinutes = minutes !== null && minutes !== undefined;
  const hasHours = hours !== null && hours !== undefined;
  if (hasMinutes && hasHours) {
    const fromMinutes = minutesToHours(minutes as number, field);
    if (Math.abs(fromMinutes - (hours as number)) > 1e-4) {
      throw new HttpError(
        422,
        "CONFLICTING_TIME_UNITS",
        `${field} est fourni à la fois en minutes et en heures avec deux valeurs différentes.`,
        { field, minutes, hours }
      );
    }
    return fromMinutes;
  }
  if (hasMinutes) return minutesToHours(minutes as number, field);
  if (hasHours) {
    if (!Number.isFinite(hours as number) || (hours as number) < 0) {
      throw new HttpError(422, "METHODES_NUMBER_INVALID", `Valeur invalide pour ${field}.`);
    }
    return hours as number;
  }
  return fallback;
}

type ResolvedOperation = {
  phase: number;
  designation: string;
  designation_auto: boolean;
  machine_family_code: string | null;
  machine_id: string | null;
  cf_id: string | null;
  numero_programme: string | null;
  tp: number;
  tf_unit: number;
  qte: number;
  coef: number;
  temps_fabrication: number;
  temps_total: number;
  taux_horaire: number;
  taux_horaire_source: "CENTRE_FRAIS" | "ABSENT";
  taux_horaire_effective_at: string | null;
  cf_rate_id: string | null;
  cout_mo: number;
};

type ExistingOperation = {
  id: string;
  phase: number | null;
  designation: string;
  designation_auto: boolean;
  machine_family_code: string | null;
  machine_id: string | null;
  cf_id: string | null;
  numero_programme: string | null;
  tp: number;
  tf_unit: number;
  qte: number;
  coef: number;
  type_operation: OperationTypeDTO | null;
};

/**
 * Cœur de la règle : résout famille, machine, centre de frais, tarif, temps,
 * désignation et phase, dans cet ordre, en refusant toute incohérence.
 */
async function resolveOperation(
  tx: Pick<PoolClient, "query">,
  gammeId: string,
  input: OperationWriteInput,
  existing: ExistingOperation | null
): Promise<ResolvedOperation> {
  const at = toIsoDate(new Date());

  // --- Machine, famille et centre de frais ---------------------------------
  const machineId =
    input.machine_id !== undefined ? input.machine_id : (existing?.machine_id ?? null);
  const cfId = input.cf_id !== undefined ? input.cf_id : (existing?.cf_id ?? null);
  const machine = await loadMachine(tx, machineId);
  const costCenter = await loadCostCenter(tx, cfId);

  assertCostCenterSelectable(costCenter, cfId);
  // Une machine déjà posée n'est revalidée que si l'appel la (re)désigne :
  // l'historique d'une opération existante n'est pas invalidé rétroactivement.
  if (input.machine_id !== undefined && input.machine_id !== null) {
    assertMachineSelectable(machine, machineId, at);
  }

  // La famille vient du choix explicite, sinon du RÉFÉRENTIEL de la machine,
  // sinon de celui du centre de frais. Jamais d'un libellé ni d'un code.
  const explicitFamily =
    input.machine_family_code !== undefined ? input.machine_family_code : (existing?.machine_family_code ?? null);
  const familyCode = explicitFamily ?? machine?.machine_family_code ?? costCenter?.machine_family_code ?? null;
  const family = await loadFamily(tx, familyCode);
  assertFamilySelectable(family, familyCode);
  assertMachineFamilyConsistent(machine, familyCode);

  // --- Numéro de programme -------------------------------------------------
  const programme =
    input.numero_programme !== undefined
      ? normalizeProgramNumber(input.numero_programme)
      : (existing?.numero_programme ?? null);
  assertProgramNumberRequirement({ family, numero_programme: programme });

  // --- Temps ---------------------------------------------------------------
  const tp = resolveHours(input.temps_preparation_minutes, input.temps_preparation, existing?.tp ?? 0, "temps de préparation");
  const tfUnit = resolveHours(input.temps_unitaire_minutes, input.temps_cycle, existing?.tf_unit ?? 0, "temps unitaire");
  const qte = input.qte === null || input.qte === undefined ? (existing?.qte ?? 1) : input.qte;
  const coef = input.coef === null || input.coef === undefined ? (existing?.coef ?? 1) : input.coef;
  const times = computeOperationTimes({
    temps_preparation: tp,
    temps_unitaire: tfUnit,
    quantite_base: qte,
    coefficient: coef,
  });

  // --- Tarif figé ----------------------------------------------------------
  const rate = cfId ? await repoResolveCostCenterRate(tx, cfId, at) : null;
  const tauxSource: "CENTRE_FRAIS" | "ABSENT" = rate ? "CENTRE_FRAIS" : "ABSENT";
  const taux = rate?.taux_horaire ?? 0;

  // --- Phase ---------------------------------------------------------------
  const phasesRes = await tx.query<{ id: string; phase: number | null }>(
    `SELECT id::text AS id, phase FROM public.pieces_techniques_operations
      WHERE gamme_id = $1 ORDER BY phase NULLS LAST, ordre NULLS LAST, id`,
    [gammeId]
  );
  const otherPhases = phasesRes.rows.filter((row) => row.id !== existing?.id).map((row) => row.phase);

  let phase: number;
  if (input.numero_operation !== null && input.numero_operation !== undefined) {
    phase = input.numero_operation;
  } else if (existing) {
    phase = existing.phase ?? nextPhaseNumber(otherPhases);
  } else if (input.insert_after_operation_id) {
    const rows = phasesRes.rows;
    const index = rows.findIndex((row) => row.id === input.insert_after_operation_id);
    if (index < 0) throw new HttpError(404, "NOT_FOUND", "Opération de référence introuvable dans cette gamme");
    const suggested = suggestInsertPhase(rows[index]?.phase ?? null, rows[index + 1]?.phase ?? null);
    if (suggested === null) {
      throw new HttpError(
        409,
        "PHASE_NO_ROOM",
        `Aucun numéro libre entre ${rows[index]?.phase} et ${rows[index + 1]?.phase} : choisissez un autre point d'insertion ou renumérotez explicitement.`
      );
    }
    phase = suggested;
  } else {
    phase = nextPhaseNumber(otherPhases);
  }
  assertPhaseAvailable(otherPhases, phase);

  // --- Désignation ---------------------------------------------------------
  const typeOperation =
    input.type_operation !== undefined ? input.type_operation : (existing?.type_operation ?? null);
  const saisie = input.designation !== undefined ? input.designation : (existing?.designation_auto ? null : existing?.designation ?? null);
  const designation = resolveOperationDesignation({
    saisie,
    costCenter,
    values: {
      cf_code: costCenter?.code ?? null,
      cf_designation: costCenter?.designation ?? null,
      famille_code: family?.code ?? null,
      famille_libelle: family?.libelle ?? null,
      machine_code: machine?.code ?? null,
      machine_nom: machine?.name ?? null,
      numero_programme: programme,
      phase,
      type_operation: typeOperation,
    },
  });

  return {
    phase,
    // La désignation peut rester vide EN BROUILLON ; la publication la refuse.
    designation: designation.designation ?? "",
    designation_auto: designation.designation_auto,
    machine_family_code: familyCode,
    machine_id: machineId,
    cf_id: cfId,
    numero_programme: programme,
    tp,
    tf_unit: tfUnit,
    qte,
    coef,
    temps_fabrication: times.temps_fabrication,
    temps_total: times.temps_final,
    taux_horaire: taux,
    taux_horaire_source: tauxSource,
    taux_horaire_effective_at: rate?.date_effet ?? null,
    cf_rate_id: rate?.id ?? null,
    cout_mo: computeLabourCost(times.temps_final, rate ? rate.taux_horaire : null) ?? 0,
  };
}

async function reloadOperation(operationId: string): Promise<GammeOperationDTO> {
  const res = await db.query(
    `SELECT ${OP_COLS}, ${OP_JOIN_COLS} FROM public.pieces_techniques_operations o ${OP_JOINS} WHERE o.id = $1`,
    [operationId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Opération introuvable");
  return mapOperation(row, toIsoDate(new Date()));
}

export async function repoCreateGammeOperation(
  gammeId: string,
  input: OperationWriteInput,
  audit: AuditContext
): Promise<GammeOperationDTO> {
  const client = await db.connect();
  let createdId: string;
  try {
    await client.query("BEGIN");
    const gamme = await loadGammeContext(client, gammeId, true);
    assertGammeEditable(gamme.statut);

    const resolved = await resolveOperation(client, gammeId, input, null);

    const ordreRes = await client.query<{ next_ordre: number }>(
      `SELECT COALESCE(MAX(ordre), 0) + 10 AS next_ordre FROM public.pieces_techniques_operations WHERE gamme_id = $1`,
      [gammeId]
    );

    const res = await client.query<{ id: string }>(
      `INSERT INTO public.pieces_techniques_operations
        (piece_technique_id, gamme_id, ordre, phase, designation, designation_2, designation_auto,
         type_operation, machine_id, poste_id, cf_id, machine_family_code, numero_programme,
         tp, tf_unit, qte, coef, taux_horaire, taux_horaire_source, taux_horaire_effective_at,
         cf_rate_id, prix, temps_fabrication, temps_total, cout_mo, consignes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$27)
       RETURNING id::text AS id`,
      [
        gamme.piece_technique_id,
        gammeId,
        ordreRes.rows[0]?.next_ordre ?? 10,
        resolved.phase,
        resolved.designation,
        input.designation_2 ?? null,
        resolved.designation_auto,
        input.type_operation ?? null,
        resolved.machine_id,
        input.poste_id ?? null,
        resolved.cf_id,
        resolved.machine_family_code,
        resolved.numero_programme,
        resolved.tp,
        resolved.tf_unit,
        resolved.qte,
        resolved.coef,
        resolved.taux_horaire,
        resolved.taux_horaire_source,
        resolved.taux_horaire_effective_at,
        resolved.cf_rate_id,
        input.prix ?? 0,
        resolved.temps_fabrication,
        resolved.temps_total,
        resolved.cout_mo,
        input.consignes ?? null,
        audit.user_id,
      ]
    );
    createdId = res.rows[0].id;
    await insertAudit(client, audit, "gammes.operations.create", "gamme_operation", createdId, {
      gamme_id: gammeId,
      phase: resolved.phase,
      machine_family_code: resolved.machine_family_code,
      numero_programme: resolved.numero_programme,
      taux_horaire_source: resolved.taux_horaire_source,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return reloadOperation(createdId);
}

export async function repoUpdateGammeOperation(
  gammeId: string,
  operationId: string,
  input: OperationWriteInput,
  audit: AuditContext
): Promise<GammeOperationDTO> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gamme = await loadGammeContext(client, gammeId, true);
    assertGammeEditable(gamme.statut);

    const currentRes = await client.query(
      `SELECT id::text AS id, gamme_id::text AS gamme_id, phase, designation, designation_auto,
              machine_family_code, machine_id::text AS machine_id, cf_id::text AS cf_id, numero_programme,
              tp::float8 AS tp, tf_unit::float8 AS tf_unit, qte::float8 AS qte, coef::float8 AS coef,
              type_operation, updated_at::text AS updated_at
         FROM public.pieces_techniques_operations WHERE id = $1 FOR UPDATE`,
      [operationId]
    );
    const current = currentRes.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Opération introuvable");
    if (current.gamme_id !== gammeId) {
      throw new HttpError(409, "OPERATION_GAMME_MISMATCH", "Cette opération n'appartient pas à la gamme indiquée.");
    }
    assertOptimisticVersion({
      expectedUpdatedAt: input.expected_updated_at,
      currentUpdatedAt: String(current.updated_at),
      label: "l'opération",
    });

    const existing: ExistingOperation = {
      id: String(current.id),
      phase: current.phase === null ? null : Number(current.phase),
      designation: String(current.designation ?? ""),
      designation_auto: Boolean(current.designation_auto),
      machine_family_code: (current.machine_family_code as string | null) ?? null,
      machine_id: (current.machine_id as string | null) ?? null,
      cf_id: (current.cf_id as string | null) ?? null,
      numero_programme: (current.numero_programme as string | null) ?? null,
      tp: toNum(current.tp, 0),
      tf_unit: toNum(current.tf_unit, 0),
      qte: toNum(current.qte, 1),
      coef: toNum(current.coef, 1),
      type_operation: (current.type_operation as OperationTypeDTO | null) ?? null,
    };

    const resolved = await resolveOperation(client, gammeId, input, existing);

    await client.query(
      `UPDATE public.pieces_techniques_operations SET
         phase = $2, designation = $3, designation_2 = COALESCE($4, designation_2), designation_auto = $5,
         type_operation = $6, machine_id = $7, poste_id = COALESCE($8, poste_id), cf_id = $9,
         machine_family_code = $10, numero_programme = $11,
         tp = $12, tf_unit = $13, qte = $14, coef = $15,
         taux_horaire = $16, taux_horaire_source = $17, taux_horaire_effective_at = $18, cf_rate_id = $19,
         prix = COALESCE($20, prix), temps_fabrication = $21, temps_total = $22, cout_mo = $23,
         consignes = COALESCE($24, consignes), updated_by = $25, updated_at = now()
       WHERE id = $1`,
      [
        operationId,
        resolved.phase,
        resolved.designation,
        input.designation_2 ?? null,
        resolved.designation_auto,
        input.type_operation !== undefined ? input.type_operation : existing.type_operation,
        resolved.machine_id,
        input.poste_id ?? null,
        resolved.cf_id,
        resolved.machine_family_code,
        resolved.numero_programme,
        resolved.tp,
        resolved.tf_unit,
        resolved.qte,
        resolved.coef,
        resolved.taux_horaire,
        resolved.taux_horaire_source,
        resolved.taux_horaire_effective_at,
        resolved.cf_rate_id,
        input.prix ?? null,
        resolved.temps_fabrication,
        resolved.temps_total,
        resolved.cout_mo,
        input.consignes ?? null,
        audit.user_id,
      ]
    );
    await insertAudit(client, audit, "gammes.operations.update", "gamme_operation", operationId, {
      gamme_id: gammeId,
      phase_avant: existing.phase,
      phase_apres: resolved.phase,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return reloadOperation(operationId);
}

export async function repoDeleteGammeOperation(
  gammeId: string,
  operationId: string,
  expectedUpdatedAt: string | null | undefined,
  audit: AuditContext
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gamme = await loadGammeContext(client, gammeId, true);
    assertGammeEditable(gamme.statut);

    const currentRes = await client.query<{ gamme_id: string; phase: number | null; updated_at: string }>(
      `SELECT gamme_id::text AS gamme_id, phase, updated_at::text AS updated_at
         FROM public.pieces_techniques_operations WHERE id = $1 FOR UPDATE`,
      [operationId]
    );
    const current = currentRes.rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND", "Opération introuvable");
    if (current.gamme_id !== gammeId) {
      throw new HttpError(409, "OPERATION_GAMME_MISMATCH", "Cette opération n'appartient pas à la gamme indiquée.");
    }
    assertOptimisticVersion({
      expectedUpdatedAt,
      currentUpdatedAt: current.updated_at,
      label: "l'opération",
    });

    // `gamme_operation_finitions` est en ON DELETE CASCADE : supprimer
    // l'opération effacerait SILENCIEUSEMENT une exigence de sous-traitance
    // déjà configurée. On refuse et on demande un retrait explicite.
    const finition = await client.query(
      `SELECT 1 FROM public.gamme_operation_finitions WHERE gamme_operation_id = $1`,
      [operationId]
    );
    if ((finition.rowCount ?? 0) > 0) {
      throw new HttpError(
        409,
        "OPERATION_HAS_FINITION",
        "Cette opération porte une finition : retirez la finition avant de supprimer l'opération."
      );
    }

    // Les OF lancés référencent l'opération d'origine (ON DELETE SET NULL) :
    // supprimer romprait la traçabilité d'un OF réel.
    const usedByOf = await client.query(
      `SELECT COUNT(*)::int AS n FROM public.of_operations WHERE source_piece_operation_id = $1`,
      [operationId]
    );
    if ((usedByOf.rows[0]?.n ?? 0) > 0) {
      throw new HttpError(
        409,
        "OPERATION_USED_BY_OF",
        "Cette opération est la source d'au moins un ordre de fabrication : elle ne peut plus être supprimée."
      );
    }

    await client.query(`DELETE FROM public.pieces_techniques_operations WHERE id = $1`, [operationId]);
    // Les phases restantes ne sont PAS renumérotées : seul l'ordre d'affichage
    // est resserré, pour rester 10, 20, 30… sans trou visuel.
    const remaining = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.pieces_techniques_operations
        WHERE gamme_id = $1 ORDER BY ordre NULLS LAST, phase NULLS LAST, id`,
      [gammeId]
    );
    for (let index = 0; index < remaining.rows.length; index += 1) {
      await client.query(`UPDATE public.pieces_techniques_operations SET ordre = $1 WHERE id = $2`, [
        (index + 1) * 10,
        remaining.rows[index].id,
      ]);
    }

    await insertAudit(client, audit, "gammes.operations.delete", "gamme_operation", operationId, {
      gamme_id: gammeId,
      phase: current.phase,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Réordonne via `ordre` — NE TOUCHE JAMAIS à `phase`. Refuse un ordre partiel :
 * réordonner la moitié d'une gamme donnerait un résultat non déterministe.
 */
export async function repoReorderGammeOperations(
  gammeId: string,
  order: string[],
  audit: AuditContext
): Promise<GammeOperationDTO[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gamme = await loadGammeContext(client, gammeId, true);
    assertGammeEditable(gamme.statut);

    const existing = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.pieces_techniques_operations WHERE gamme_id = $1`,
      [gammeId]
    );
    const known = new Set(existing.rows.map((row) => row.id));
    const received = new Set(order);
    if (received.size !== order.length) {
      throw new HttpError(422, "REORDER_DUPLICATE", "La liste de réordonnancement contient un doublon.");
    }
    if (known.size !== received.size || [...received].some((id) => !known.has(id))) {
      throw new HttpError(
        422,
        "REORDER_INCOMPLETE",
        "Le réordonnancement doit porter sur toutes les opérations de la gamme, et sur elles seules."
      );
    }

    for (let index = 0; index < order.length; index += 1) {
      await client.query(
        `UPDATE public.pieces_techniques_operations SET ordre = $1, updated_at = now(), updated_by = $4
          WHERE id = $2 AND gamme_id = $3`,
        [(index + 1) * 10, order[index], gammeId, audit.user_id]
      );
    }
    await insertAudit(client, audit, "gammes.operations.reorder", "gamme", gammeId, { count: order.length });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return repoListGammeOperations(gammeId);
}

/* -------------------------------------------------------------------------- */
/* Publication                                                                */
/* -------------------------------------------------------------------------- */

export type PublicationReadiness = {
  publiable: boolean;
  blockers: ReturnType<typeof collectPublicationBlockers>;
};

export async function repoGammePublicationReadiness(gammeId: string): Promise<PublicationReadiness> {
  const gamme = await db.query(`SELECT 1 FROM public.gammes WHERE id = $1`, [gammeId]);
  if (gamme.rowCount === 0) throw new HttpError(404, "NOT_FOUND", "Gamme introuvable");
  const operations = await db.query(
    `SELECT id::text AS id, phase, designation, machine_family_code, numero_programme
       FROM public.pieces_techniques_operations WHERE gamme_id = $1 ORDER BY ordre NULLS LAST, phase`,
    [gammeId]
  );
  const families = await loadFamilyMap(db);
  const blockers = collectPublicationBlockers(
    operations.rows.map((row) => ({
      id: String(row.id),
      phase: row.phase === null ? null : Number(row.phase),
      designation: (row.designation as string | null) ?? null,
      machine_family_code: (row.machine_family_code as string | null) ?? null,
      numero_programme: (row.numero_programme as string | null) ?? null,
    })),
    families
  );
  return { publiable: blockers.length === 0, blockers };
}

/**
 * Publie la gamme : elle devient `APPLICABLE` et courante pour son indice. La
 * garde de publication est rejouée DANS la transaction, sur les lignes
 * verrouillées : un aperçu « publiable » ne vaut pas autorisation.
 */
export async function repoPublishGamme(
  gammeId: string,
  expectedUpdatedAt: string | null | undefined,
  audit: AuditContext
): Promise<{ id: string; statut: string; is_current: boolean; updated_at: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gamme = await loadGammeContext(client, gammeId, true);
    assertGammeEditable(gamme.statut);
    assertOptimisticVersion({
      expectedUpdatedAt,
      currentUpdatedAt: gamme.updated_at,
      label: "la gamme",
    });

    const operations = await client.query(
      `SELECT id::text AS id, phase, designation, machine_family_code, numero_programme
         FROM public.pieces_techniques_operations WHERE gamme_id = $1 FOR UPDATE`,
      [gammeId]
    );
    const families = await loadFamilyMap(client);
    assertGammePublishable(
      operations.rows.map((row) => ({
        id: String(row.id),
        phase: row.phase === null ? null : Number(row.phase),
        designation: (row.designation as string | null) ?? null,
        machine_family_code: (row.machine_family_code as string | null) ?? null,
        numero_programme: (row.numero_programme as string | null) ?? null,
      })),
      families
    );

    await client.query(
      `UPDATE public.gammes SET is_current = false, updated_at = now(), updated_by = $2
        WHERE piece_technique_version_id = $1 AND is_current = true AND id <> $3`,
      [gamme.piece_technique_version_id, audit.user_id, gammeId]
    );
    const res = await client.query<{ id: string; statut: string; is_current: boolean; updated_at: string }>(
      `UPDATE public.gammes
          SET statut = 'APPLICABLE', is_current = true, updated_at = now(), updated_by = $2
        WHERE id = $1
      RETURNING id::text AS id, statut, is_current, updated_at::text AS updated_at`,
      [gammeId, audit.user_id]
    );
    await insertAudit(client, audit, "gammes.publish", "gamme", gammeId, {
      operations: operations.rowCount ?? 0,
    });
    await client.query("COMMIT");
    return res.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
