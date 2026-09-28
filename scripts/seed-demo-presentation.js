#!/usr/bin/env node
/* eslint-disable no-console */

// Additive, offline preparation for the real CERP+ presentation path.
// Run scripts/seed-showcase-data.js first. This script never starts HTTP,
// imports the application, or writes outside the dedicated cerp_demo database.

const { Client } = require("pg");
const { assertDemoEnvironment, demoUsername, runStage } = require("./seed-showcase-data");

const REQUIRED_TABLES = [
  "users", "pieces_techniques", "piece_technique_versions", "gammes",
  "pieces_techniques_operations", "machines", "postes", "articles", "stock_levels",
  "app_roles", "user_role_assignments", "units", "programmation_calendars",
  "planning_resource_calendars", "centres_frais", "production_cost_center_rates",
  "production_activity_categories", "production_machine_families",
];

// These are synthetic reference-data rows, separate from each presentation
// run. They use explicit IDs so a rerun remains deterministic and auditable.
const REFERENCE = Object.freeze({
  calendarId: "d01d0006-0000-4000-8000-000000000001",
  costCenterId: "d01d0007-0000-4000-8000-000000000001",
  costCenterRateId: "d01d0007-0000-4000-8000-000000000002",
});

// These IDs identify reusable synthetic method data only. Presentation runs
// themselves are deliberately generated and recorded by the demo API.
const FIXTURES = Object.freeze([
  {
    pieceCode: "DEMO-PT-001",
    versionId: "d01d000a-0000-4000-8000-000000000001",
    versionIndice: "B",
    gammeId: "d01d0008-0000-4000-8000-000000000011",
    operationId: "d01d0009-0000-4000-8000-000000000011",
    gammeCode: "DEMO-GAMME-001",
    gammeDesignation: "Gamme usinage — support de guidage",
    machineCode: "DEMO-CN-01",
    posteCode: "CN-01",
    operationDesignation: "Fraisage de finition — démonstration",
    typeOperation: "FRAISAGE",
    phase: 10,
    ordre: 10,
    tp: 0.1,
    tfUnit: 0.25,
    hourlyRate: 72.5,
    machineFamilyCode: "F",
  },
  {
    pieceCode: "DEMO-PT-002",
    versionId: "d01d000a-0000-4000-8000-000000000002",
    versionIndice: "B",
    gammeId: "d01d0008-0000-4000-8000-000000000012",
    operationId: "d01d0009-0000-4000-8000-000000000012",
    gammeCode: "DEMO-GAMME-002",
    gammeDesignation: "Gamme usinage — flasque de liaison",
    machineCode: "DEMO-TN-02",
    posteCode: "CN-02",
    operationDesignation: "Tournage de finition — démonstration",
    typeOperation: "TOURNAGE",
    phase: 10,
    ordre: 10,
    tp: 0.1,
    tfUnit: 0.2,
    hourlyRate: 72.5,
    machineFamilyCode: "F",
  },
]);

function fail(message) {
  throw new Error(`[presentation-seed] ${message}`);
}

async function assertSchemaAndAccount(client, username) {
  const { rows } = await client.query(
    "SELECT unnest($1::text[]) AS table_name, to_regclass('public.' || unnest($1::text[])) IS NOT NULL AS present",
    [REQUIRED_TABLES]
  );
  const missing = rows.filter((row) => !row.present).map((row) => row.table_name);
  if (missing.length) fail(`schema prerequisites missing: ${missing.join(", ")}`);

  const account = await client.query("SELECT id FROM public.users WHERE username = $1 LIMIT 1", [username]);
  if (!account.rowCount) fail(`demo account ${username} missing; run scripts/seed-demo-account.js first`);
  return account.rows[0].id;
}


