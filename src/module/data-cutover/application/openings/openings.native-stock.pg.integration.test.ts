import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoCreateHistoricalImportTx } from "../../../stock/repository/stock.repository";
import { historicalImportSchema } from "../../../stock/validators/stock.validators";
import { repoCreatePieceTechniqueCutoverTx } from "../../../pieces-techniques/repository/pieces-techniques.repository";
import { createPieceTechniqueSchema } from "../../../pieces-techniques/validators/pieces-techniques.validators";
import { repoCreateArticleTx } from "../../../stock/repository/stock.repository";
import { createArticleSchema } from "../../../stock/validators/stock.validators";

const url = process.env.CERP_CUTOVER_NATIVE_STOCK_URL;
const describePg = url ? describe : describe.skip;
const ids = {
  article: "f0a00171-2026-4a01-8a01-000000000001",
  warehouse: "f0a00171-2026-4a01-8a01-000000000002",
  magasin: "f0a00171-2026-4a01-8a01-000000000003",
  pfWarehouse: "f0a00171-2026-4a01-8a01-000000000004",
  pfMagasin: "f0a00171-2026-4a01-8a01-000000000005",
};
const audit = {
  user_id: 1,
  role: "SuperAdmin",
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/cutover-test",
  page_key: "cutover-test",
  client_session_id: null,
};
let db: Pool;

