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
  gamme_id::text AS gamme_id, article_id::text AS article_id,
  receipt_id::text AS receipt_id, lot_id::text AS lot_id, stock_movement_id::text AS stock_movement_id, reservation_id::text AS reservation_id,
  quality_plan_id::text AS quality_plan_id, quality_control_id::text AS quality_control_id, quality_release_decision_id::text AS quality_release_decision_id, livraison_id::text AS livraison_id,
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

/** Recheck the persisted fixture immediately before the commercial conversion.
 * A presentation can stay open while a technical revision changes; pinning an
 * obsolete or unroutable version would create an OF without usable operations. */
export async function assertPresentationFixture(scenario: Pick<PresentationScenario, "piece_technique_id" | "piece_technique_version_id" | "machine_id">): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM public.piece_technique_versions v
        JOIN public.gammes g
          ON g.piece_technique_version_id = v.id AND g.statut = 'APPLICABLE' AND g.is_current = true
        JOIN public.pieces_techniques_operations pto
          ON pto.gamme_id = g.id AND pto.machine_id = $3::uuid
        JOIN public.machines m
          ON m.id = pto.machine_id AND m.archived_at IS NULL AND m.status::text = 'ACTIVE' AND m.is_available IS NOT FALSE
        JOIN public.centres_frais cf
          ON cf.id = pto.cf_id AND cf.archived_at IS NULL AND cf.statut::text = 'ACTIF'
       WHERE v.id = $2::uuid
         AND v.piece_technique_id = $1::uuid
         AND v.statut = 'APPLICABLE'
         AND v.is_current = true
         AND (v.date_effet IS NULL OR v.date_effet <= CURRENT_DATE)
         AND NULLIF(btrim(pto.machine_family_code), '') IS NOT NULL
         AND upper(btrim(pto.machine_family_code)) = upper(btrim(m.machine_family_code))
         AND upper(btrim(pto.machine_family_code)) = upper(btrim(cf.machine_family_code))
    ) AS ready
  `, [scenario.piece_technique_id, scenario.piece_technique_version_id, scenario.machine_id]);
  if (!result.rows[0]?.ready) {
    throw new HttpError(409, "DEMO_PRESENTATION_FIXTURE_STALE", "La version technique de démonstration n'est plus applicable.");
  }
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

/** A real, selectable resource preset for the visible native gamme dialog. */
export async function findPresentationGammePreset(machineId: string) {
  const result = await pool.query<{ machine_id: string; cf_id: string; machine_family_code: string }>(`
    SELECT m.id::text AS machine_id, cf.id::text AS cf_id, m.machine_family_code
      FROM public.machines m
      JOIN public.centres_frais cf ON cf.machine_family_code = m.machine_family_code
       AND cf.archived_at IS NULL AND cf.statut::text = 'ACTIF'
     WHERE m.id = $1::uuid AND m.archived_at IS NULL AND m.status::text = 'ACTIVE'
       AND m.is_available IS NOT FALSE AND NULLIF(btrim(m.machine_family_code),'') IS NOT NULL
     ORDER BY cf.id LIMIT 1
  `, [machineId])
  if (!result.rows[0]) throw new HttpError(503, "DEMO_GAMME_RESOURCE_MISSING", "La ressource de gamme de démonstration est indisponible.")
  return result.rows[0]
}

export async function createOrResumePresentation(userId: number, startKey: string): Promise<PresentationScenario> {
  try {
    const sameStart = await pool.query<ScenarioDbRow>(`
      SELECT ${scenarioColumns} FROM public.demo_presentation_scenarios
       WHERE user_id = $1 AND start_key = $2 LIMIT 1
    `, [userId, startKey]);
    if (sameStart.rows[0]) return mapScenario(sameStart.rows[0]);

    // The caller holds the per-user presentation advisory lock. Resuming only
    // the same start key keeps concurrent browser sessions independent while
    // retaining idempotency for a retry of that specific session.

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
  patch: Partial<Pick<PresentationScenario, "status" | "client_id" | "gamme_id" | "article_id" | "receipt_id" | "lot_id" | "stock_movement_id" | "reservation_id" | "quality_plan_id" | "quality_control_id" | "quality_release_decision_id" | "livraison_id" | "piece_technique_id" | "piece_technique_version_id" | "machine_id" | "devis_id" | "commande_id" | "affaire_id" | "of_id" | "operation_id" | "execution_id">>
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

export async function adoptNativeReceipt(params: { scenario: PresentationScenario; receiptId?: string }) {
  const row = await pool.query<{ receipt_id:string; lot_id:string; stock_movement_id:string; reservation_id:string|null; qty_ok:number; quality_status:string }>(`SELECT id::text receipt_id,lot_id::text lot_id,stock_movement_id::text stock_movement_id,reservation_id::text reservation_id,qty_ok::float8 qty_ok,quality_status FROM public.of_receipts WHERE id=$1::uuid AND of_id=$2::bigint LIMIT 1`,[params.receiptId,params.scenario.of_id]);
  const receipt=row.rows[0];
  if(!receipt || receipt.qty_ok!==3 || receipt.quality_status!=="QUARANTAINE") throw new HttpError(409,"DEMO_RECEIPT_NOT_READY","La réception native doit concerner l'OF, trois unités et un lot en quarantaine.");
  return receipt;
}

/** Read-only registry adoption: BL, control and release are always produced by
 * their native modules. Every link is rechecked against this exact scenario. */
export async function adoptNativeDelivery(params: { scenario: PresentationScenario; livraisonId?: string }) {
  const row = await pool.query<{ livraison_id: string }>(`
    SELECT bl.id::text AS livraison_id
      FROM public.bon_livraison bl
      JOIN public.bon_livraison_ligne bll ON bll.bon_livraison_id = bl.id
      JOIN public.bon_livraison_ligne_allocations bla ON bla.bon_livraison_ligne_id = bll.id
     WHERE bl.id = $1::uuid
       AND bl.commande_id = $2::bigint
       AND bla.lot_id = $3::uuid
     GROUP BY bl.id
    HAVING sum(bla.quantite) = 3
     LIMIT 1
  `, [params.livraisonId, params.scenario.commande_id, params.scenario.lot_id])
  if (!row.rows[0]) throw new HttpError(409, "DEMO_DELIVERY_NOT_READY", "Le bon de livraison natif doit allouer les trois pièces du lot du scénario.")
  return row.rows[0]
}

export async function adoptNativeQualityPlan(params: { scenario: PresentationScenario; userId: number; qualityPlanId?: string }) {
  const row = await pool.query<{ quality_plan_id: string }>(`
    SELECT p.id::text AS quality_plan_id
      FROM public.quality_control_plan p
      JOIN public.quality_control_plan_characteristic c ON c.plan_id = p.id
     WHERE p.id = $1::uuid AND p.created_by = $2
       AND p.status = 'PUBLISHED' AND p.trigger_type = 'LOT_RELEASE'
       AND p.article_id = $3::uuid
     GROUP BY p.id LIMIT 1`, [params.qualityPlanId, params.userId, params.scenario.article_id]);
  if (!row.rows[0]) throw new HttpError(409, "DEMO_QUALITY_PLAN_NOT_READY", "Le plan de libération doit être publié, lié à l’article du scénario et contenir une caractéristique.");
  return row.rows[0];
}
export async function adoptNativeQualityRelease(params: { scenario: PresentationScenario; qualityControlId?: string; decisionId?: string }) {
  const row = await pool.query<{ quality_control_id: string; decision_id: string }>(`
    SELECT qc.id::text AS quality_control_id, rd.id::text AS decision_id
      FROM public.quality_control qc
      JOIN public.quality_release_decision rd ON rd.quality_control_id = qc.id
     WHERE qc.id = $1::uuid AND ($2::uuid IS NULL OR rd.id = $2::uuid)
       AND qc.lot_id = $3::uuid
       AND qc.of_id = $4::bigint
       AND rd.decision IN ('FULL','PARTIAL')
       AND rd.qty = 3
     ORDER BY rd.decided_at DESC LIMIT 1
  `, [params.qualityControlId, params.decisionId ?? null, params.scenario.lot_id, params.scenario.of_id])
  if (!row.rows[0]) throw new HttpError(409, "DEMO_QUALITY_NOT_READY", "Le contrôle natif doit libérer les trois pièces du lot du scénario.")
  return row.rows[0]
}

export async function assertNativeDeliveryShipped(params: { scenario: PresentationScenario }) {
  const row = await pool.query<{ shipped: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM public.bon_livraison bl
      JOIN public.bon_livraison_ligne bll ON bll.bon_livraison_id = bl.id
      JOIN public.bon_livraison_ligne_allocations bla ON bla.bon_livraison_ligne_id = bll.id
     WHERE bl.id = $1::uuid AND bl.commande_id = $2::bigint AND bla.lot_id = $3::uuid
       AND upper(bl.statut::text) IN ('EXPEDIE','SHIPPED','LIVRE')
     GROUP BY bl.id HAVING sum(bla.quantite) = 3
    ) AS shipped
  `, [params.scenario.livraison_id, params.scenario.commande_id, params.scenario.lot_id])
  if (!row.rows[0]?.shipped) throw new HttpError(409, "DEMO_SHIPMENT_NOT_READY", "Expédiez le bon de livraison natif avant de terminer la présentation.")
}