async function ensureQualifiedPresentationVersion(client, fixture, userId) {
  const target = await client.query(
    `SELECT v.piece_technique_id::text AS piece_id, v.statut, v.is_current, v.indice
       FROM public.piece_technique_versions v
      WHERE v.id = $1::uuid`,
    [fixture.versionId]
  );
  if (target.rowCount) {
    const row = target.rows[0];
    if (row.statut !== "APPLICABLE" || !row.is_current || row.indice !== fixture.versionIndice) {
      fail(`existing qualified version for ${fixture.pieceCode} is not the immutable presentation fixture`);
    }
    return;
  }
  const source = await client.query(
    `SELECT pt.id::text AS piece_id, v.matiere_prevue, v.manufacturing_mode, v.assembly_supply_strategy,
            COALESCE(v.version_interne, 0)::int AS version_interne
       FROM public.pieces_techniques pt
       JOIN public.piece_technique_versions v ON v.piece_technique_id = pt.id
      WHERE pt.code_piece = $1 AND v.indice = 'A' AND v.statut = 'APPLICABLE'
      LIMIT 1`,
    [fixture.pieceCode]
  );
  if (!source.rowCount) fail(`applicable source version A missing for ${fixture.pieceCode}`);
  const base = source.rows[0];
  // Mirrors the application publication ordering: obsolete the prior applicable
  // version before creating a new current applicable version. Existing OFs retain
  // their frozen technical snapshot and are never changed by this fixture.
  await client.query(
    `UPDATE public.piece_technique_versions
        SET statut = 'OBSOLETE', is_current = false, updated_at = now(), updated_by = $2
      WHERE piece_technique_id = $1::uuid AND statut = 'APPLICABLE'`,
    [base.piece_id, userId]
  );
  await client.query(
    `INSERT INTO public.piece_technique_versions (
       id, piece_technique_id, indice, plan_reference, matiere_prevue, statut, is_current,
       date_revision, date_validation, date_application, date_effet, version_interne,
       code_metier, code_metier_normalise, commentaire_revision, manufacturing_mode,
       assembly_supply_strategy, created_by, updated_by
     ) VALUES (
       $1::uuid,$2::uuid,$3,$4,$5,'APPLICABLE',true,
       now(),now(),CURRENT_DATE,CURRENT_DATE,$6,$7,$7,
       'Indice synthétique qualifié pour la présentation CERP+.', $8,$9,$10,$10
     )`,
    [fixture.versionId, base.piece_id, fixture.versionIndice, `PLAN-${fixture.pieceCode}-${fixture.versionIndice}`,
      base.matiere_prevue, Number(base.version_interne) + 1, `${fixture.pieceCode}-${fixture.versionIndice}`,
      base.manufacturing_mode, base.assembly_supply_strategy, userId]
  );
}

async function loadFixtureInput(client, fixture) {
  const technical = await client.query(
    `SELECT pt.id AS piece_id, pt.article_id, v.id AS version_id,
            v.statut AS version_status, v.is_current AS version_current, v.date_effet
       FROM public.pieces_techniques pt
       JOIN public.piece_technique_versions v ON v.piece_technique_id = pt.id
      WHERE pt.code_piece = $1 AND v.id = $2::uuid
      LIMIT 1`,
    [fixture.pieceCode, fixture.versionId]
  );
  if (!technical.rowCount) {
    fail(`base technical fixture ${fixture.pieceCode} missing; run scripts/seed-showcase-data.js first`);
  }

  const resource = await client.query(
    `SELECT m.id AS machine_id, p.id AS poste_id
       FROM public.machines m
       JOIN public.postes p ON p.machine_id = m.id
      WHERE m.code = $1 AND p.code = $2 AND m.is_available = true AND p.is_active = true
      LIMIT 1`,
    [fixture.machineCode, fixture.posteCode]
  );
  if (!resource.rowCount) {
    fail(`active resource ${fixture.machineCode}/${fixture.posteCode} missing; run scripts/seed-showcase-data.js first`);
  }
  return { ...fixture, ...technical.rows[0], ...resource.rows[0] };
}

async function ensureDemoPrimaryRole(client, userId) {
  // The production-readiness function requires every active account to have
  // its legacy primary role represented in the active multi-role catalogue.
  // DEMO remains a Director; no privileged or production-only account is made.
  await client.query("UPDATE public.users SET role = 'Directeur' WHERE id = $1", [userId]);
  await client.query(
    `INSERT INTO public.app_roles (role_key, category, description, is_active)
     VALUES ('Directeur', 'PRIMARY', 'Rôle principal du compte synthétique de démonstration.', true)
     ON CONFLICT (role_key) DO UPDATE SET category = 'PRIMARY', is_active = true, updated_at = now()`
  );
  await client.query(
    "INSERT INTO public.user_role_assignments (user_id, role_key) VALUES ($1, 'Directeur') ON CONFLICT (user_id, role_key) DO NOTHING",
    [userId]
  );
}

