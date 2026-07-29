// Qualification du parc machine (#233 / crp-systems-web#384).
//
// Qualifier une machine = lui donner sa FAMILLE (T, F, TTRAD, FTRAD, DECOUPE…),
// son CENTRE DE FRAIS et sa période de validité. Les trois objets restent
// distincts : la famille classe, le centre de frais valorise, la machine
// exécute.
//
// RIEN N'EST DÉDUIT. Ni du code machine, ni du libellé, ni du champ `type`
// (MILLING/TURNING ne distingue pas une CN d'une conventionnelle). Une machine
// non qualifiée reste `null` et l'interface le dit — ADR-0020 « ne pas déduire
// depuis le code machine ».
//
// CHAQUE DÉCISION EST JOURNALISÉE avec son état précédent et son motif : une
// affectation qui change le coût des gammes futures doit pouvoir être relue et
// défaite sans reconstitution.

import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { assertCostCenterSelectable, assertFamilySelectable, assertOptimisticVersion } from "../domain/methodes-policy";
import type { AuditContext } from "../types/methodes.types";

/* -------------------------------------------------------------------------- */
/* Contrats                                                                   */
/* -------------------------------------------------------------------------- */

export type MachineQualificationEntryDTO = {
  id: string;
  previous_family_code: string | null;
  previous_cf_id: string | null;
  previous_cf_code: string | null;
  previous_valid_from: string | null;
  previous_valid_to: string | null;
  new_family_code: string | null;
  new_cf_id: string | null;
  new_cf_code: string | null;
  new_valid_from: string | null;
  new_valid_to: string | null;
  motif: string;
  created_at: string;
  created_by: number | null;
  created_by_nom: string | null;
};

/**
 * Ce qu'une requalification touche RÉELLEMENT. `of_operations_figees` est
 * volontairement séparé : ces lignes sont des snapshots d'OF lancés, elles ne
 * bougeront pas — les compter rassure au lieu d'inquiéter.
 */
export type MachineQualificationImpactDTO = {
  operations_gammes_modifiables: number;
  operations_gammes_publiees: number;
  gammes_publiees_concernees: number;
  of_operations_figees: number;
  /** `true` si la nouvelle famille contredit une opération de gamme publiée. */
  conflit_famille_gamme_publiee: boolean;
};

export type MachineQualificationDTO = {
  id: string;
  code: string;
  name: string;
  display_name: string | null;
  legacy_alias: string | null;
  type: string | null;
  brand: string | null;
  model: string | null;
  status: string;
  is_available: boolean;
  location: string | null;
  workshop_zone: string | null;
  archived_at: string | null;
  updated_at: string;
  machine_family_code: string | null;
  machine_family_libelle: string | null;
  cf_id: string | null;
  cf_code: string | null;
  cf_designation: string | null;
  valid_from: string | null;
  valid_to: string | null;
  /** `true` tant que la famille n'est pas renseignée : « À qualifier ». */
  a_qualifier: boolean;
  impact: MachineQualificationImpactDTO;
  historique: MachineQualificationEntryDTO[];
};

export type QualifyMachineInput = {
  machine_family_code: string | null;
  cf_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  motif: string;
  expected_updated_at: string;
};

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

const MACHINE_COLS = `
  m.id::text AS id, m.code, m.name, m.display_name, m.legacy_alias,
  m.type::text AS type, m.brand, m.model, m.status::text AS status, m.is_available,
  m.location, m.workshop_zone, m.archived_at::text AS archived_at,
  m.updated_at::text AS updated_at,
  m.machine_family_code, fam.libelle AS machine_family_libelle,
  m.cf_id::text AS cf_id, cf.code AS cf_code, cf.designation AS cf_designation,
  m.valid_from::text AS valid_from, m.valid_to::text AS valid_to
`;

const MACHINE_FROM = `
  FROM public.machines m
  LEFT JOIN public.production_machine_families fam ON fam.code = m.machine_family_code
  LEFT JOIN public.centres_frais cf ON cf.id = m.cf_id
`;

/**
 * Impact d'une requalification. `candidateFamily` vaut `undefined` en lecture
 * simple : on ne signale un conflit que lorsqu'une nouvelle famille est proposée.
 */
