import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resumeWipOpeningTx } from "../wip-opening/wip-opening.repository";
import { readWipOpeningCheckpointsTx } from "../wip-opening/wip-opening-read.repository";
import type { WipOpeningInput } from "../wip-opening/wip-opening.types";
import { bindWipMaterialOpeningTx, readWipMaterialOpeningProjectionTx, resolveWipMaterialCheckpointTx, validateWipMaterialOpeningTx } from "./wip-material-opening.repository";
import { readMaterialTx, getOfMaterial, configureOfMaterial } from "../repository/of-material.repository";
import { readMaterialOriginPolicyTx } from "../repository/of-material-policy.repository";

const url = process.env.CERP_WIP_SERVICE_INTEGRATION_URL;
const describePg = url ? describe : describe.skip;
let db: Pool;

const ids = {
  user: 991710,
  article: "17100000-0000-4000-8000-000000000001",
  piece: "17100000-0000-4000-8000-000000000002",
  version: "17100000-0000-4000-8000-000000000003",
  gamme: "17100000-0000-4000-8000-000000000004",
  center: "17100000-0000-4000-8000-000000000005",
  batch: "17100000-0000-4000-8000-000000000006",
  row: "17100000-0000-4000-8000-000000000007",
  opening: "17100000-0000-4000-8000-000000000008",
};

function assertDedicatedClone() {
  if (!url) throw new Error("Dedicated WIP test database is required");
  const parsed = new URL(url);
  if (!( ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "55471" && /^\/cerp_cutover_wip_service_1710_[a-z0-9_]+$/.test(parsed.pathname))) {
    throw new Error("Refusing a non-dedicated WIP database");
  }
}

async function applyPatches() {
  for (const name of [
    "20261020_01_data_cutover_preparation_1710.sql",
    "20261020_02_cutover_evidence_1710.sql",
    "20261020_03_cutover_opening_states_1710.sql",
    "20261020_04_data_cutover_application_1710.sql",
    "20261020_06_cutover_wip_resume_1710.sql",
    "20261020_07_cutover_wip_material_1710.sql",
  ]) await db.query(readFileSync(`db/patches/${name}`, "utf8"));
}