async function ensurePresentationReferenceData(client, inputs, userId) {
  // `u` is installed by the base showcase seed. The remaining three are the
  // canonical units seeded by 20260804_article_unit_stock_contract.
  for (const [code, label] of [["u", "Unité"], ["mm", "Millimètre"], ["m", "Mètre"], ["kg", "Kilogramme"]]) {
    await client.query(
      "INSERT INTO public.units (code, label) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING",
      [code, label]
    );
  }

  await client.query(
    `INSERT INTO public.programmation_calendars (
       id, code, label, timezone, working_days, day_start, day_end, active, created_by, updated_by
     ) VALUES ($1::uuid, 'DEMO-PRESENTATION', 'Calendrier atelier — démonstration',
       'Europe/Paris', ARRAY[1,2,3,4,5]::smallint[], '08:00', '17:00', true, $2, $2)
     ON CONFLICT (id) DO UPDATE SET
       code = EXCLUDED.code, label = EXCLUDED.label, timezone = EXCLUDED.timezone,
       working_days = EXCLUDED.working_days, day_start = EXCLUDED.day_start, day_end = EXCLUDED.day_end,
       active = true, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [REFERENCE.calendarId, userId]
  );
  // Parent required by centres_frais.machine_family_code. This is the
  // canonical F record from 20260729_methodes_gamme_referentials.
  await client.query(
    `INSERT INTO public.production_machine_families (
       code, libelle, description, programme_requis, est_favori, ordre_affichage, actif, created_by, updated_by
     ) VALUES ('F', 'Fraisage CN', 'Centres d''usinage à commande numérique.', true, true, 20, true, $1, $1)
     ON CONFLICT (code) DO UPDATE SET actif = true, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [userId]
  );
  await client.query(
    `INSERT INTO public.centres_frais (
       id, code, designation, type_cf, section, machine_family_code, statut, devise,
       commentaire, created_by, updated_by, updated_at
     ) VALUES ($1::uuid, 'DEMO-CF-USINAGE', 'Centre de frais usinage — démonstration',
       'PRODUCTION', 'ATELIER', 'F', 'ACTIF', 'EUR',
       'Référentiel synthétique réservé à la démonstration CERP+.', $2, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       code = EXCLUDED.code, designation = EXCLUDED.designation, type_cf = EXCLUDED.type_cf,
       section = EXCLUDED.section, machine_family_code = EXCLUDED.machine_family_code,
       statut = 'ACTIF', devise = 'EUR', archived_at = NULL,
       commentaire = EXCLUDED.commentaire, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [REFERENCE.costCenterId, userId]
  );
  await client.query(
    `INSERT INTO public.production_cost_center_rates (
       id, cf_id, taux_horaire, devise, date_effet, date_fin, source, commentaire, created_by
     ) VALUES ($1::uuid, $2::uuid, 72.50, 'EUR', CURRENT_DATE, NULL,
       'Référentiel synthétique CERP+ Démo', 'Taux fictif réservé à la présentation.', $3)
     ON CONFLICT (id) DO UPDATE SET
       taux_horaire = EXCLUDED.taux_horaire, devise = EXCLUDED.devise,
       date_effet = EXCLUDED.date_effet, date_fin = NULL, source = EXCLUDED.source,
       commentaire = EXCLUDED.commentaire`,
    [REFERENCE.costCenterRateId, REFERENCE.costCenterId, userId]
  );
  // The category mirrors the authoritative productive `PRODUCTION` category
  // from patch 20260726_production_execution_274, with a demo-facing label.
  await client.query(
    `INSERT INTO public.production_activity_categories (
       code, label, description, counts_operator_time, counts_machine_time, is_productive,
       requires_reason, criticality, signals_planning, signals_maintenance, signals_quality,
       legacy_time_type, legacy_of_time_log_type, sort_order, effective_from, disabled_at
     ) VALUES ('USINAGE', 'Usinage', 'Activité productive synthétique de démonstration.',
       true, true, true, false, 'NORMAL', false, false, false,
       'OPERATEUR', 'PRODUCTION', 21, CURRENT_DATE, NULL)
     ON CONFLICT (code) DO UPDATE SET
       label = EXCLUDED.label, description = EXCLUDED.description,
       counts_operator_time = true, counts_machine_time = true, is_productive = true,
       requires_reason = false, criticality = 'NORMAL', signals_planning = false,
       signals_maintenance = false, signals_quality = false,
       legacy_time_type = 'OPERATEUR', legacy_of_time_log_type = 'PRODUCTION',
       effective_from = CURRENT_DATE, disabled_at = NULL`,
  );

  for (const input of inputs) {
    await client.query(
      `UPDATE public.machines
          SET cf_id = $2::uuid, machine_family_code = $3, valid_from = COALESCE(valid_from, CURRENT_DATE), valid_to = NULL,
              updated_at = now(), updated_by = $4
        WHERE id = $1::uuid`,
      [input.machine_id, REFERENCE.costCenterId, input.machineFamilyCode, userId]
    );
    await client.query(
      `INSERT INTO public.planning_resource_calendars (resource_id, machine_id, calendar_id, display_label, version)
       VALUES ('machine:' || $1::uuid::text, $1::uuid, $2::uuid, 'Machine démonstration', 1)
       ON CONFLICT (machine_id) DO UPDATE SET
         resource_id = EXCLUDED.resource_id, calendar_id = EXCLUDED.calendar_id,
         display_label = EXCLUDED.display_label, version = public.planning_resource_calendars.version + 1`,
      [input.machine_id, REFERENCE.calendarId]
    );
  }
}

async function ensureApplicableGamme(client, input, userId) {
  // The OF snapshot selects only an applicable version whose effective date is
  // today or earlier. An APPLICABLE version is intentionally immutable: a
  // rerun verifies it and never touches it again.
  const effectiveDate = input.date_effet === null || input.date_effet === undefined ? null : new Date(input.date_effet);
  if (input.version_status === "APPLICABLE") {
    if (!input.version_current || (effectiveDate && effectiveDate.getTime() > Date.now() + 86_400_000)) {
      fail(`applicable technical version for ${input.pieceCode} is not usable; create a new synthetic version`);
    }
  } else {
    await client.query(
      `UPDATE public.piece_technique_versions
          SET statut = 'APPLICABLE', is_current = true, date_effet = CURRENT_DATE,
              date_validation = COALESCE(date_validation, now()), valide_par = COALESCE(valide_par, $2),
              updated_at = now(), updated_by = $2
        WHERE id = $1::uuid`,
      [input.version_id, userId]
    );
  }

  const existing = await client.query(
    `SELECT g.piece_technique_version_id, g.statut AS gamme_status, g.is_current AS gamme_current,
            o.id AS operation_id, o.gamme_id AS operation_gamme_id,
            o.phase, o.machine_id, o.cf_id, o.machine_family_code, o.tf_unit, o.temps_fabrication, o.temps_total
       FROM public.gammes g
       LEFT JOIN public.pieces_techniques_operations o ON o.id = $2::uuid
      WHERE g.id = $1::uuid`,
    [input.gammeId, input.operationId]
  );
  if ((existing.rowCount ?? existing.rows.length) > 0) {
    const row = existing.rows[0];
    const ready = row.piece_technique_version_id === input.version_id && row.gamme_status === "APPLICABLE" && row.gamme_current === true &&
      row.operation_id === input.operationId && row.operation_gamme_id === input.gammeId && Number(row.phase) === 10 && row.machine_id === input.machine_id && row.cf_id === REFERENCE.costCenterId &&
      row.machine_family_code === input.machineFamilyCode && Number(row.tf_unit) > 0 && Number(row.temps_fabrication) > 0 && Number(row.temps_total) > 0;
    if (ready) return;
    fail(`existing gamme or operation for ${input.pieceCode} is not a valid immutable presentation fixture`);
  }
  const orphanOperation = await client.query("SELECT id FROM public.pieces_techniques_operations WHERE id = $1::uuid", [input.operationId]);
  if ((orphanOperation.rowCount ?? orphanOperation.rows.length) > 0) {
    fail(`existing gamme or operation for ${input.pieceCode} is not a valid immutable presentation fixture`);
  }
  const otherCurrent = await client.query(
    "SELECT id FROM public.gammes WHERE piece_technique_version_id = $1::uuid AND is_current = true LIMIT 1",
    [input.version_id]
  );
  if ((otherCurrent.rowCount ?? otherCurrent.rows.length) > 0) {
    fail(`technical version for ${input.pieceCode} already has a different current gamme`);
  }
  await client.query(
    `INSERT INTO public.gammes (
       id, piece_technique_version_id, code, designation, nom, statut, is_current, created_by, updated_by
     ) VALUES ($1::uuid,$2::uuid,$3,$4,$4,'APPLICABLE',true,$5,$5)
     ON CONFLICT (id) DO NOTHING`,
    [input.gammeId, input.version_id, input.gammeCode, input.gammeDesignation, userId]
  );
  const totalTime = input.tp + input.tfUnit;
  await client.query(
    `INSERT INTO public.pieces_techniques_operations (
       id, piece_technique_id, gamme_id, phase, ordre, designation, type_operation,
       machine_id, poste_id, cf_id, machine_family_code, coef, tp, tf_unit, qte, taux_horaire,
       temps_fabrication, temps_total, cout_mo, consignes, created_by, updated_by
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::uuid,$10::uuid,$11,
       1,$12,$13,1,$14,$13,$15,$16,
       'Op�ration synth�tique pour le parcours de pr�sentation CERP+.',$17,$17
     ) ON CONFLICT (id) DO NOTHING`,
    [
      input.operationId, input.piece_id, input.gammeId, input.phase, input.ordre,
      input.operationDesignation, input.typeOperation, input.machine_id, input.poste_id, REFERENCE.costCenterId, input.machineFamilyCode,
      input.tp, input.tfUnit, input.hourlyRate, totalTime, totalTime * input.hourlyRate, userId,
    ]
  );
  // A presentation starts from a manufactured article with no finished-goods
  // balance. The synthetic material remains stocked by the base showcase seed.
  await client.query(
    `UPDATE public.stock_levels
        SET qty_total = 0, qty_reserved = 0, qty_depreciated = 0,
            updated_at = now(), updated_by = $2
      WHERE article_id = $1::uuid`,
    [input.article_id, userId]
  );
}

async function assertPresentationFixture(client, inputs) {
  for (const input of inputs) {
    const { rows } = await client.query(
      `SELECT v.statut AS version_status, v.is_current AS version_current, v.date_effet,
              g.statut AS gamme_status, g.is_current AS gamme_current,
              o.phase, o.machine_id, o.cf_id, o.machine_family_code, o.tf_unit, o.temps_fabrication, o.temps_total
         FROM public.piece_technique_versions v
         JOIN public.gammes g ON g.id = $2::uuid AND g.piece_technique_version_id = v.id
         JOIN public.pieces_techniques_operations o ON o.id = $3::uuid AND o.gamme_id = g.id
        WHERE v.id = $1::uuid`,
      [input.version_id, input.gammeId, input.operationId]
    );
    const row = rows[0];
    if (!row || row.version_status !== "APPLICABLE" || !row.version_current || !row.gamme_current ||
      row.gamme_status !== "APPLICABLE" || Number(row.phase) !== 10 || !row.machine_id || row.cf_id !== REFERENCE.costCenterId || row.machine_family_code !== input.machineFamilyCode ||
      Number(row.tf_unit) <= 0 || Number(row.temps_fabrication) <= 0 || Number(row.temps_total) <= 0) {
      fail(`readiness prerequisites invalid for ${input.pieceCode}`);
    }
    const stock = await client.query(
      `SELECT COALESCE(MAX(qty_total), 0)::text AS finished_qty
         FROM public.stock_levels WHERE article_id = $1::uuid`,
      [input.article_id]
    );
    if (Number(stock.rows[0]?.finished_qty ?? 0) !== 0) {
      fail(`finished article stock must be zero for ${input.pieceCode}`);
    }
  }
  const material = await client.query(
    `SELECT COALESCE(SUM(level.qty_total), 0)::text AS material_qty
       FROM public.articles article
       JOIN public.stock_levels level ON level.article_id = article.id
      WHERE article.code = 'DEMO-MAT-01'`
  );
  if (Number(material.rows[0]?.material_qty ?? 0) <= 0) {
    fail("synthetic material stock must be positive");
  }
}

async function main() {
  assertDemoEnvironment();
  const username = demoUsername();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const userId = await runStage("schema", () => assertSchemaAndAccount(client, username));
    // Keep the previous-version retirement and the new qualified fixture in
    // one transaction: an interruption never leaves the demo without a current
    // applicable version.
    await client.query("BEGIN");
    for (const fixture of FIXTURES) {
      await runStage(`version-${fixture.pieceCode}`, () => ensureQualifiedPresentationVersion(client, fixture, userId));
    }
    const inputs = [];
    for (const fixture of FIXTURES) {
      inputs.push(await runStage(`preflight-${fixture.pieceCode}`, () => loadFixtureInput(client, fixture)));
    }
    await runStage("demo-primary-role", () => ensureDemoPrimaryRole(client, userId));
    await runStage("reference-data", () => ensurePresentationReferenceData(client, inputs, userId));
    for (const input of inputs) {
      await runStage(`gamme-${input.pieceCode}`, () => ensureApplicableGamme(client, input, userId));
    }
    await runStage("readiness", () => assertPresentationFixture(client, inputs));
    await client.query("COMMIT");
    console.log("[presentation-seed] two synthetic applicable gammes and machine operations ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "[presentation-seed] failed");
    process.exitCode = 1;
  });
}

module.exports = {
  FIXTURES,
  REFERENCE,
  assertSchemaAndAccount,
  ensureQualifiedPresentationVersion,
  loadFixtureInput,
  ensureDemoPrimaryRole,
  ensurePresentationReferenceData,
  ensureApplicableGamme,
  assertPresentationFixture,
  main,
};