async function loadImpact(
  tx: Pick<PoolClient, "query">,
  machineId: string,
  candidateFamily?: string | null
): Promise<MachineQualificationImpactDTO> {
  const res = await tx.query<{
    operations_gammes_modifiables: string;
    operations_gammes_publiees: string;
    gammes_publiees_concernees: string;
    of_operations_figees: string;
    conflit: boolean;
  }>(
    `
      SELECT
        count(*) FILTER (WHERE g.statut IN ('BROUILLON', 'EN_VALIDATION'))            AS operations_gammes_modifiables,
        count(*) FILTER (WHERE g.statut = 'APPLICABLE')                                AS operations_gammes_publiees,
        count(DISTINCT g.id) FILTER (WHERE g.statut = 'APPLICABLE')                    AS gammes_publiees_concernees,
        (SELECT count(*) FROM public.of_operations WHERE machine_id = $1::uuid)        AS of_operations_figees,
        COALESCE(bool_or(
          g.statut = 'APPLICABLE'
          AND op.machine_family_code IS NOT NULL
          AND op.machine_family_code IS DISTINCT FROM $2::text
        ), false)                                                                      AS conflit
      FROM public.pieces_techniques_operations op
      JOIN public.gammes g ON g.id = op.gamme_id
     WHERE op.machine_id = $1::uuid
    `,
    [machineId, candidateFamily ?? null]
  );
  const row = res.rows[0];
  return {
    operations_gammes_modifiables: Number(row?.operations_gammes_modifiables ?? 0),
    operations_gammes_publiees: Number(row?.operations_gammes_publiees ?? 0),
    gammes_publiees_concernees: Number(row?.gammes_publiees_concernees ?? 0),
    of_operations_figees: Number(row?.of_operations_figees ?? 0),
    conflit_famille_gamme_publiee: candidateFamily === undefined ? false : Boolean(row?.conflit),
  };
}

async function loadHistory(
  tx: Pick<PoolClient, "query">,
  machineId: string
): Promise<MachineQualificationEntryDTO[]> {
  const res = await tx.query(
    `
      SELECT q.id::text AS id,
             q.previous_family_code, q.previous_cf_id::text AS previous_cf_id,
             prev_cf.code AS previous_cf_code,
             q.previous_valid_from::text AS previous_valid_from,
             q.previous_valid_to::text   AS previous_valid_to,
             q.new_family_code, q.new_cf_id::text AS new_cf_id,
             new_cf.code AS new_cf_code,
             q.new_valid_from::text AS new_valid_from,
             q.new_valid_to::text   AS new_valid_to,
             q.motif, q.created_at::text AS created_at, q.created_by,
             NULLIF(btrim(COALESCE(u.name, '') || ' ' || COALESCE(u.surname, '')), '') AS created_by_nom
        FROM public.production_machine_qualifications q
        LEFT JOIN public.centres_frais prev_cf ON prev_cf.id = q.previous_cf_id
        LEFT JOIN public.centres_frais new_cf  ON new_cf.id  = q.new_cf_id
        LEFT JOIN public.users u ON u.id = q.created_by
       WHERE q.machine_id = $1::uuid
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT 200
    `,
    [machineId]
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    previous_family_code: (row.previous_family_code as string | null) ?? null,
    previous_cf_id: (row.previous_cf_id as string | null) ?? null,
    previous_cf_code: (row.previous_cf_code as string | null) ?? null,
    previous_valid_from: (row.previous_valid_from as string | null) ?? null,
    previous_valid_to: (row.previous_valid_to as string | null) ?? null,
    new_family_code: (row.new_family_code as string | null) ?? null,
    new_cf_id: (row.new_cf_id as string | null) ?? null,
    new_cf_code: (row.new_cf_code as string | null) ?? null,
    new_valid_from: (row.new_valid_from as string | null) ?? null,
    new_valid_to: (row.new_valid_to as string | null) ?? null,
    motif: String(row.motif),
    created_at: String(row.created_at),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    created_by_nom: (row.created_by_nom as string | null) ?? null,
  }));
}

function mapMachine(
  row: Record<string, unknown>,
  impact: MachineQualificationImpactDTO,
  historique: MachineQualificationEntryDTO[]
): MachineQualificationDTO {
  const familyCode = (row.machine_family_code as string | null) ?? null;
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    display_name: (row.display_name as string | null) ?? null,
    legacy_alias: (row.legacy_alias as string | null) ?? null,
    type: (row.type as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    status: String(row.status),
    is_available: Boolean(row.is_available),
    location: (row.location as string | null) ?? null,
    workshop_zone: (row.workshop_zone as string | null) ?? null,
    archived_at: (row.archived_at as string | null) ?? null,
    updated_at: String(row.updated_at),
    machine_family_code: familyCode,
    machine_family_libelle: (row.machine_family_libelle as string | null) ?? null,
    cf_id: (row.cf_id as string | null) ?? null,
    cf_code: (row.cf_code as string | null) ?? null,
    cf_designation: (row.cf_designation as string | null) ?? null,
    valid_from: (row.valid_from as string | null) ?? null,
    valid_to: (row.valid_to as string | null) ?? null,
    a_qualifier: familyCode === null,
    impact,
    historique,
  };
}

