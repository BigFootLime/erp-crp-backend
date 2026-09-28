import crypto from "node:crypto";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { PresentationScenario, PresentationStatus } from "../types/demo-presentation.types";

type ScenarioDbRow = Omit<PresentationScenario, "user_id" | "devis_id" | "commande_id" | "affaire_id" | "of_id"> & {
  user_id: number | string;
  devis_id: number | string | null;
  commande_id: number | string | null;
  affaire_id: number | string | null;
  of_id: number | string | null;
};

type Fixture = { piece_technique_id: string; piece_technique_version_id: string; machine_id: string };

function toNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function mapScenario(row: ScenarioDbRow): PresentationScenario {
  return {
    ...row,
    user_id: Number(row.user_id),
    devis_id: toNumber(row.devis_id),
    commande_id: toNumber(row.commande_id),
    affaire_id: toNumber(row.affaire_id),
    of_id: toNumber(row.of_id),
  };
}

const scenarioColumns = `
  id::text AS id, user_id::int AS user_id, status, fixture_code,
  piece_technique_id::text AS piece_technique_id,
  piece_technique_version_id::text AS piece_technique_version_id,
  machine_id::text AS machine_id, client_id::text AS client_id,
  devis_id::bigint AS devis_id, commande_id::bigint AS commande_id,
  affaire_id::bigint AS affaire_id, of_id::bigint AS of_id,
  operation_id::text AS operation_id, execution_id::text AS execution_id`;

function missingRegistry(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01";
}

function registryUnavailable(error: unknown): never {
  if (missingRegistry(error)) {
    throw new HttpError(503, "DEMO_PRESENTATION_NOT_READY", "Le registre de démonstration doit être installé sur cerp_demo.");
  }
  throw error;
}

async function loadFixture(): Promise<Fixture> {
  const result = await pool.query<Fixture>(`
    SELECT pt.id::text AS piece_technique_id, v.id::text AS piece_technique_version_id,
           pto.machine_id::text AS machine_id
      FROM public.pieces_techniques pt
      JOIN public.piece_technique_versions v
        ON v.piece_technique_id = pt.id
       AND v.statut = 'APPLICABLE'
       AND v.is_current = true
       AND (v.date_effet IS NULL OR v.date_effet <= CURRENT_DATE)
      JOIN public.gammes g
        ON g.piece_technique_version_id = v.id AND g.statut = 'APPLICABLE' AND g.is_current = true
      JOIN public.pieces_techniques_operations pto
        ON pto.gamme_id = g.id
       AND pto.machine_id IS NOT NULL
      JOIN public.machines m
        ON m.id = pto.machine_id
       AND m.archived_at IS NULL
       AND m.status::text = 'ACTIVE'
       AND m.is_available IS NOT FALSE
      JOIN public.centres_frais cf
        ON cf.id = pto.cf_id
       AND cf.archived_at IS NULL
       AND cf.statut::text = 'ACTIF'
     WHERE pt.code_piece = 'DEMO-PT-001'
       AND NULLIF(btrim(pto.machine_family_code), '') IS NOT NULL
       AND upper(btrim(pto.machine_family_code)) = upper(btrim(m.machine_family_code))
       AND upper(btrim(pto.machine_family_code)) = upper(btrim(cf.machine_family_code))
     ORDER BY pto.phase, pto.ordre, pto.id
     LIMIT 1
  `);
  const fixture = result.rows[0];
  if (!fixture) throw new HttpError(503, "DEMO_PRESENTATION_FIXTURE_MISSING", "Les données techniques de démonstration ne sont pas prêtes.");
  return fixture;
}

export async function findFixtureArticleId(pieceTechniqueId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    SELECT a.id::text AS id
      FROM public.articles a
     WHERE a.piece_technique_id = $1::uuid
       AND a.article_category = 'fabrique'
       AND a.is_active = true
     ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC, a.id
     LIMIT 1
  `, [pieceTechniqueId]);
  if (!result.rows[0]?.id) throw new HttpError(503, "DEMO_PRESENTATION_FIXTURE_MISSING", "L'article de démonstration est indisponible.");
  return result.rows[0].id;
}

export async function createOrResumePresentation(userId: number, startKey: string): Promise<PresentationScenario> {
  try {
    const sameStart = await pool.query<ScenarioDbRow>(`
      SELECT ${scenarioColumns} FROM public.demo_presentation_scenarios
       WHERE user_id = $1 AND start_key = $2 LIMIT 1
    `, [userId, startKey]);
    if (sameStart.rows[0]) return mapScenario(sameStart.rows[0]);
    const existing = await pool.query<ScenarioDbRow>(`
      SELECT ${scenarioColumns} FROM public.demo_presentation_scenarios
       WHERE user_id = $1 AND status <> 'COMPLETED'
       ORDER BY created_at DESC LIMIT 1
    `, [userId]);
    if (existing.rows[0]) return mapScenario(existing.rows[0]);

    const rate = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM public.demo_presentation_scenarios
       WHERE user_id = $1 AND created_at >= now() - interval '1 hour'
    `, [userId]);
    if (Number(rate.rows[0]?.count ?? 0) >= 30) {
      throw new HttpError(429, "DEMO_SCENARIO_LIMIT", "Limite de nouveaux scénarios atteinte. Réessayez plus tard.");
    }

    const fixture = await loadFixture();
    const inserted = await pool.query<ScenarioDbRow>(`
      INSERT INTO public.demo_presentation_scenarios
        (id,user_id,start_key,status,piece_technique_id,piece_technique_version_id,machine_id)
      VALUES ($1::uuid,$2,$3,'INITIALIZING',$4::uuid,$5::uuid,$6::uuid)
      RETURNING ${scenarioColumns}
    `, [crypto.randomUUID(), userId, startKey, fixture.piece_technique_id, fixture.piece_technique_version_id, fixture.machine_id]);
    return mapScenario(inserted.rows[0]);
  } catch (error) {
    return registryUnavailable(error);
  }
}