async function seed(tx: PoolClient) {
  // User and order writes invalidate planning. The isolated clone starts
  // empty, so create its normal planning singleton first instead of disabling
  // triggers that must stay active in a real resume.
  await tx.query("INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING");
  await tx.query(`INSERT INTO public.users(id,username,password,name,surname,email,role,status)
    VALUES($1,'WIP1710','$2b$10$wipFixtureOnly','Wip','Fixture','wip-fixture@example.invalid','Administrateur Systeme et Reseau','Active')
    ON CONFLICT(id) DO NOTHING`, [ids.user]);
  const client = await tx.query<{ client_id: string }>("INSERT INTO public.clients(client_id,client_code,company_name) VALUES('971','WIP-971','Client synthétique WIP') RETURNING client_id");
  const clientId = client.rows[0]!.client_id;
  await tx.query(`INSERT INTO public.commande_client(numero,client_id,code_client,date_commande,total_ht,total_ttc)
    VALUES('WIP-CMD-1710',$1,'WIP-971',CURRENT_DATE,0,0) RETURNING id`, [clientId]);
  const commandId = Number((await tx.query<{ id: string }>("SELECT id::text AS id FROM public.commande_client WHERE numero='WIP-CMD-1710' FOR KEY SHARE")).rows[0]!.id);
  await tx.query(`INSERT INTO public.pieces_techniques(id,client_id,name_piece,code_piece,designation,root_piece_technique_id,version_number)
    VALUES($1::uuid,$2,'Pièce WIP','WIP-1710','Pièce synthétique WIP',$1::uuid,1)`, [ids.piece, clientId]);
  await tx.query("INSERT INTO public.articles_fabrique_families(code,designation) VALUES('piece_finie','Pièces finies') ON CONFLICT(code) DO NOTHING");
  await tx.query(`INSERT INTO public.articles(id,root_article_id,code,designation,article_type,piece_technique_id,unite,lot_tracking,is_active,article_category,stock_managed,family_code,version_number,plan_index,status,is_sold,row_version)
    VALUES($1::uuid,$1::uuid,'WIP-1710','Article synthétique WIP','PIECE_TECHNIQUE',$2::uuid,'u',true,true,'fabrique',true,'piece_finie',1,1,'VALIDE',true,1)`, [ids.article, ids.piece]);
  await tx.query("UPDATE public.pieces_techniques SET article_id=$2::uuid WHERE id=$1::uuid", [ids.piece, ids.article]);
  await tx.query("INSERT INTO public.articles_fabrique(article_id,family_code,piece_technique_id) VALUES($1::uuid,'piece_finie',$2::uuid)", [ids.article, ids.piece]);
  await tx.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,date_revision,date_validation,date_application,version_interne,code_metier,code_metier_normalise,document_requirements_frozen_at,document_requirements_policy)
    VALUES($1::uuid,$2::uuid,'A','WIP-PLAN','APPLICABLE',true,now(),now(),CURRENT_DATE,1,'WIP-PLAN','WIP-PLAN',now(),'NONE')`, [ids.version, ids.piece]);
  await tx.query("INSERT INTO public.production_machine_families(code,libelle) VALUES('W','Famille WIP') ON CONFLICT(code) DO NOTHING");
  await tx.query("INSERT INTO public.centres_frais(id,code,designation,machine_family_code) VALUES($1::uuid,'WIP-CF','Centre WIP','W')", [ids.center]);
  await tx.query("INSERT INTO public.gammes(id,piece_technique_version_id,code,designation,statut,is_current,created_by,updated_by) VALUES($1::uuid,$2::uuid,'WIP-G','Gamme WIP','APPLICABLE',true,$3,$3)", [ids.gamme, ids.version, ids.user]);
  for (const phase of [10, 20]) await tx.query(`INSERT INTO public.pieces_techniques_operations(piece_technique_id,gamme_id,phase,ordre,designation,type_operation,cf_id,machine_family_code,coef,tp,tf_unit,qte,taux_horaire,temps_fabrication,temps_total,cout_mo)
    VALUES($1::uuid,$2::uuid,$3,$3,'Opération WIP','FRAISAGE',$4::uuid,'W',1,0,1,1,0,1,1,0)`, [ids.piece, ids.gamme, phase, ids.center]);
  const line = await tx.query<{ id: string }>(`INSERT INTO public.commande_ligne(commande_id,designation,quantite,unite,prix_unitaire_ht,article_id,piece_technique_id,piece_technique_version_id,sale_price_decision,reconciliation_status,reconciliation_sources,reconciliation_decisions)
    VALUES($1,'Ligne WIP',5,'u',1,$2::uuid,$3::uuid,$4::uuid,'KEEP','RESOLVED','{}'::jsonb,'{}'::jsonb) RETURNING id::text AS id`, [commandId, ids.article, ids.piece, ids.version]);
  const affair = await tx.query<{ id: string }>("INSERT INTO public.affaire(reference,client_id,commande_id,type_affaire,statut,date_ouverture) VALUES('AFF-WIP-1710',$2,$1,'livraison','OUVERTE',CURRENT_DATE) RETURNING id::text AS id", [commandId, clientId]);
  await tx.query(`INSERT INTO public.commande_ligne_affaire_allocation(commande_id,commande_ligne_id,livraison_affaire_id,article_ref_id,qty_ordered,qty_from_stock,qty_reserved,qty_to_produce,qty_produced,qty_stocked,qty_delivered,qty_remaining,allocation_version,delivery_status)
    VALUES($1,$2::bigint,$3::bigint,$4::uuid,5,0,0,5,0,0,0,5,1,'A_PREPARER')`, [commandId, line.rows[0]!.id, affair.rows[0]!.id, ids.article]);
  await tx.query(`INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by)
    VALUES($1::uuid,'WIP PG fixture','CLIPPER_EXCEL',repeat('a',64),'[]'::jsonb,$2)`, [ids.batch, ids.user]);
  await tx.query(`INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,"values",updated_by)
    VALUES($1::uuid,$2::uuid,'WIP','WIP:fixture','fixture','WIP',2,'{}'::jsonb,'{}'::jsonb,$3)`, [ids.row, ids.batch, ids.user]);
  await tx.query(`INSERT INTO public.data_cutover_opening_states(id,batch_id,row_id,opening_kind,domain,source_system,state,provenance,created_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,'WIP','WIP','CLIPPER_EXCEL','{}'::jsonb,'{}'::jsonb,$4)`, [ids.opening, ids.batch, ids.row, ids.user]);
  return { commandId: String(commandId), commandLineId: line.rows[0]!.id, deliveryAffairId: affair.rows[0]!.id };
}

describePg("native WIP material service on dedicated schema", () => {
  beforeAll(async () => {
    assertDedicatedClone(); db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (!/^cerp_cutover_wip_service_1710_[a-z0-9_]+$/.test(identity.rows[0]?.name ?? "")) throw new Error("Unexpected WIP clone");
    await applyPatches();
  });
  afterAll(async () => { await db?.end(); });

  it("creates one native draft OF and immutable opening checkpoints without fake declarations, and rolls back the fixture", async () => {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const target = await seed(tx);
      const input: WipOpeningInput = {
        openingStateId: ids.opening, batchId: ids.batch, rowId: ids.row, sourceSystem: "CLIPPER_EXCEL", operationKey: "fixture-wip-1710",
        articleId: ids.article, pieceTechniqueId: ids.piece, historicalVersionId: ids.version,
        affair: { type: "COMMANDE_CLIENT", id: target.commandId, commandLineId: target.commandLineId, deliveryAffairId: target.deliveryAffairId },
        quantityLaunched: 5, historicalInitialQuantity: 8, unit: "u", physicalBatchReference: "WIP-PHYSICAL-1710",
        materialScope: "NONE", checkpoints: [
          { phase: 10, status: "COMPLETED", quantityGood: 5, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "GED-FIXTURE-10" },
          { phase: 20, status: "IN_PROGRESS", quantityGood: 0, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: "GED-FIXTURE-20" },
        ], actorId: ids.user,
      };
      const result = await resumeWipOpeningTx(tx, input, { resolveMaterialCheckpoint: async () => ({ requiresMaterial: false, checkpointId: null, physicalBatchReference: null }) });
      expect(result.ofReference).toMatch(/^OF-/);
      const checkpoints = await readWipOpeningCheckpointsTx(tx, result.ofId);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0]).toMatchObject({ status: "COMPLETED", quantityGood: 5, origin: "CUTOVER_OPENING" });
      expect(checkpoints[1]).toMatchObject({ status: "IN_PROGRESS", quantityGood: 0 });
      const effects = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM public.production_quantity_declarations WHERE of_id=$1::bigint", [result.ofId]);
      expect(effects.rows[0]?.n).toBe(0);

      const createOpening = async () => {
        const rowId = randomUUID(), openingId = randomUUID();
        await tx.query(`INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,"values",updated_by)
          VALUES($1::uuid,$2::uuid,'WIP',$3,'fixture','WIP',3,'{}'::jsonb,'{}'::jsonb,$4)`, [rowId, ids.batch, `WIP:${rowId}`, ids.user]);
        await tx.query(`INSERT INTO public.data_cutover_opening_states(id,batch_id,row_id,opening_kind,domain,source_system,state,provenance,created_by)
          VALUES($1::uuid,$2::uuid,$3::uuid,'WIP','WIP','CLIPPER_EXCEL','{}'::jsonb,'{}'::jsonb,$4)`, [openingId, ids.batch, rowId, ids.user]);
        return { rowId, openingId };
      };
      const duplicate = await createOpening();
      await expect(resumeWipOpeningTx(tx, { ...input, rowId: duplicate.rowId, openingStateId: duplicate.openingId }, { resolveMaterialCheckpoint: async () => ({ requiresMaterial: false, checkpointId: null, physicalBatchReference: null }) })).rejects.toMatchObject({ code: "CUTOVER_WIP_PHYSICAL_BATCH_DUPLICATE" });
      const excess = await createOpening();
      await expect(resumeWipOpeningTx(tx, {
        ...input, rowId: excess.rowId, openingStateId: excess.openingId, physicalBatchReference: "WIP-PHYSICAL-1710-EXCESS", quantityLaunched: 6,
        checkpoints: [{ ...input.checkpoints[0], quantityGood: 6 }, input.checkpoints[1]],
      }, { resolveMaterialCheckpoint: async () => ({ requiresMaterial: false, checkpointId: null, physicalBatchReference: null }) })).rejects.toMatchObject({ code: "CUTOVER_WIP_REMAINING_QUANTITY_EXCEEDED" });
      expect((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM public.ordres_fabrication WHERE notes='Reprise encours WIP-PHYSICAL-1710'")).rows[0]?.n).toBe(1);
      await expect(resumeWipOpeningTx(tx, {
        ...input, quantityLaunched: 4,
        checkpoints: [{ ...input.checkpoints[0], quantityGood: 4 }, input.checkpoints[1]],
      }, { resolveMaterialCheckpoint: async () => ({ requiresMaterial: false, checkpointId: null, physicalBatchReference: null }) })).rejects.toMatchObject({ code: "CUTOVER_WIP_IDEMPOTENCY_CONFLICT" });
      await tx.query("ROLLBACK");
    } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  });

  it("configures native material through the real service after a committed WIP opening without double debit", async () => {
    const tx = await db.connect();
    let resumed: { ofId: number } | undefined;
    let purchase = "";
    try {
      await tx.query("BEGIN");
      const target = await seed(tx);
      const materialArticle = randomUUID();
      const physicalLot = randomUUID();
      purchase = randomUUID();
      await tx.query(`INSERT INTO public.articles(id,root_article_id,code,designation,article_type,unite,lot_tracking,is_active,article_category,stock_managed,family_code,version_number,plan_index,status,is_sold,row_version)
        VALUES($1::uuid,$1::uuid,$2,'Matière synthétique WIP service','PURCHASED','kg',true,true,'matiere',true,'matiere_premiere',1,1,'VALIDE',false,1)`, [materialArticle, `WIP-MAT-SVC-${Date.now()}`]);
      await tx.query(`INSERT INTO public.pieces_techniques_achats(id,piece_technique_id,phase,nom,designation,type_achat,article_id,quantite,unite_prix)
        VALUES($1::uuid,$2::uuid,10,'Brut WIP service','Brut WIP service','MATIERE',$3::uuid,1,'kg')`, [purchase, ids.piece, materialArticle]);
      await tx.query(`INSERT INTO public.lots(id,article_id,lot_code,lot_status,source_scope,stock_scope,created_by,updated_by)
        VALUES($1::uuid,$2::uuid,'WIP-LEGACY-SERVICE','LIBERE','OLD','OLD',$3,$3)`, [physicalLot, materialArticle, ids.user]);
      const material = await validateWipMaterialOpeningTx(tx, {
        openingStateId: ids.opening, batchId: ids.batch, rowId: ids.row, articleId: ids.article,
        pieceTechniqueId: ids.piece, historicalVersionId: ids.version, physicalBatchReference: 'WIP-PHYSICAL-SERVICE-1710',
        quantityLaunched: 5, materialState: 'ALL_ALREADY_CONSUMED', actorId: ids.user,
        requirements: [{ technicalPurchaseId: purchase, articleId: materialArticle, unit: 'kg', quantityConsumed: 5,
          physicalLotId: physicalLot, qualityStatus: 'LIBERE', evidenceReference: 'GED-WIP-MAT-SERVICE-1710' }],
      });
      const input: WipOpeningInput = {
        openingStateId: ids.opening, batchId: ids.batch, rowId: ids.row, sourceSystem: 'CLIPPER_EXCEL', operationKey: 'fixture-wip-material-service-1710',
        articleId: ids.article, pieceTechniqueId: ids.piece, historicalVersionId: ids.version,
        affair: { type: 'COMMANDE_CLIENT', id: target.commandId, commandLineId: target.commandLineId, deliveryAffairId: target.deliveryAffairId },
        quantityLaunched: 5, historicalInitialQuantity: 5, unit: 'u', physicalBatchReference: 'WIP-PHYSICAL-SERVICE-1710',
        materialScope: 'SINGLE_BATCH_VALIDATED', materialCheckpointId: material.checkpointId, materialEvidenceReference: 'GED-WIP-MAT-SERVICE-1710', actorId: ids.user,
        checkpoints: [
          { phase: 10, status: 'COMPLETED', quantityGood: 5, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: 'GED-FIXTURE-10' },
          { phase: 20, status: 'IN_PROGRESS', quantityGood: 0, quantityScrap: 0, quantityPendingControl: 0, evidenceReference: 'GED-FIXTURE-20' },
        ],
      };
      resumed = await resumeWipOpeningTx(tx, input, { resolveMaterialCheckpoint: resolveWipMaterialCheckpointTx });
      await bindWipMaterialOpeningTx(tx, input, resumed.ofId);
      await tx.query(`INSERT INTO public.app_feature_flags(key,name,description,enabled,environment)
        VALUES('PRODUCTION_MATERIAL_WORKFLOW','Fixture parcours matière','Activation limitée à la base jetable de preuve.',true,'test')
        ON CONFLICT(key) DO UPDATE SET enabled=true`);
      await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
    if (!resumed) throw new Error('Expected resumed OF');

    const virtual = await getOfMaterial(resumed.ofId);
    if (!virtual.enabled) throw new Error('Material workflow must be enabled for the isolated service fixture');
    const virtualNeed = virtual.needs.find((item) => item.key === purchase);
    expect(virtualNeed).toMatchObject({ id: null, openingConsumed: 5, consumed: 5, consumptionOrigins: ['CUTOVER_OPENING'] });
    const originPolicy = await readMaterialOriginPolicyTx(db, [resumed.ofId]);
    expect(originPolicy.usedOrigins).toHaveLength(1);

    const configured = await configureOfMaterial(resumed.ofId, purchase, {
      expectedVersion: virtual.version, idempotencyKey: randomUUID(),
      configuration: {
        operationId: virtual.operations.find((operation) => operation.phase === 10)!.id,
        requirements: { grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualChecks: [] },
        supplyMode: 'PURCHASE', supplierId: null, destinationId: null, allowPartial: false,
        debitRule: { form: 'UNIT', stockUnit: 'kg', unitsPerBlank: 1, kerfPerBlank: 0, yieldValidated: true },
      },
    }, { user_id: ids.user } as never);
    expect(configured.needs.find((item) => item.key === purchase)).toMatchObject({ openingConsumed: 5, consumed: 5, consumptionOrigins: ['CUTOVER_OPENING'] });

    await expect(configureOfMaterial(resumed.ofId, purchase, {
      expectedVersion: configured.version, idempotencyKey: randomUUID(),
      configuration: {
        operationId: configured.operations.find((operation) => operation.phase === 20)!.id,
        requirements: { grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualChecks: [] },
        supplyMode: 'PURCHASE', supplierId: null, destinationId: null, allowPartial: false,
        debitRule: { form: 'UNIT', stockUnit: 'kg', unitsPerBlank: 1, kerfPerBlank: 0, yieldValidated: true },
      },
    }, { user_id: ids.user } as never)).rejects.toMatchObject({ code: 'MATERIAL_DEBIT_DEFINITION_FROZEN' });

    const effects = await db.query<{ n: number }>(`SELECT ((SELECT count(*) FROM public.production_material_debits WHERE of_id=$1::bigint)
      +(SELECT count(*) FROM public.stock_movements WHERE source_document_id=$1::text)
      +(SELECT count(*) FROM public.production_quantity_declarations WHERE of_id=$1::bigint))::int AS n`, [resumed.ofId]);
    expect(effects.rows[0]?.n).toBe(0);
  });

});