/** Parc machine complet vu par les Méthodes : qualifiées et à qualifier. */
export async function repoListMachinesForQualification(params: {
  search: string | null;
  only_unqualified: boolean;
  include_archived: boolean;
}): Promise<MachineQualificationDTO[]> {
  const res = await db.query(
    `SELECT ${MACHINE_COLS},
            (SELECT count(*) FROM public.production_machine_qualifications q WHERE q.machine_id = m.id)
              AS historique_count
     ${MACHINE_FROM}
      WHERE ($1::text IS NULL
             OR m.code ILIKE '%' || $1 || '%'
             OR m.name ILIKE '%' || $1 || '%'
             OR COALESCE(m.display_name, '') ILIKE '%' || $1 || '%'
             OR COALESCE(m.brand, '') ILIKE '%' || $1 || '%'
             OR COALESCE(m.model, '') ILIKE '%' || $1 || '%')
        AND ($2::boolean IS NOT TRUE OR m.machine_family_code IS NULL)
        AND ($3::boolean OR m.archived_at IS NULL)
      ORDER BY (m.machine_family_code IS NOT NULL), m.code`,
    [params.search, params.only_unqualified, params.include_archived]
  );
  // Une liste ne charge ni l'impact ni l'historique complet : le détail les
  // fournit. Les compteurs à zéro ici ne sont donc PAS une affirmation d'absence.
  const empty: MachineQualificationImpactDTO = {
    operations_gammes_modifiables: 0,
    operations_gammes_publiees: 0,
    gammes_publiees_concernees: 0,
    of_operations_figees: 0,
    conflit_famille_gamme_publiee: false,
  };
  return res.rows.map((row) => mapMachine(row, empty, []));
}

export async function repoGetMachineQualification(machineId: string): Promise<MachineQualificationDTO | null> {
  const res = await db.query(`SELECT ${MACHINE_COLS} ${MACHINE_FROM} WHERE m.id = $1::uuid`, [machineId]);
  const row = res.rows[0];
  if (!row) return null;
  const [impact, historique] = await Promise.all([loadImpact(db, machineId), loadHistory(db, machineId)]);
  return mapMachine(row, impact, historique);
}

/** Aperçu d'impact AVANT décision. Lecture seule, aucune écriture. */
export async function repoPreviewMachineQualification(
  machineId: string,
  candidateFamily: string | null
): Promise<MachineQualificationImpactDTO | null> {
  const exists = await db.query(`SELECT 1 FROM public.machines WHERE id = $1::uuid`, [machineId]);
  if (exists.rowCount === 0) return null;
  return loadImpact(db, machineId, candidateFamily);
}

/* -------------------------------------------------------------------------- */
/* Écriture                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Qualifie une machine. Transaction unique : verrou sur la machine, contrôle du
 * référentiel, journal, mise à jour, audit. Si le journal échoue, la machine
 * n'est pas modifiée — une qualification sans trace n'existe pas.
 *
 * Les OPÉRATIONS DÉJÀ SAISIES ne sont jamais réécrites : une gamme publiée garde
 * la famille qu'elle portait. Seules les saisies futures voient la nouvelle
 * qualification.
 */