function assertDedicatedClone() {
  if (!url || process.env.DATABASE_URL !== url) throw new Error("The dedicated native stock clone is required");
  const parsed = new URL(url);
  if (!(["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "55471" && parsed.pathname === "/cerp_cutover_native_1710")) {
    throw new Error("Refusing a non-disposable native stock database");
  }
}

async function applyCutoverPatches() {
  for (const name of [
    "20261020_01_data_cutover_preparation_1710.sql",
    "20261020_02_cutover_evidence_1710.sql",
    "20261020_03_cutover_opening_states_1710.sql",
    "20261020_04_data_cutover_application_1710.sql",
  ]) {
    await db.query(readFileSync(`db/patches/${name}`, "utf8"));
  }
}

async function seedNativePrerequisites(client: PoolClient): Promise<string> {
  await client.query("INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING");
  await client.query("INSERT INTO public.users(id,username,password,name,surname,email,role,status) VALUES(1,'cutover-native-stock','$2b$10$2b2xOYbkQN.mZSOEbttK8uF.4RF6W2Ah4D.yMY0J9ZwT4xteq1RQC','Cutover','Stock','cutover-native-stock@example.invalid','Administrateur Systeme et Reseau','Active') ON CONFLICT(id) DO UPDATE SET role=EXCLUDED.role,status='Active'");
  const owner = await client.query<{ client_id: string }>("INSERT INTO public.clients(client_id,client_code,company_name) VALUES('001','CUT-001','Client synthétique de reprise') ON CONFLICT(client_id) DO UPDATE SET company_name=EXCLUDED.company_name RETURNING client_id::text AS client_id");
  const ownerId = owner.rows[0]?.client_id;
  if (!ownerId || !/^\d{3}$/.test(ownerId)) throw new Error("Synthetic stock owner must retain the canonical three-digit format");
  await client.query("INSERT INTO public.app_roles(role_key,category,description,is_active) VALUES('Administrateur Systeme et Reseau','PRIMARY','Rôle synthétique de test',true) ON CONFLICT(role_key) DO NOTHING");
  await client.query("INSERT INTO public.user_role_assignments(user_id,role_key,assigned_by) VALUES(1,'Administrateur Systeme et Reseau',1) ON CONFLICT(user_id,role_key) DO NOTHING");
  await client.query("INSERT INTO public.units(code,label) VALUES('u','Unité'),('mm','Millimètre'),('m','Mètre'),('kg','Kilogramme') ON CONFLICT(code) DO NOTHING");
  await client.query("INSERT INTO public.currencies(code,name) VALUES('EUR','Euro') ON CONFLICT(code) DO NOTHING");
  await client.query("INSERT INTO public.erp_settings(key,value_text,definition,unit,period_start,source,freshness_at,reliability,created_by,updated_by) VALUES('stock.valuation_method','FIFO','Méthode synthétique dédiée au test','METHOD',CURRENT_DATE,'test intégré',now(),'VERIFIED',1,1) ON CONFLICT(key) DO NOTHING");
  await client.query("INSERT INTO public.warehouses(id,code,name,stock_scope) VALUES($1::uuid,'OLD-MP','Base old - Matières premières','OLD') ON CONFLICT(code) DO NOTHING", [ids.warehouse]);
  await client.query("INSERT INTO public.magasins(id,code,code_magasin,name,libelle,warehouse_id,stock_scope,is_active,actif) VALUES($1::uuid,'OLD-MP','OLD-MP','Base old - Matières premières','Base old - Matières premières',$2::uuid,'OLD',true,true) ON CONFLICT(code) DO NOTHING", [ids.magasin, ids.warehouse]);
  await client.query("INSERT INTO public.warehouses(id,code,name,stock_scope) VALUES($1::uuid,'OLD-PF','Base old - Pièces finies','OLD') ON CONFLICT(code) DO NOTHING", [ids.pfWarehouse]);
  await client.query("INSERT INTO public.magasins(id,code,code_magasin,name,libelle,warehouse_id,stock_scope,is_active,actif) VALUES($1::uuid,'OLD-PF','OLD-PF','Base old - Pièces finies','Base old - Pièces finies',$2::uuid,'OLD',true,true) ON CONFLICT(code) DO NOTHING", [ids.pfMagasin, ids.pfWarehouse]);
  const location = await client.query<{ id: string }>("INSERT INTO public.locations(warehouse_id,code,description) VALUES($1::uuid,'CUT-READY','Emplacement synthétique de préparation') ON CONFLICT(warehouse_id,code) DO UPDATE SET description=EXCLUDED.description RETURNING id::text AS id", [ids.warehouse]);
  await client.query("INSERT INTO public.emplacements(magasin_id,location_id,code,name,is_scrap,is_active,location_type,allow_inbound,allow_outbound,restrictions,created_by,updated_by) VALUES($1::uuid,$2::uuid,'CUT-READY','Emplacement synthétique de préparation',false,true,'STORAGE',true,true,'{}'::jsonb,1,1) ON CONFLICT(magasin_id,code) DO UPDATE SET location_id=EXCLUDED.location_id,is_active=true", [ids.magasin, location.rows[0]!.id]);
  await client.query(
    `INSERT INTO public.articles(
       id,root_article_id,code,designation,family_code,version_number,plan_index,status,
       article_type,article_category,unite,stock_managed,lot_tracking,is_active,created_by,updated_by
     ) VALUES($1::uuid,$1::uuid,'CUT-MP-OLD','Matière synthétique OLD','CUT',1,1,'VALIDE',
       'PURCHASED','matiere','kg',true,true,true,1,1)
     ON CONFLICT(id) DO UPDATE SET stock_managed=true,lot_tracking=true,is_active=true`,
    [ids.article],
  );
  return ownerId;
}

describePg("native OLD opening on the complete stock schema", () => {
  beforeAll(async () => {
    assertDedicatedClone();
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_native_1710") throw new Error("Unexpected native stock clone identity");
    await applyCutoverPatches();
  });
  afterAll(async () => { await db?.end(); });

  it("posts one OLD material opening through native triggers, preserves owner/quality/lot, replays once, then rolls everything back", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const ownerClientId = await seedNativePrerequisites(client);
      const readiness = await client.query<{ prerequisite_code: string; ready: boolean }>("SELECT prerequisite_code, ready FROM public.fn_business_prerequisite_status_v2('STOCK') ORDER BY prerequisite_code");
      const missing = readiness.rows.filter((item) => !item.ready).map((item) => item.prerequisite_code);
      if (missing.length) throw new Error(`Synthetic stock prerequisites incomplete: ${missing.join(",")}`);
      const body = historicalImportSchema.parse({ body: {
        kind: "MP",
        article_id: ids.article,
        quantity: 12.5,
        unite: "kg",
        lot_number: "CUT-FOU-LOT-001",
        historical_lot_reference: "CLIPPER-LOT-001",
        supplier_lot_code: "SUP-CUT-LOT-001",
        historical_shelf: "RACK-CUT-01",
        historical_lot_status: "LIBERE",
        owner_client_id: ownerClientId,
        notes: "Donnée synthétique : exercice de reprise OLD native",
        historical_traceability: { certificate_reference: "EN-10204-3.1-CUT", heat_number: "HEAT-CUT-01", source: { legacy_key: "STOCK:CUT-1", source_id: "cutover-test", sheet: "Stock", row_number: 2 } },
      } }).body;
      const first = await repoCreateHistoricalImportTx(client, body, audit, "cutover-native-stock-old-001");
      const replay = await repoCreateHistoricalImportTx(client, body, audit, "cutover-native-stock-old-001");
      expect(replay.replayed).toBe(true);
      expect(replay.lot_id).toBe(first.lot_id);
      const lot = await client.query<{ stock_scope: string; lot_status: string; owner: string | null; supplier_lot_code: string | null; material_properties: unknown }>(
        "SELECT stock_scope, lot_status, client_proprietaire_id::text AS owner, supplier_lot_code, material_properties FROM public.lots WHERE id=$1::uuid",
        [first.lot_id],
      );
      expect(lot.rows[0]).toMatchObject({ stock_scope: "OLD", lot_status: "LIBERE", owner: ownerClientId, supplier_lot_code: "SUP-CUT-LOT-001", material_properties: { certificate_reference: "EN-10204-3.1-CUT", heat_number: "HEAT-CUT-01", source: { legacy_key: "STOCK:CUT-1" } } });
      const traces = await client.query<{ reference_type: string; reference_value: string }>(
        "SELECT reference_type, reference_value FROM public.stock_lot_trace_references WHERE lot_id=$1::uuid ORDER BY reference_type",
        [first.lot_id],
      );
      expect(traces.rows).toEqual([
        { reference_type: "HISTORICAL_LOT", reference_value: "CLIPPER-LOT-001" },
        { reference_type: "MP_LOT", reference_value: "CUT-FOU-LOT-001" },
      ]);
      const effects = await client.query<{ movements: number; receipts: number; lines: number }>(
        `SELECT
           (SELECT count(*)::int FROM public.stock_movements WHERE source_document_type='CERP_HISTORICAL_OPENING') AS movements,
           (SELECT count(*)::int FROM public.stock_command_receipts WHERE idempotency_key='cutover-native-stock-old-001') AS receipts,
           (SELECT count(*)::int FROM public.stock_movement_lines WHERE movement_id=$1::uuid) AS lines`,
        [first.movement_id],
      );
      expect(effects.rows).toEqual([{ movements: 1, receipts: 1, lines: 1 }]);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect((await db.query("SELECT count(*)::int AS count FROM public.lots WHERE supplier_lot_code='CUT-FOU-LOT-001'")).rows[0]?.count).toBe(0);
  });

  it("requires the selected PF technical version and matching article unit before creating an OLD movement", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const ownerClientId = await seedNativePrerequisites(client);
      await client.query("INSERT INTO public.article_category_ref(code,label) VALUES('piece_finie_fabriquee','Pièce finie fabriquée') ON CONFLICT(code) DO NOTHING");
      await client.query("INSERT INTO public.articles_fabrique_families(code,designation) VALUES('CUT','Famille synthétique') ON CONFLICT(code) DO NOTHING");
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const plan = `PF-${suffix}`;
      const pieceBody = createPieceTechniqueSchema.parse({ body: {
        client_id: ownerClientId, code_client: "CUT-001", name_piece: `PF ${suffix}`, designation: `PF ${suffix}`,
        plan_reference: plan, indice_externe: "A", sans_indice: false, statut: "DRAFT", en_fabrication: false, bom: [], operations: [], achats: [],
      } }).body;
      const piece = await repoCreatePieceTechniqueCutoverTx(client, { ...pieceBody, en_fabrication: false } as Parameters<typeof repoCreatePieceTechniqueCutoverTx>[1], audit, randomUUID());
      const articleBody = createArticleSchema.parse({ body: {
        designation: `Article PF ${suffix}`, article_type: "PIECE_TECHNIQUE", article_category: "fabrique", article_categories: ["piece_finie_fabriquee"],
        family_code: "CUT", internal_reference: `PF-${suffix}`, unite: "u", piece_technique_id: piece.piece.id,
        stock_managed: true, lot_tracking: true, is_sold: true, is_active: true, status: "VALIDE", commercial_scope: "CLIENTS", client_ids: [ownerClientId],
      } }).body;
      const article = await repoCreateArticleTx(client, articleBody, audit);
      const version = await client.query<{ id: string }>("SELECT id::text AS id FROM public.piece_technique_versions WHERE piece_technique_id=$1::uuid AND plan_reference=$2 AND indice_externe_original='A'", [piece.piece.id, plan]);
      const versionId = version.rows[0]?.id;
      if (!versionId) throw new Error("Synthetic PF version was not created");
      const base = {
        kind: "PF" as const, client_number: "CUT-001", article_id: article.id, technical_version_id: versionId, unite: "u", quantity: 1,
        of_affaire_refs: [], mp_lot_refs: [], traitement_lot_refs: [], historical_lot_reference: `PF-LOT-${suffix}`,
        historical_shelf: "PF-TEST", historical_lot_status: "LIBERE" as const, owner_client_id: ownerClientId,
      };
      const ok = historicalImportSchema.parse({ body: base }).body;
      const posted = await repoCreateHistoricalImportTx(client, ok, audit, `cutover-pf-ok-${suffix}`);
      const lot = await client.query<{ version_id: string; scope: string }>("SELECT piece_technique_version_id::text AS version_id, stock_scope AS scope FROM public.lots WHERE id=$1::uuid", [posted.lot_id]);
      expect(lot.rows).toEqual([{ version_id: versionId, scope: "OLD" }]);
      const before = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM public.stock_movements WHERE source_document_type='CERP_HISTORICAL_OPENING'");
      await expect(repoCreateHistoricalImportTx(client, historicalImportSchema.parse({ body: { ...base, technical_version_id: "11111111-1111-4111-8111-111111111111" } }).body, audit, `cutover-pf-version-${suffix}`)).rejects.toMatchObject({ code: "PF_TECHNICAL_VERSION_MISMATCH" });
      await expect(repoCreateHistoricalImportTx(client, historicalImportSchema.parse({ body: { ...base, unite: "kg" } }).body, audit, `cutover-pf-unit-${suffix}`)).rejects.toMatchObject({ code: "PF_ARTICLE_UNIT_MISMATCH" });
      const after = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM public.stock_movements WHERE source_document_type='CERP_HISTORICAL_OPENING'");
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
});