export async function assertNativeProductionFinished(scenario: PresentationScenario, requireOfFinished: boolean): Promise<void> {
  const row=await pool.query<{ operation_status:string; of_status:string; qty:number }>(`SELECT op.status::text operation_status,ofx.statut::text of_status,ofx.quantite_bonne::float8 qty FROM public.ordres_fabrication ofx JOIN public.of_operations op ON op.id=$2::uuid AND op.of_id=ofx.id WHERE ofx.id=$1::bigint`,[scenario.of_id,scenario.operation_id]);
  const value=row.rows[0];
  if(!value || value.operation_status!=="DONE" || value.qty<3) throw new HttpError(409,"DEMO_OPERATION_NOT_FINISHED","Terminez l'opération native avant de poursuivre.");
  if(requireOfFinished && !["TERMINE","CLOTURE","CLOTUREE"].includes(value.of_status)) throw new HttpError(409,"DEMO_OF_NOT_FINISHED","Terminez l'OF native avant de poursuivre.");
}

export async function adoptNativePiece(params: { scenario: PresentationScenario; userId: number; pieceId?: string }) {
  const row = await pool.query<{ piece_id: string; version_id: string }>(`SELECT pt.id::text piece_id,v.id::text version_id FROM public.pieces_techniques pt JOIN public.piece_technique_versions v ON v.piece_technique_id=pt.id WHERE pt.id=$1::uuid AND pt.client_id=$2 AND pt.created_by=$3 ORDER BY v.created_at DESC LIMIT 1`, [params.pieceId, params.scenario.client_id, params.userId]);
  if (!row.rows[0]) throw new HttpError(409, "DEMO_PIECE_NOT_READY", "La pièce doit être créée pour ce client avec le formulaire natif.");
  return row.rows[0];
}