export async function repoQualifyMachine(
  machineId: string,
  input: QualifyMachineInput,
  audit: AuditContext
): Promise<MachineQualificationDTO | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const currentRes = await client.query<{
      updated_at: string;
      code: string;
      machine_family_code: string | null;
      cf_id: string | null;
      valid_from: string | null;
      valid_to: string | null;
      archived_at: string | null;
    }>(
      `SELECT updated_at::text AS updated_at, code, machine_family_code, cf_id::text AS cf_id,
              valid_from::text AS valid_from, valid_to::text AS valid_to, archived_at::text AS archived_at
         FROM public.machines WHERE id = $1::uuid FOR UPDATE`,
      [machineId]
    );
    const current = currentRes.rows[0];
    if (!current) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    if (current.archived_at) {
      throw new HttpError(
        422,
        "MACHINE_ARCHIVED",
        `La machine ${current.code} est archivée : elle ne se requalifie plus. Réactivez-la d'abord.`
      );
    }

    assertOptimisticVersion({
      expectedUpdatedAt: input.expected_updated_at,
      currentUpdatedAt: current.updated_at,
      label: `la machine ${current.code}`,
    });

    // Famille : doit exister ET être active. `null` = « à qualifier » assumé.
    if (input.machine_family_code !== null) {
      const familyRes = await client.query<{
        code: string;
        libelle: string;
        programme_requis: boolean;
        actif: boolean;
      }>(
        `SELECT code, libelle, programme_requis, actif
           FROM public.production_machine_families WHERE code = $1`,
        [input.machine_family_code]
      );
      assertFamilySelectable(familyRes.rows[0] ?? null, input.machine_family_code);
    }

    // Centre de frais : doit exister ET être actif.
    if (input.cf_id !== null) {
      const cfRes = await client.query(
        `SELECT id::text AS id, code, designation, statut, devise, machine_family_code,
                designation_auto, designation_modele
           FROM public.centres_frais WHERE id = $1::uuid`,
        [input.cf_id]
      );
      const cf = cfRes.rows[0];
      assertCostCenterSelectable(
        cf
          ? {
              id: String(cf.id),
              code: String(cf.code),
              designation: String(cf.designation),
              statut: String(cf.statut),
              devise: String(cf.devise),
              machine_family_code: (cf.machine_family_code as string | null) ?? null,
              designation_auto: Boolean(cf.designation_auto),
              designation_modele: (cf.designation_modele as string | null) ?? null,
            }
          : null,
        input.cf_id
      );
      // Un centre de frais rattaché à une AUTRE famille produirait un coût
      // incohérent avec le classement de la machine : on refuse au lieu de
      // laisser passer une contradiction silencieuse.
      const cfFamily = (cf?.machine_family_code as string | null) ?? null;
      if (cfFamily !== null && input.machine_family_code !== null && cfFamily !== input.machine_family_code) {
        throw new HttpError(
          422,
          "COST_CENTER_FAMILY_MISMATCH",
          `Le centre de frais ${String(cf?.code)} est rattaché à la famille ${cfFamily}, pas à ${input.machine_family_code}.`,
          { cf_family_code: cfFamily, machine_family_code: input.machine_family_code }
        );
      }
    }

    if (input.valid_from && input.valid_to && input.valid_to < input.valid_from) {
      throw new HttpError(422, "MACHINE_VALIDITY_INVALID", "La fin de validité précède le début de validité.");
    }

    const unchanged =
      current.machine_family_code === input.machine_family_code &&
      current.cf_id === input.cf_id &&
      current.valid_from === input.valid_from &&
      current.valid_to === input.valid_to;
    if (unchanged) {
      throw new HttpError(
        409,
        "MACHINE_QUALIFICATION_UNCHANGED",
        "Aucun changement : la machine porte déjà cette qualification."
      );
    }

    // Journal AVANT mise à jour : l'état précédent est encore lisible.
    await client.query(
      `INSERT INTO public.production_machine_qualifications
         (machine_id, previous_family_code, previous_cf_id, previous_valid_from, previous_valid_to,
          new_family_code, new_cf_id, new_valid_from, new_valid_to, motif, created_by)
       VALUES ($1::uuid,$2,$3::uuid,$4::date,$5::date,$6,$7::uuid,$8::date,$9::date,$10,$11)`,
      [
        machineId,
        current.machine_family_code,
        current.cf_id,
        current.valid_from,
        current.valid_to,
        input.machine_family_code,
        input.cf_id,
        input.valid_from,
        input.valid_to,
        input.motif.trim(),
        audit.user_id,
      ]
    );

    await client.query(
      `UPDATE public.machines
          SET machine_family_code = $2,
              cf_id               = $3::uuid,
              valid_from          = $4::date,
              valid_to            = $5::date,
              updated_by          = $6,
              updated_at          = now()
        WHERE id = $1::uuid`,
      [machineId, input.machine_family_code, input.cf_id, input.valid_from, input.valid_to, audit.user_id]
    );

    await repoInsertAuditLog({
      user_id: audit.user_id,
      body: {
        event_type: "ACTION",
        action: "methodes.machine.qualify",
        page_key: audit.page_key,
        entity_type: "machine",
        entity_id: machineId,
        path: audit.path,
        client_session_id: audit.client_session_id,
        details: {
          code: current.code,
          avant: {
            machine_family_code: current.machine_family_code,
            cf_id: current.cf_id,
            valid_from: current.valid_from,
            valid_to: current.valid_to,
          },
          apres: {
            machine_family_code: input.machine_family_code,
            cf_id: input.cf_id,
            valid_from: input.valid_from,
            valid_to: input.valid_to,
          },
          motif: input.motif.trim(),
        },
      },
      ip: audit.ip,
      user_agent: audit.user_agent,
      device_type: audit.device_type,
      os: audit.os,
      browser: audit.browser,
      tx: client,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return repoGetMachineQualification(machineId);
}
