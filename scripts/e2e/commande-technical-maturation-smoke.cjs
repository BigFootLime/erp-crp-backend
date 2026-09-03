/* eslint-disable no-console */
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const path = require("node:path")

require("dotenv").config({ path: process.env.CERP_SMOKE_ENV || path.resolve(process.cwd(), ".env") })

const pool = require("../../dist/config/database").default
const {
  repoCreateQuickTechnicalPiece,
} = require("../../dist/module/commande-client/repository/commande-quick-piece.repository")
const {
  repoAnalyzeCommandeStock,
  repoCreateCommande,
  repoGenerateAffairesFromOrder,
} = require("../../dist/module/commande-client/repository/commande-client.repository")

async function main() {
  const context = await pool.query(`
    SELECT current_database() AS database_name,
           (SELECT id FROM public.users WHERE lower(status) = 'active' ORDER BY id LIMIT 1)::int AS user_id,
           (SELECT role::text FROM public.users WHERE lower(status) = 'active' ORDER BY id LIMIT 1) AS user_role,
           (SELECT client_id FROM public.clients ORDER BY client_id LIMIT 1)::text AS client_id
  `)
  const row = context.rows[0]
  assert.equal(row.database_name, "cerp_test", "Ce smoke test refuse toute base autre que cerp_test.")
  assert.ok(row.user_id, "Aucun utilisateur actif de test.")
  assert.ok(row.client_id, "Aucun client de test.")

  const suffix = `${Date.now()}-${crypto.randomBytes(2).toString("hex")}`
  const body = {
    client_id: row.client_id,
    reference: `TEST-CODEX-698-${suffix}`.slice(0, 100),
    indice_client: "A",
    designation: "Pièce de validation maturation technique",
    plan_reference: `PLAN-TEST-${suffix}`.slice(0, 160),
  }
  const key = `test-commande-quick-piece-${crypto.randomUUID()}`
  const audit = {
    user_id: row.user_id,
    user_role: row.user_role,
    ip: null,
    user_agent: "cerp-test-smoke",
    device_type: null,
    os: null,
    browser: null,
    path: "/scripts/e2e/commande-technical-maturation-smoke",
    page_key: "commandes",
    client_session_id: crypto.randomUUID(),
  }

  const created = await repoCreateQuickTechnicalPiece(body, audit, key)
  const replay = await repoCreateQuickTechnicalPiece(body, audit, key)
  assert.deepEqual(replay, created, "Le rejeu idempotent doit retourner les mêmes objets.")
  assert.equal(created.technical_status, "BROUILLON")

  let mismatchRejected = false
  try {
    await repoCreateQuickTechnicalPiece({ ...body, designation: `${body.designation} modifiée` }, audit, key)
  } catch (error) {
    mismatchRejected = error?.status === 409 || error?.statusCode === 409
  }
  assert.equal(mismatchRejected, true, "Une clé rejouée avec un autre contenu doit être refusée.")

  const persisted = await pool.query(
    `SELECT p.id::text AS piece_id, v.statut::text AS version_status,
            v.version_interne::int AS internal_version, a.id::text AS article_id,
            a.status::text AS article_status
       FROM public.pieces_techniques p
       JOIN public.piece_technique_versions v ON v.id = $2::uuid
       JOIN public.articles a ON a.id = $3::uuid
      WHERE p.id = $1::uuid
        AND a.piece_technique_id = p.id`,
    [created.piece_technique_id, created.piece_technique_version_id, created.article_id]
  )
  assert.equal(persisted.rowCount, 1)
  assert.equal(persisted.rows[0].version_status, "BROUILLON")
  assert.equal(persisted.rows[0].internal_version, 1)
  assert.equal(persisted.rows[0].article_status, "VALIDE")

  const deliveryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const commande = await repoCreateCommande({
    client_id: row.client_id,
    creation_flow_version: 2,
    save_intent: "VALIDATE",
    date_commande: new Date().toISOString().slice(0, 10),
    code_client: `PO-CODEX-${suffix}`.slice(0, 80),
    order_type: "FERME",
    commentaire: "Commande jetable de validation du flux #698",
    remise_globale: 0,
    total_ht: 125,
    total_ttc: 150,
    lignes: [{
      article_id: created.article_id,
      piece_technique_id: created.piece_technique_id,
      piece_technique_version_id: created.piece_technique_version_id,
      designation: created.designation,
      code_piece: created.reference,
      quantite: 5,
      unite: "u",
      prix_unitaire_ht: 25,
      remise_ligne: 0,
      taux_tva: 20,
      delai_client: deliveryDate,
      famille: "PT",
      reconciliation: {
        status: "RESOLVED",
        sources: {},
        decisions: {
          designation: "CERP",
          quantite: "ORDER",
          unite: "CERP",
          prix_unitaire_ht: "CERP",
          delai_client: "ORDER",
          piece_technique_version_id: "CERP",
        },
      },
    }],
  }, [], row.user_id)
  assert.ok(commande.id)

  const analysis = await repoAnalyzeCommandeStock(String(commande.id), audit)
  assert.equal(analysis.lines.length, 1)
  assert.equal(analysis.lines[0].shortage_qty, 5)

  const generated = await repoGenerateAffairesFromOrder(String(commande.id), {
    decision: "SHIP_ALL_TOGETHER",
    livraison_count: 1,
    lines: [],
  }, audit)
  assert.ok(generated.principal_affaire_id)
  assert.equal(generated.delivery_tranches.length, 1)
  assert.equal(generated.draft_of_ids.length, 1)
  assert.ok(generated.technical_warnings.length > 0)

  const generatedReplay = await repoGenerateAffairesFromOrder(String(commande.id), {
    decision: "SHIP_ALL_TOGETHER",
    livraison_count: 1,
    lines: [],
  }, audit)
  assert.equal(generatedReplay.principal_affaire_id, generated.principal_affaire_id)
  assert.deepEqual(generatedReplay.draft_of_ids, generated.draft_of_ids)

  console.log(JSON.stringify({
    ok: true,
    database: row.database_name,
    article_id: created.article_id,
    piece_technique_id: created.piece_technique_id,
    piece_technique_version_id: created.piece_technique_version_id,
    commande_id: commande.id,
    principal_affaire_id: generated.principal_affaire_id,
    delivery_tranche_ids: generated.delivery_tranches.map((tranche) => tranche.affaire_id),
    draft_of_ids: generated.draft_of_ids,
    idempotent_replay: true,
    conflicting_replay_rejected: true,
    command_generation_replay: true,
  }))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