export async function adoptNativeGamme(params: { scenario: PresentationScenario; userId: number; gammeId?: string }) {
  const row = await pool.query<{ gamme_id: string; machine_id: string }>(`SELECT g.id::text gamme_id,pto.machine_id::text machine_id FROM public.gammes g JOIN public.pieces_techniques_operations pto ON pto.gamme_id=g.id JOIN public.machines m ON m.id=pto.machine_id AND m.archived_at IS NULL AND m.status::text='ACTIVE' AND m.is_available IS NOT FALSE WHERE g.id=$1::uuid AND g.piece_technique_version_id=$2::uuid AND g.statut='APPLICABLE' AND g.is_current=true AND pto.cf_id IS NOT NULL AND pto.machine_id IS NOT NULL LIMIT 1`, [params.gammeId, params.scenario.piece_technique_version_id]);
  if (!row.rows[0]) throw new HttpError(409, "DEMO_GAMME_NOT_READY", "La gamme applicable doit contenir une opération machine prête.");
  return row.rows[0];
}

export async function adoptNativeArticle(params: { scenario: PresentationScenario; userId: number; articleId?: string }) {
  const row = await pool.query<{ article_id: string }>(`SELECT id::text article_id FROM public.articles WHERE id=$1::uuid AND piece_technique_id=$2::uuid AND article_category='fabrique' AND is_active=true LIMIT 1`, [params.articleId, params.scenario.piece_technique_id]);
  if (!row.rows[0]) throw new HttpError(409, "DEMO_ARTICLE_NOT_READY", "L'article fabriqué doit être lié à la pièce du scénario.");
  return row.rows[0];
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

export async function findPreparedClient(params: { scenario: PresentationScenario; userId: number; companyName: string; siret: string; email: string; clientId?: string }): Promise<string> {
  const result = await pool.query<{ client_id: string }>(`
    SELECT c.client_id
      FROM public.clients c
     WHERE c.created_by = $1
       AND c.company_name = $2
       AND c.siret = $3
       AND lower(btrim(COALESCE(c.email, ''))) = lower(btrim($4))
       AND ($5::text IS NULL OR c.client_id = $5::text)
       AND NOT EXISTS (
         SELECT 1 FROM public.demo_presentation_scenarios linked
          WHERE linked.client_id = c.client_id AND linked.id <> $6::uuid
       )
     ORDER BY c.created_at DESC
     LIMIT 1
  `, [params.userId, params.companyName, params.siret, params.email, params.clientId ?? null, params.scenario.id]);
  const clientId = result.rows[0]?.client_id;
  if (!clientId) throw new HttpError(409, "DEMO_CLIENT_NOT_READY", "Le client préparé doit être créé avec le formulaire natif avant de poursuivre.");
  return clientId;
}

export async function findPreparedQuote(params: { scenario: PresentationScenario; userId: number; articleId: string; devisId?: number }): Promise<number> {
  if (!params.scenario.client_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "Le client de démonstration est absent.");
  const result = await pool.query<{ id: number | string }>(`
    SELECT d.id::bigint AS id
      FROM public.devis d
      JOIN public.devis_ligne dl ON dl.devis_id = d.id
     WHERE d.client_id = $1
       AND d.user_id = $2
       AND d.statut = 'BROUILLON'
       AND dl.article_id = $3::uuid
       AND ($4::bigint IS NULL OR d.id = $4::bigint)
       AND NOT EXISTS (
         SELECT 1 FROM public.demo_presentation_scenarios linked
          WHERE linked.devis_id = d.id AND linked.id <> $5::uuid
       )
     GROUP BY d.id
    HAVING count(*) = 1
       AND max(dl.quantite) = 3
       AND max(dl.prix_unitaire_ht) = 240
       AND bool_and(dl.piece_technique_id = $6::uuid)
     ORDER BY d.id DESC
     LIMIT 1
  `, [params.scenario.client_id, params.userId, params.articleId, params.devisId ?? null, params.scenario.id, params.scenario.piece_technique_id]);
  const devisId = result.rows[0]?.id;
  if (!devisId) throw new HttpError(409, "DEMO_QUOTE_NOT_READY", "Le devis brouillon préparé doit être créé avec le formulaire natif avant de poursuivre.");
  return Number(devisId);
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