export async function hasPresentationReceipt(scenarioId: string, action: string, requestKey: string): Promise<boolean> {
  try {
    const result = await pool.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM public.demo_presentation_action_receipts WHERE scenario_id=$1::uuid AND action=$2 AND request_key=$3) AS present`,
      [scenarioId, action, requestKey],
    );
    return result.rows[0]?.present === true;
  } catch (error) { return registryUnavailable(error); }
}

export async function recordPresentationReceipt(scenarioId: string, action: string, requestKey: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.demo_presentation_action_receipts (scenario_id,action,request_key) VALUES ($1::uuid,$2,$3) ON CONFLICT DO NOTHING`,
      [scenarioId, action, requestKey],
    );
  } catch (error) { return registryUnavailable(error); }
}

export async function getPresentationScenario(id: string, userId: number): Promise<PresentationScenario> {
  try {
    const result = await pool.query<ScenarioDbRow>(`
      SELECT ${scenarioColumns} FROM public.demo_presentation_scenarios
       WHERE id = $1::uuid AND user_id = $2
       LIMIT 1
    `, [id, userId]);
    if (!result.rows[0]) throw new HttpError(403, "DEMO_SCENARIO_FORBIDDEN", "Ce scénario n'appartient pas à la session de démonstration.");
    return mapScenario(result.rows[0]);
  } catch (error) {
    return registryUnavailable(error);
  }
}

export async function updatePresentationScenario(
  id: string,
  userId: number,
  patch: Partial<Pick<PresentationScenario, "status" | "client_id" | "devis_id" | "commande_id" | "affaire_id" | "of_id" | "operation_id" | "execution_id">>
): Promise<PresentationScenario> {
  const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!fields.length) return getPresentationScenario(id, userId);
  const values: unknown[] = [id, userId];
  const assignments = fields.map(([key, value]) => {
    values.push(value);
    return `${key} = $${values.length}`;
  });
  if (patch.status === "COMPLETED") assignments.push("completed_at = now()");
  assignments.push("updated_at = now()");
  try {
    const result = await pool.query<ScenarioDbRow>(`
      UPDATE public.demo_presentation_scenarios SET ${assignments.join(", ")}
       WHERE id = $1::uuid AND user_id = $2
       RETURNING ${scenarioColumns}
    `, values);
    if (!result.rows[0]) throw new HttpError(403, "DEMO_SCENARIO_FORBIDDEN", "Ce scénario n'appartient pas à la session de démonstration.");
    return mapScenario(result.rows[0]);
  } catch (error) {
    return registryUnavailable(error);
  }
}

export async function findExistingPresentationProduction(commandeId: number): Promise<{ affaire_id: number; of_id: number } | null> {
  const result = await pool.query<{ affaire_id: number | string; of_id: number | string }>(`
    SELECT ofa.affaire_id::bigint AS affaire_id, ofa.id::bigint AS of_id
      FROM public.ordres_fabrication ofa
      JOIN public.affaire a ON a.id = ofa.affaire_id
     WHERE ofa.commande_id = $1::bigint
       AND ofa.parent_of_id IS NULL
       AND ofa.statut::text <> 'ANNULE'
     ORDER BY a.is_principal DESC, ofa.id
     LIMIT 1
  `, [commandeId]);
  const row = result.rows[0];
  return row ? { affaire_id: Number(row.affaire_id), of_id: Number(row.of_id) } : null;
}

export async function findScenarioOfAffaire(ofId: number): Promise<number> {
  const result = await pool.query<{ affaire_id: number | string }>(`
    SELECT affaire_id::bigint AS affaire_id
      FROM public.ordres_fabrication
     WHERE id = $1::bigint
     LIMIT 1
  `, [ofId]);
  const affaireId = result.rows[0]?.affaire_id;
  if (!affaireId) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "L'affaire de l'ordre de fabrication est absente.");
  return Number(affaireId);
}

export async function findScenarioOperation(scenario: PresentationScenario): Promise<string> {
  if (!scenario.of_id) throw new HttpError(409, "DEMO_SCENARIO_STEP_INVALID", "L'ordre de fabrication n'est pas encore créé.");
  const result = await pool.query<{ id: string }>(`
    SELECT id::text AS id FROM public.of_operations
     WHERE of_id = $1 AND machine_id = $2::uuid
     ORDER BY phase, id LIMIT 1
  `, [scenario.of_id, scenario.machine_id]);
  if (!result.rows[0]?.id) throw new HttpError(409, "DEMO_OPERATION_MISSING", "L'opération de démonstration est indisponible.");
  return result.rows[0].id;
}

export async function withPresentationLock<T>(lockKey: string, callback: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockKey],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) {
      throw new HttpError(409, "DEMO_SCENARIO_BUSY", "Cette démonstration est déjà en cours. Réessayez dans un instant.");
    }
    return await callback();
  } finally {
    try {
      if (acquired) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
    } finally { client.release(); }
  }
}

export async function findScenarioOfStatus(ofId: number): Promise<string | null> {
  const result = await pool.query<{ statut: string }>(
    "SELECT statut::text AS statut FROM public.ordres_fabrication WHERE id = $1::bigint LIMIT 1",
    [ofId],
  );
  return result.rows[0]?.statut ?? null;
}
