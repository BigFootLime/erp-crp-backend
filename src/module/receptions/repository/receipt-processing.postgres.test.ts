import fs from "node:fs/promises";
import path from "node:path";
import { getDocumentStoragePath } from "../../../utils/cerpStorage";
import {
  repoCreateMovement,
  repoPostMovement,
  ensureStockLevel,
  ensureStockBatchId,
} from "../../stock/repository/stock.repository";
import { repoCreateEmplacement } from "../../stock/repository/stock-locations.repository";
import { issueLabel, resolveIdentification, printLabel } from '../../identification/identification.service';
import { readMaterialBarInventoryTx } from '../../stock/repository/material-bar-inventory.repository';
import { prepareGroupedReceipt,confirmGroupedReceipt } from './grouped-receipts.repository';
import { readExpectedReceiptLinesTx } from './expected-receipts.repository';
import { createEmplacementSchema } from "../../stock/validators/stock.validators";
import { repoPreviewMovement } from "../../stock/repository/stock-movement-corrections.repository";
import { repoGetCommandeFournisseur } from "../../commande-fournisseur/repository/commande-fournisseur.repository";
import { recordReceiptOperatorControl } from "./receipt-operator-control.repository";
import { operatorControlSchema } from "../validators/receipt-processing.validators";
const createdFiles: string[] = [];
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pool from "../../../config/database";
import {
  packReceipt,
  readProcessingLine,
  listProcessingLines,
} from "./receipt-processing.repository";
import {
  repoCreateStockReceipt,
  repoGetReception,
  type AuditContext,
} from "./receptions.repository";
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { stockToolReceipt } from "./receipt-tool-stock.repository";
import { syncArticleCommercialTx } from "../../stock/repository/article-commercial.repository";
import { assertReceiptProcessingClosed } from "./receipt-processing-guard";
import { bindReceiptSubcontract } from "./receipt-subcontract.repository";
import { assertSubcontractReturnVerified } from "../../subcontract/subcontract-return-proof.repository";
import { bindSubcontractIssueAutocontrol, getPaperSubcontractAttestationOptions, hashPaperSubcontractAttestations, readPaperSubcontractIssueHash } from "../../subcontract/subcontract-autocontrol.repository";
import { readReceiptReturnControl, readReceiptReturnDocument, recordReceiptReturnControl } from "./receipt-return-control.repository";
import { writeBlob } from "../../ged/services/ged-vault.service";
import { qualitySha256 } from "../../qualite/domain/quality-policy";
import { repoGetExecution, repoRecordAutocontrolCapture, repoRecordMeasurements } from "../../qualite/repository/quality-360.repository";
import { measurementInputSchema } from "../../qualite/validators/quality-360.validators";
import {
  getSubcontractFlow,
  transferSubcontractReturn,
} from "../../subcontract/subcontract-flow.service";
import { readCentralSnapshot } from "../../planning/repository/planning-central.repository";
import { hydrateExternalPlanning } from "../../planning/repository/planning-external.repository";
import { getSubcontractCreationOptions } from "../../subcontract/subcontract-flow.service";
import {
  createCentralSimulation,
  applyCentralSimulation,
  unplanCentral,
} from "../../planning/services/planning-central.service";
import { repoCreateNonConformityDisposition, repoRemoveDocument } from "../../qualite/repository/qualite.repository";
import { readReceiptDispositionContext } from "./receipt-disposition-context.repository";
import {
  lockReceiptReleaseScope,
  assertReceiptReleaseAvailable,
} from "./receipt-quality-release.repository";

// Full migrated schema, opt-in and restricted to the dedicated local rehearsal.
const externalEnabled =
  process.env.CERP_EXTERNAL_FLOW_PG_TEST === "1" &&
  process.env.DATABASE_URL ===
    "postgresql://postgres@127.0.0.1:62168/cerp_test";
const operatorEnabled = process.env.CERP_RECEIPT_OPERATOR_PG_TEST === "1" &&
  ["postgresql://postgres@127.0.0.1:50325/cerp_test", "postgresql://postgres@127.0.0.1:50326/cerp_test"]
    .includes(process.env.DATABASE_URL ?? "");
const returnControlEnabled = process.env.CERP_SUBCONTRACT_RETURN_PG_TEST === "1" &&
  process.env.DATABASE_URL === "postgresql://postgres@127.0.0.1:50348/cerp_test";
const enabled =
  externalEnabled || operatorEnabled || returnControlEnabled ||
  (process.env.CERP_RECEIPT_PG_TEST === "1" &&
    new URL(process.env.DATABASE_URL ?? "postgresql://localhost/unused")
      .pathname === "/cerp_1069_test");
const suite = enabled ? describe : describe.skip;
let user: number, warehouse: string, place: number;
const audit = (): AuditContext => ({
  user_id: user,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: null,
  page_key: null,
  client_session_id: null,
});
async function fixture(
  accepted = 0,
  kind: "PIECE" | "CONSUMABLE" | "TOOL" = "PIECE",
  operatorKind?: "MP",
  purchaseConversion?: { received: number; coefficient: number },
) {
  const id = randomUUID(),
    mp = randomUUID(),
    receipt = randomUUID(),
    line = randomUUID(),
    lot = randomUUID(),
    supplier = randomUUID();
  await pool.query(
    `INSERT INTO public.fournisseurs(id,code,nom) VALUES($1::uuid,$2,'Fixture fournisseur 1069')`,
    [supplier, `T-${supplier.slice(0, 8)}`],
  );
  const unit = operatorKind === "MP" ? "mm" : "u";
  for (const [article, category, articleUnit] of [
    [id, operatorKind === "MP" ? "matiere" : "achat", unit],
    [mp, "matiere", "u"],
  ] as const)
    await pool.query(
      `INSERT INTO public.articles(id,root_article_id,code,designation,family_code,version_number,plan_index,status,article_type,article_category,unite,stock_managed,lot_tracking,created_by,updated_by)
    VALUES($1::uuid,$1::uuid,$2,'Fixture pièce 1069','TEST1069',1,1,'VALIDE','PURCHASED',$3,$5,true,true,$4,$4)`,
      [article, `T-${article.slice(0, 8)}`, category, user, articleUnit],
    );
  if (operatorKind !== "MP") await pool.query(
    "INSERT INTO public.article_receipt_mp_links(article_id,stock_article_id,updated_by) VALUES($1::uuid,$2::uuid,$3)",
    [id, mp, user],
  );
  let toolId: number | null = null;
  if (kind !== "PIECE") {
    await pool.query(
      "INSERT INTO public.article_category_link(article_id,category_code) VALUES($1::uuid,'consommable')",
      [id],
    );
    if (kind === "TOOL") {
      toolId = (
        await pool.query(
          "INSERT INTO public.gestion_outils_outil(designation) VALUES('Outil fixture 1069') RETURNING id_outil",
        )
      ).rows[0].id_outil;
      await pool.query(
        "INSERT INTO public.article_tool_links(article_id,tool_id,created_by) VALUES($1::uuid,$2,$3)",
        [id, toolId, user],
      );
      await pool.query(
        "UPDATE public.articles SET stock_managed=false,lot_tracking=false WHERE id=$1::uuid",
        [id],
      );
    }
  }
  await pool.query(
    `INSERT INTO public.receptions_fournisseurs(id,reception_no,fournisseur_id,status,created_by,updated_by) VALUES($1::uuid,$2,$3::uuid,'OPEN',$4,$4)`,
    [receipt, `RF-T-${receipt.slice(0, 8)}`, supplier, user],
  );
  await pool.query(
    `INSERT INTO public.lots(id,article_id,lot_code,lot_status,created_by,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$5)`,
    [
      lot,
      id,
      `LT-${lot.slice(0, 8)}`,
      accepted || kind !== "PIECE" ? "LIBERE" : "QUARANTAINE",
      user,
    ],
  );
  await pool.query(
    `INSERT INTO public.reception_fournisseur_lignes(id,reception_id,line_no,article_id,qty_received,unite,lot_id,stock_unit,stock_conversion_coef,created_by,updated_by,receipt_quality_required)
    VALUES($1::uuid,$2::uuid,1,$3::uuid,$7,$8,$4::uuid,$9,$10,$5,$5,$6)`,
    [line, receipt, id, lot, user, kind === "PIECE" || accepted > 0,
      purchaseConversion?.received ?? (operatorKind === "MP" ? 6040 : 100),
      purchaseConversion ? "kg" : unit, unit, purchaseConversion?.coefficient ?? 1],
  );
  if (kind === "CONSUMABLE" && !accepted)
    await pool.query(
      "INSERT INTO public.consumable_receipt_admissions(receipt_line_id,lot_id,quantity,unit,created_by) VALUES($1::uuid,$2::uuid,100,'u',$3)",
      [line, lot, user],
    );
  const documentName = `fixture-1069-${receipt}.txt`;
  const content = Buffer.from(
    "Synthetic delivery note for receipt transaction tests",
  );
  const directory = getDocumentStoragePath("receptions");
  await fs.mkdir(directory, { recursive: true });
  const documentPath = path.join(directory, documentName);
  await fs.writeFile(documentPath, content, { flag: "wx" });
  createdFiles.push(documentPath);
  await pool.query(
    `INSERT INTO public.reception_fournisseur_documents(reception_id,document_type,original_name,stored_name,storage_path,mime_type,size_bytes,sha256,created_by) VALUES($1::uuid,'BON_LIVRAISON',$2,$2,$3,'text/plain',$4,$5,$6)`,
    [
      receipt,
      documentName,
      documentPath,
      content.length,
      createHash("sha256").update(content).digest("hex"),
      user,
    ],
  );
  if (accepted) {
    // Seed an already accepted control. These tests exercise receipt/stock
    // transactions; measurement and release authorization have their own suite.
    const planId = randomUUID();
    const snapshot = JSON.stringify({
      id: planId,
      version: 1,
      trigger_type: "RECEPTION",
      article_id: id,
      sampling_rule: "LOT",
      characteristics: [],
    });
    await pool.query(
      `INSERT INTO public.quality_control_plan(id,code,label,status,trigger_type,article_id,sampling_rule,published_at,published_by,created_by,updated_by) VALUES($1::uuid,$2,'Fixture contrôle réception','PUBLISHED','RECEPTION',$3::uuid,'LOT',now(),$4,$4,$4)`,
      [planId, `PLAN-${planId}`, id, user],
    );
    await pool.query(
      `INSERT INTO public.quality_control(lot_id,source_type,source_id,trigger_type,reception_ligne_id,control_type,controlled_by,created_by,updated_by,reference,qty_population,qty_released,qty_held,qty_consumed,unite,validation_date,verdict,article_id,plan_id,plan_version,plan_snapshot,plan_snapshot_sha256,qty_controlled,qty_conforming,status,validated_by)
    VALUES($1::uuid,'LOT',$1::text,'RECEPTION',$2::uuid,'RECEPTION',$3,$3,$3,$4,100,$5::numeric,100-$5::numeric,0,'u',now(),'PARTIEL',$6::uuid,$7::uuid,1,$8::jsonb,$9,100,$5::numeric,'VALIDATED',$3)`,
      [
        lot,
        line,
        user,
        `QC-T-${lot.slice(0, 8)}`,
        accepted,
        id,
        planId,
        snapshot,
        createHash("sha256").update(snapshot).digest("hex"),
      ],
    );
  }
  return { id, mp, receipt, line, lot, toolId };
}
const body = (qty: number) => ({
  qty,
  dst_magasin_id: warehouse,
  dst_emplacement_id: place,
});
async function attachOperatorOrder(f: Awaited<ReturnType<typeof fixture>>, requirements: {type: string; obligatoire: boolean; valeur?: string}[]) {
  const order = randomUUID(), orderLine = randomUUID();
  await pool.query(`INSERT INTO public.commande_fournisseur(id,code,fournisseur_id,statut)
    SELECT $1::uuid,$2,fournisseur_id,'ENVOYEE' FROM public.receptions_fournisseurs WHERE id=$3::uuid`, [order, `BCF-${order}`, f.receipt]);
  await pool.query(`INSERT INTO public.commande_fournisseur_ligne(id,commande_id,type,designation,quantite,article_id,exigences_qualite)
    VALUES($1,$2,'MATIERE','Matière avec exigences',6040,$3,$4::jsonb)`, [orderLine, order, f.id, JSON.stringify(requirements)]);
  await pool.query(`UPDATE public.reception_fournisseur_lignes SET commande_fournisseur_ligne_id=$2 WHERE id=$1`, [f.line, orderLine]);
  return orderLine;
}
async function technicalPiece() {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,name_piece,code_piece,designation) VALUES($1::uuid,$1::uuid,1,'Pièce fixture 1069',$2,'Pièce fixture 1069')",
    [id, `PT-${id}`],
  );
  return id;
}
async function subcontractFixture(
  issue = true,
  technicalSnapshot?: Record<string, unknown>,
) {
  const f = await fixture(60),
    pt = await technicalPiece();
  // Restore the received lot's physical quarantine before recording custody.
  // The control seeded by fixture represents the later quality decision.
  await pool.query(
    "UPDATE public.lots SET lot_status='QUARANTAINE' WHERE id=$1::uuid",
    [f.lot],
  );
  const orderId = randomUUID(),
    orderLineId = randomUUID(),
    sourceOperation = randomUUID(),
    operationId = randomUUID(),
    packageId = randomUUID(),
    issueEventId = randomUUID(),
    sourceLot = randomUUID(),
    revision = randomUUID(),
    document = randomUUID();
  const createOf = async () => {
    if (!technicalSnapshot)
      return Number(
        (
          await pool.query(
            "INSERT INTO public.ordres_fabrication(numero,piece_technique_id,quantite_lancee) VALUES($1,$2::uuid,100) RETURNING id",
            [`OF-T-${randomUUID().slice(0, 16)}`, pt],
          )
        ).rows[0].id,
      );
    const tx = await pool.connect(),
      version = randomUUID(),
      snapshot = JSON.stringify(technicalSnapshot),
      sha = createHash("sha256").update(snapshot).digest("hex");
    try {
      await tx.query("BEGIN");
      await tx.query(
        "INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,plan_reference,statut,is_current,version_interne,code_metier,code_metier_normalise,document_requirements_policy) VALUES($1,$2,'C',$3,'BROUILLON',true,1,$3,$3,'NONE')",
        [version, pt, "TEST-" + version],
      );
      const id = Number(
        (
          await tx.query(
            "INSERT INTO public.ordres_fabrication(numero,piece_technique_id,piece_technique_version_id,quantite_lancee,technical_snapshot,technical_snapshot_sha256,technical_snapshot_at) VALUES($1,$2,$3,100,$4,$5,now()) RETURNING id",
            [`OF-T-${randomUUID().slice(0, 16)}`, pt, version, snapshot, sha],
          )
        ).rows[0].id,
      );
      await tx.query(
        "INSERT INTO public.of_technical_snapshots(of_id,piece_technique_version_id,snapshot,snapshot_sha256,created_by) VALUES($1,$2,$3,$4,$5)",
        [id, version, snapshot, sha, user],
      );
      await tx.query("COMMIT");
      return id;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  };
  const ofId = await createOf();
  await pool.query(
    "INSERT INTO public.of_revisions(id,of_id,revision_rank,revision_code,snapshot,snapshot_sha256) VALUES($1::uuid,$2,0,'R00','{}', $3)",
    [revision, ofId, createHash("sha256").update("{}").digest("hex")],
  );
  await pool.query(
    "INSERT INTO public.pieces_techniques_operations(id,piece_technique_id,phase,designation,type_operation) VALUES($1::uuid,$2::uuid,10,'Sous-traitance fixture','SOUS_TRAITANCE')",
    [sourceOperation, pt],
  );
  await pool.query(
    "INSERT INTO public.of_operations(id,of_id,phase,designation,revision_id,source_piece_operation_id) VALUES($1::uuid,$2,10,'Sous-traitance fixture',$3::uuid,$4::uuid)",
    [operationId, ofId, revision, sourceOperation],
  );
  await pool.query(
    "INSERT INTO public.commande_fournisseur(id,code,fournisseur_id,statut) SELECT $1::uuid,$2,fournisseur_id,'ENVOYEE' FROM public.receptions_fournisseurs WHERE id=$3::uuid",
    [orderId, `CF-T-${orderId}`, f.receipt],
  );
  await pool.query(
    "INSERT INTO public.commande_fournisseur_ligne(id,commande_id,type,designation,quantite,article_id,of_id) VALUES($1::uuid,$2::uuid,'SOUS_TRAITANCE','Retour fixture',100,$3::uuid,$4)",
    [orderLineId, orderId, f.id, ofId],
  );
  await pool.query(
    "UPDATE public.reception_fournisseur_lignes SET commande_fournisseur_ligne_id=$2::uuid WHERE id=$1::uuid",
    [f.line, orderLineId],
  );
  await pool.query(
    "INSERT INTO public.ged_document_classes(class_key,domain,label,nature,allowed_mime_types,allowed_extensions,max_size_bytes) VALUES('TEST1069','TEST','Preuve fixture','EVIDENCE',ARRAY['text/plain'],ARRAY['txt'],1000) ON CONFLICT DO NOTHING",
  );
  await pool.query(
    "INSERT INTO public.ged_documents(id,code,class_key,title) VALUES($1::uuid,$2,'TEST1069','Preuve fixture')",
    [document, `GED-T-${document}`],
  );
  await pool.query(
    "INSERT INTO public.subcontract_work_packages(id,supplier_order_line_id,of_operation_id,unit,qty_planned,ged_evidence_document_id,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,'u',100,$4::uuid,$5)",
    [packageId, orderLineId, operationId, document, user],
  );
  await pool.query(
    "INSERT INTO public.lots(id,article_id,lot_code,lot_status,created_by,updated_by) VALUES($1::uuid,$2::uuid,$3,'LIBERE',$4,$4)",
    [sourceLot, f.mp, `LOT-T-${sourceLot}`, user],
  );
  if (issue)
    await pool.query(
      "INSERT INTO public.subcontract_work_package_ledger(id,package_id,event_type,lot_id,qty,unit,idempotency_key,created_by) VALUES($1::uuid,$2::uuid,'ISSUE',$3::uuid,100,'u',$4,$5)",
      [issueEventId, packageId, sourceLot, randomUUID(), user],
    );
  return { ...f, ofId, operationId, packageId, issueEventId, sourceLot };
}
const manualMovement = (f: Awaited<ReturnType<typeof fixture>>) => ({
  movement_type: "IN" as const,
  idempotency_key: randomUUID(),
  lines: [
    {
      article_id: f.id,
      lot_id: f.lot,
      qty: 1,
      unite: "u",
      dst_magasin_id: warehouse,
      dst_emplacement_id: place,
    },
  ],
});
suite("Received pieces on the full PostgreSQL schema (#1069)", () => {
  beforeAll(async () => {
    expect(
      (await pool.query("SELECT current_database() AS db")).rows[0].db,
    ).toBe(externalEnabled || operatorEnabled || returnControlEnabled ? "cerp_test" : "cerp_1069_test");
    await pool.query(
      "INSERT INTO public.units(code,label) VALUES('u','Unité'),('mm','Millimètre'),('m','Mètre'),('kg','Kilogramme') ON CONFLICT(code) DO NOTHING",
    );
    await pool.query(
      "INSERT INTO public.currencies(code,name,symbol) VALUES('EUR','Euro','€') ON CONFLICT(code) DO NOTHING",
    );
    await pool.query(
      "INSERT INTO public.app_roles(role_key,category,description) VALUES('Directeur','PRIMARY','Fixture transaction 1069') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO public.erp_settings(key,value_text,definition,unit,period_start,source,freshness_at,reliability) VALUES('stock.valuation_method','WEIGHTED_AVERAGE','Fixture transaction 1069','METHOD',CURRENT_DATE,'Test automatisé #1069',now(),'DECLARED') ON CONFLICT(key) DO UPDATE SET period_start=CURRENT_DATE,freshness_at=now()",
    );
    user = (
      await pool.query(
        `INSERT INTO public.users(username,password,role) VALUES($1,'unusable-test-hash','Directeur') RETURNING id`,
        [`test-1069-${randomUUID()}`],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO public.user_role_assignments(user_id,role_key) SELECT id,role FROM public.users WHERE username LIKE 'test-1069-%' AND role='Directeur' ON CONFLICT DO NOTHING",
    );
    warehouse = (
      await pool.query(
        `INSERT INTO public.magasins(code,name,is_active,created_by,updated_by) VALUES($1,'Magasin test 1069',true,$2,$2) RETURNING id::text`,
        [`T-${randomUUID().slice(0, 8)}`, user],
      )
    ).rows[0].id;
    place = (await repoCreateEmplacement(
      warehouse,
      createEmplacementSchema.parse({ body: { code: "TEST1069" } }).body,
      audit(),
    ))!.id;
    await pool.query(
      "UPDATE public.magasins m SET warehouse_id=w.id FROM public.warehouses w WHERE m.id=$1::uuid AND w.code=m.code",
      [warehouse],
    );
  });
  afterAll(async () => {
    await pool.end();
    await Promise.all(createdFiles.map((file) => fs.unlink(file)));
  });
  it("operator control admits MP only after a separate stock command and replays the exact proof", async () => {
    const f = await fixture(0, "PIECE", "MP");
    await pool.query(`INSERT INTO public.stock_nuances(code,norme_usa,designation_principale) VALUES('304L','304L','USA') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO public.articles_matiere(article_id,family_code,barre_a_decouper,longueur_barre_source_mm,diametre_mm,nuance_id)
      SELECT $1,'RO',true,3020,22,id FROM public.stock_nuances WHERE code='304L'`, [f.id]);
    await attachOperatorOrder(f, ["304L", "diametre_mm: 22 mm minimum", "longueur_mm: 1000 mm minimum"]
      .map(valeur => ({ type: "SPECIFICATION", obligatoire: true, valeur })));
    const line = await readProcessingLine(pool, f.line, f.receipt);
    expect(line.operatorControl).toEqual({ kind: "MP", reopenRequired: false, grade: "304L", dimensions: [
      { label: "Longueur", valueMm: 3020, minimumMm: 1000 }, { label: "Diamètre", valueMm: 22, minimumMm: 22 },
    ] });
    const request = operatorControlSchema.parse({
      idempotencyKey: randomUUID(), expectedVersion: line.version, kind: "MP", verdict: "CONFORME",
      measurements: [{ label: "Longueur", valueMm: 3020, confirmed: true }, { label: "Diamètre", valueMm: 22.001, confirmed: true }],
      grade: { value: "304l", confirmed: true },
    });
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, measurements: request.measurements.slice(0, 1) }, audit()))
      .rejects.toMatchObject({ code: "RECEIPT_CONTROL_DIMENSIONS_REQUIRED" });
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, grade: undefined }, audit()))
      .rejects.toMatchObject({ code: "RECEIPT_CONTROL_GRADE_REQUIRED" });
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, grade: { value: "316L", confirmed: true } }, audit()))
      .rejects.toMatchObject({ code: "RECEIPT_CONTROL_GRADE_MISMATCH" });
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, measurements: [request.measurements[0], { ...request.measurements[1], valueMm: 21.999 }] }, audit()))
      .rejects.toMatchObject({ code: "RECEIPT_CONTROL_DIMENSION_MISMATCH" });
    const result = await recordReceiptOperatorControl(f.receipt, f.line, request, audit());
    expect(result).toMatchObject({ nonConformityId: null, released: 6040, held: 0, unit: "mm" });
    expect(await recordReceiptOperatorControl(f.receipt, f.line, request, audit())).toEqual(result);
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, note: "Changement" }, audit())).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const accepted = await readProcessingLine(pool, f.line, f.receipt);
    expect(accepted).toMatchObject({ accepted: 6040, stocked: 0, stage: "TO_STOCK" });
    expect(accepted.operatorControl).toBeUndefined();
    expect((await pool.query(`SELECT c.plan_id, c.plan_snapshot_sha256, p.characteristic, p.measured_value::float8 AS length,
      (SELECT count(*)::int FROM public.quality_release_decision WHERE quality_control_id=c.id) AS decisions
      FROM public.quality_control c JOIN public.quality_control_points p ON p.quality_control_id=c.id
      WHERE c.id=$1 AND p.characteristic='Longueur'`, [result.controlId])).rows[0])
      .toEqual({ plan_id: null, plan_snapshot_sha256: null, characteristic: "Longueur", length: 3020, decisions: 1 });
    await repoCreateStockReceipt(f.receipt, f.line, { ...body(6040), unite: "mm", material_bars: [{ lengthMm: 3020, count: 2 }] }, audit(), randomUUID());
    expect(await readProcessingLine(pool, f.line, f.receipt)).toMatchObject({ stocked: 6040, stage: "DONE" });
    expect((await pool.query(`SELECT count(*)::int AS bars FROM public.stock_material_bars b JOIN public.stock_batches s ON s.id=b.stock_batch_id
      WHERE s.lot_id=$1 AND b.remaining_length_mm=3020`, [f.lot])).rows[0].bars).toBe(2);
  });

  it("operator control records MP dimensions, then blocks a failed lot with one NC", async () => {
    const f = await fixture(0, "PIECE", "MP");
    const line = await readProcessingLine(pool, f.line, f.receipt);
    expect(line.operatorControl).toEqual({ kind: "MP", reopenRequired: false, dimensions: [{ label: "Longueur", valueMm: null }] });
    const request = operatorControlSchema.parse({
      idempotencyKey: randomUUID(), expectedVersion: line.version, kind: "MP", verdict: "NON_CONFORME",
      measurements: [{ label: "Longueur", valueMm: 980, confirmed: true, result: "NOK" }], note: "Longueur non conforme",
    });
    const result = await recordReceiptOperatorControl(f.receipt, f.line, request, audit());
    expect(result.nonConformityId).toBeTruthy();
    expect(result).toMatchObject({ released: 0, held: 6040, unit: "mm" });
    expect(await recordReceiptOperatorControl(f.receipt, f.line, request, audit())).toEqual(result);
    expect(await readProcessingLine(pool, f.line, f.receipt)).toMatchObject({ lotStatus: "BLOQUE", accepted: 0, stocked: 0, openNc: 1 });
    const proof = (await pool.query(`SELECT n.status,n.reception_ligne_id::text AS line,n.lot_id::text AS lot,
      (SELECT count(*)::int FROM public.quality_control_points WHERE quality_control_id=n.control_id) AS measurements
      FROM public.non_conformity n WHERE n.id=$1`, [result.nonConformityId])).rows[0];
    expect(proof).toEqual({ status: "OPEN", line: f.line, lot: f.lot, measurements: 1 });
  });

  it("operator control accepts the canonical rounded stock conversion and rejects the out-of-tolerance conversion", async () => {
    const rounded = await fixture(0, "PIECE", "MP", { received: 0.300, coefficient: 3.33333333 });
    const excessive = await fixture(0, "PIECE", "MP", { received: 0.300, coefficient: 3.33333329 });
    const control = async (f: typeof rounded) => {
      const line = await readProcessingLine(pool, f.line, f.receipt);
      return recordReceiptOperatorControl(f.receipt, f.line, operatorControlSchema.parse({
        idempotencyKey: randomUUID(), expectedVersion: line.version, kind: "MP", verdict: "CONFORME",
        measurements: [{ label: "Longueur", valueMm: 3020, confirmed: true }],
      }), audit());
    };
    const result = await control(rounded);
    expect(result).toMatchObject({ released: 1, held: 0, unit: "mm" });
    expect((await pool.query("SELECT qty_population::float8 AS population FROM public.quality_control WHERE id=$1", [result.controlId])).rows[0].population).toBe(1);
    await expect(control(excessive)).rejects.toMatchObject({ code: "RECEPTION_CONVERSION_PRECISION" });
    expect((await pool.query("SELECT count(*)::int AS controls FROM public.quality_control WHERE lot_id=$1", [excessive.lot])).rows[0].controls).toBe(0);

    const insertFromConfirmed = (operator: boolean, useOtherLine: boolean, population: number) => pool.query(
      `INSERT INTO public.quality_control(reference,control_type,status,result,controlled_by,validated_by,validation_date,source_type,source_id,
        trigger_type,lot_id,article_id,fournisseur_id,reception_ligne_id,unite,qty_population,operator_receipt_control,created_by,updated_by)
       SELECT $1,control_type,status,result,controlled_by,validated_by,validation_date,source_type,source_id,
        trigger_type,lot_id,article_id,fournisseur_id,$2,unite,$3,$4,created_by,updated_by FROM public.quality_control WHERE id=$5`,
      [`FIX-${randomUUID()}`, useOtherLine ? excessive.line : rounded.line, population, operator, result.controlId],
    );
    await expect(insertFromConfirmed(false, false, 1)).rejects
      .toMatchObject({ code: "23514", constraint: "quality_control_context_v3_chk" });
    await expect(insertFromConfirmed(true, true, 1)).rejects
      .toMatchObject({ code: "23514", message: expect.stringContaining("must match its raw-material receipt line") });
    await expect(insertFromConfirmed(true, false, 2)).rejects
      .toMatchObject({ code: "23514", message: expect.stringContaining("must match its raw-material receipt line") });
    await expect(pool.query("UPDATE public.quality_control SET operator_receipt_control=false WHERE id=$1", [result.controlId]))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("origin of a quality control is immutable") });
  });

  it("operator control leaves a closed dossier, an applicable published plan and a required certificate untouched", async () => {
    const f = await fixture(0, "PIECE", "MP");
    const initial = await readProcessingLine(pool, f.line, f.receipt);
    const request = operatorControlSchema.parse({
      idempotencyKey: randomUUID(), expectedVersion: initial.version, kind: "MP", verdict: "CONFORME",
      measurements: [{ label: "Longueur", valueMm: 3020, confirmed: true }],
    });
    await pool.query(`UPDATE public.receptions_fournisseurs SET status='CLOSED' WHERE id=$1`, [f.receipt]);
    expect((await readProcessingLine(pool, f.line, f.receipt)).operatorControl).toMatchObject({ kind: "MP", reopenRequired: true });
    await expect(recordReceiptOperatorControl(f.receipt, f.line, request, audit())).rejects.toMatchObject({ code: "RECEIPT_NOT_OPEN" });
    await pool.query(`UPDATE public.receptions_fournisseurs SET status='OPEN' WHERE id=$1`, [f.receipt]);
    const orderLine = await attachOperatorOrder(f, [{ type: "CERTIFICAT_MATIERE", obligatoire: true }]);
    const certificate = await readProcessingLine(pool, f.line, f.receipt);
    expect(certificate.operatorControl).toBeUndefined();
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, expectedVersion: certificate.version }, audit())).rejects.toMatchObject({ code: "RECEIPT_OPERATOR_CONTROL_UNAVAILABLE" });
    await pool.query(`UPDATE public.commande_fournisseur_ligne SET exigences_qualite='[{"type":"SPECIFICATION","valeur":"Contrôle dureté","obligatoire":true}]' WHERE id=$1`, [orderLine]);
    expect((await readProcessingLine(pool, f.line, f.receipt)).operatorControl).toBeUndefined();
    await pool.query("UPDATE public.commande_fournisseur_ligne SET exigences_qualite='[]' WHERE id=$1", [orderLine]);
    await pool.query(`INSERT INTO public.quality_control_plan(code,label,status,trigger_type,article_id,sampling_rule,published_at,published_by,created_by,updated_by)
      VALUES($1,'Plan formel dédié','PUBLISHED','RECEPTION',$2::uuid,'LOT',now(),$3,$3,$3)`, [`PLAN-${f.id}`, f.id, user]);
    const formal = await readProcessingLine(pool, f.line, f.receipt);
    expect(formal.operatorControl).toBeUndefined();
    await expect(recordReceiptOperatorControl(f.receipt, f.line, { ...request, expectedVersion: formal.version }, audit())).rejects.toMatchObject({ code: "RECEIPT_OPERATOR_CONTROL_UNAVAILABLE" });
    expect((await pool.query(`SELECT count(*)::int AS controls FROM public.quality_control WHERE lot_id=$1`, [f.lot])).rows[0].controls).toBe(0);
  });

  it("requires physical bar tracking before offering a generic adjustment", async () => {
    const articleId = randomUUID();
    await pool.query(`INSERT INTO public.articles(id,root_article_id,code,designation,family_code,version_number,plan_index,status,article_type,article_category,unite,stock_managed,lot_tracking,created_by,updated_by)
      VALUES($1,$1,$2,'Barre de 3 100 mm','TEST1248',1,1,'VALIDE','PURCHASED','matiere','mm',true,false,$3,$3)`,
    [articleId, `MP-${articleId}`, user]);
    await pool.query(`INSERT INTO public.articles_matiere(article_id,family_code,barre_a_decouper,longueur_barre_source_mm)
      SELECT $1,code,true,3100 FROM public.articles_matiere_families ORDER BY code LIMIT 1`, [articleId]);
    const stockActor = { ...audit(), role: "Directeur", request_id: null, correlation_id: null };
    const movementBody = {
      movement_type: "ADJUSTMENT" as const,
      idempotency_key: randomUUID(),
      lines: [{ article_id: articleId, qty: 3100, unite: "mm", direction: "IN" as const,
        dst_magasin_id: warehouse, dst_emplacement_id: place }],
    };
    const withoutLot = await repoPreviewMovement(movementBody);
    expect(withoutLot).toMatchObject({ can_post: false, blockers: [{ code: "MATERIAL_BAR_BATCH_REQUIRED" }] });
    const oldDraft = await repoCreateMovement(movementBody, stockActor);
    await expect(repoPostMovement(oldDraft.movement.id, {}, stockActor, randomUUID()))
      .rejects.toMatchObject({ code: "MATERIAL_BAR_BATCH_REQUIRED" });
    expect((await pool.query("SELECT status FROM public.stock_movements WHERE id=$1", [oldDraft.movement.id])).rows[0].status).toBe("DRAFT");
    const lot = randomUUID();
    await pool.query("INSERT INTO public.lots(id,article_id,lot_code,lot_status,created_by,updated_by) VALUES($1,$2,$3,'LIBERE',$4,$4)",
      [lot, articleId, `LOT-${lot}`, user]);
    expect(await repoPreviewMovement({ ...movementBody, lines: [{ ...movementBody.lines[0], lot_id: lot }] }))
      .toMatchObject({ can_post: false, blockers: [{ code: "MATERIAL_BAR_MOVEMENT_REQUIRED" }] });
    expect((await pool.query("SELECT COALESCE(sum(qty_on_hand),0)::float8 AS total FROM public.v_stock_availability_225 WHERE article_id=$1", [articleId])).rows[0].total).toBe(0);
  });

  it("receives a free supplier service partially and then in full without creating stock or lots", async () => {
    const supplierId = randomUUID(), orderId = randomUUID(), orderLineId = randomUUID(), unrelatedLineId = randomUUID();
    await pool.query("INSERT INTO public.fournisseurs(id,code,nom) VALUES($1,$2,'Fournisseur prestation fictif')",
      [supplierId, `T-${supplierId.slice(0,8)}`]);
    await pool.query("INSERT INTO public.commande_fournisseur(id,code,fournisseur_id,statut) VALUES($1,$2,$3,'ENVOYEE')",
      [orderId, `BCF-SERVICE-${orderId}`, supplierId]);
    await pool.query(`INSERT INTO public.commande_fournisseur_ligne(id,commande_id,position,type,designation,quantite)
      VALUES($1,$2,1,'PRESTATION','Intervention fictive',12),($3,$2,2,'LIBRE_CONTROLEE','Pièce à contrôler',1)`,
    [orderLineId, orderId, unrelatedLineId]);
    const loadExpected = async (id: string) =>
      (await readExpectedReceiptLinesTx(pool, { page: 1, pageSize: 100 }, [id])).items[0];
    const makeDraft = async (sequence: number) => {
      const draft = await prepareGroupedReceipt({ idempotencyKey: randomUUID(), supplierId,
        reference: `BL-SERVICE-${orderLineId.slice(0,8)}-${sequence}`, date: "2026-11-26" }, audit());
      const file = `fixture-service-${draft.id}.txt`;
      const directory = getDocumentStoragePath("receptions");
      await fs.mkdir(directory, { recursive: true });
      const filePath = path.join(directory, file);
      const content = Buffer.from("Bon de livraison fictif — prestation");
      await fs.writeFile(filePath, content, { flag: "wx" });
      createdFiles.push(filePath);
      await pool.query(`INSERT INTO public.reception_fournisseur_documents(
          reception_id,document_type,original_name,stored_name,storage_path,mime_type,size_bytes,sha256,created_by)
        VALUES ($1,'BON_LIVRAISON',$2,$2,$3,'text/plain',$4,$5,$6)`,
      [draft.id, file, filePath, content.length, createHash("sha256").update(content).digest("hex"), user]);
      return draft;
    };
    const makeChoice = async (id: string, quantity: number) => ({
      lineId: id, expectedVersion: (await loadExpected(id)).version, quantity,
      destination: null, supplierLotCode: null, packs: [], overReceiptReason: null,
    });
    const initial = await loadExpected(orderLineId);
    expect(initial).toMatchObject({ received: 0, remaining: 12, offStockService: true, unit: "prestation", stockManaged: false, qualityRequired: false });
    const draft = await makeDraft(1);
    await expect(confirmGroupedReceipt(draft.id, { idempotencyKey: randomUUID(), lines: [await makeChoice(unrelatedLineId, 1)] }, audit()))
      .rejects.toMatchObject({ code: "RECEIPT_ARTICLE_REQUIRED" });
    await expect(pool.query(`INSERT INTO public.reception_fournisseur_lignes(
        reception_id,line_no,commande_fournisseur_ligne_id,qty_received,unite,stock_unit,stock_conversion_coef,stock_managed,receipt_quality_required)
      VALUES($1,1,$2,1,'prestation','prestation',1,false,false)`, [draft.id, unrelatedLineId])).rejects.toMatchObject({ code: "23514" });
    const firstChoice = await makeChoice(orderLineId, 5);
    await expect(confirmGroupedReceipt(draft.id, { idempotencyKey: randomUUID(), lines: [{ ...firstChoice, supplierLotCode: "NO-LOT" }] }, audit()))
      .rejects.toMatchObject({ code: "RECEIPT_SERVICE_OFF_STOCK" });
    const command = { idempotencyKey: randomUUID(), lines: [firstChoice] };
    const result = await confirmGroupedReceipt(draft.id, command, audit());
    expect(result.lines).toEqual([expect.objectContaining({ quantity: 5, lotId: null, lotCode: null, state: "ACCEPTED_OFF_STOCK" })]);
    expect(await confirmGroupedReceipt(draft.id, command, audit())).toEqual(result);
    const saved = await repoGetReception(draft.id);
    expect(saved).toMatchObject({
      lines: [{ article_id: null, qty_received: 5, stock_managed: false, receipt_quality_required: false,
        processing: { stage: "DONE", accepted: 5, stocked: 0 } }],
      documents: [expect.objectContaining({ document_type: "BON_LIVRAISON" })],
      stock_receipts: [], inspections: [],
    });
    expect(saved?.lines[0].quality).toBeUndefined();
    expect(await loadExpected(orderLineId)).toMatchObject({ received: 5, accepted: 5, remaining: 7, stocked: 0 });
    const finalDraft = await makeDraft(2);
    await confirmGroupedReceipt(finalDraft.id, { idempotencyKey: randomUUID(), lines: [await makeChoice(orderLineId, 7)] }, audit());
    expect(await loadExpected(orderLineId)).toMatchObject({ received: 12, accepted: 12, remaining: 0, stocked: 0 });
    const order = await repoGetCommandeFournisseur(orderId, { includePrices: true });
    expect(order.receptions).toHaveLength(2);
    expect(order.receptions.flatMap(receipt => receipt.lignes).map(line => line.article_id)).toEqual([null, null]);
    expect(order.lignes.find(line => line.id === orderLineId)).toMatchObject({ qty_recue: 12, qty_restante: 0 });
  });
  it('receives grouped physical bars per supplier lot and replays without duplicate stock',async()=>{
    const f=await fixture(0,'CONSUMABLE'),orderId=randomUUID(),orderLineId=randomUUID();
    const supplierId=(await pool.query('SELECT fournisseur_id::text AS id FROM public.receptions_fournisseurs WHERE id=$1',[f.receipt])).rows[0].id;
    await pool.query("UPDATE public.articles SET unite='mm',article_category='matiere',receipt_quality_required=false WHERE id=$1",[f.id]);
    await pool.query(`INSERT INTO public.articles_matiere(article_id,family_code,barre_a_decouper,longueur_barre_source_mm)
      SELECT $1,code,true,3000 FROM public.articles_matiere_families ORDER BY code LIMIT 1`,[f.id]);
    await pool.query(`INSERT INTO public.commande_fournisseur(id,code,fournisseur_id,statut) VALUES($1,$2,$3,'ENVOYEE')`,[orderId,`BCF-GROUPED-${orderId}`,supplierId]);
    await pool.query(`INSERT INTO public.commande_fournisseur_ligne(id,commande_id,type,designation,quantite,article_id,unite,unite_stock,coef_conversion,receipt_stock_managed,receipt_quality_required,receipt_processing_policy)
      VALUES($1,$2,'MATIERE','Rond fixture 1250',4,$3,'barre','mm',3000,true,false,'STANDARD')`,[orderLineId,orderId,f.id]);
    const draft=await prepareGroupedReceipt({idempotencyKey:randomUUID(),supplierId,reference:'BL-GROUPED-1250',date:'2026-10-13'},audit());
    const sourceDocument=(await pool.query('SELECT storage_path FROM public.reception_fournisseur_documents WHERE reception_id=$1',[f.receipt])).rows[0];
    const documentName=`fixture-grouped1250-${draft.id}.txt`,documentPath=path.join(getDocumentStoragePath('receptions'),documentName);
    await fs.writeFile(documentPath,await fs.readFile(sourceDocument.storage_path),{flag:'wx'});createdFiles.push(documentPath);
    await pool.query(`INSERT INTO public.reception_fournisseur_documents(reception_id,document_type,original_name,stored_name,storage_path,mime_type,size_bytes,sha256,created_by)
      SELECT $1,document_type,$3,$3,$4,mime_type,size_bytes,sha256,created_by FROM public.reception_fournisseur_documents WHERE reception_id=$2`,[draft.id,f.receipt,documentName,documentPath]);
    const expected=(await readExpectedReceiptLinesTx(pool,{page:1,pageSize:100},[orderLineId])).items[0];
    expect(expected.materialBarProposal).toMatchObject({required:true,groups:[{lengthMm:3000,count:4}]});
    const choice={lineId:orderLineId,expectedVersion:expected.version,quantity:2,destination:{magasinId:warehouse,emplacementId:place},supplierLotCode:null,packs:[],overReceiptReason:null};
    await expect(confirmGroupedReceipt(draft.id,{idempotencyKey:randomUUID(),lines:[choice]},audit())).rejects.toMatchObject({code:'MATERIAL_BAR_RECEIPT_REQUIRED'});
    expect((await pool.query('SELECT count(*)::int AS count FROM public.reception_fournisseur_lignes WHERE reception_id=$1',[draft.id])).rows[0].count).toBe(0);
    const request={idempotencyKey:randomUUID(),lines:[{...choice,packs:[{quantity:1,supplierLotCode:'SUP-A',materialBars:[{lengthMm:3000,count:1}]},{quantity:1,supplierLotCode:'SUP-B',materialBars:[{lengthMm:1500,count:2}]}]}]};
    const result=await confirmGroupedReceipt(draft.id,request,audit());
    expect(result.state).toBe('CONFIRMED');expect(result.lines).toHaveLength(2);
    expect(await confirmGroupedReceipt(draft.id,request,audit())).toEqual(result);
    const bars=(await pool.query(`SELECT l.supplier_lot_code AS supplier,b.remaining_length_mm::float8 AS length,b.public_number::text AS code
      FROM public.stock_material_bars b JOIN public.stock_batches batch ON batch.id=b.stock_batch_id JOIN public.lots l ON l.id=batch.lot_id
      WHERE l.id=ANY($1::uuid[]) ORDER BY l.supplier_lot_code,b.public_number`,[result.lines.map(line=>line.lotId)])).rows;
    expect(bars.map(bar=>[bar.supplier,bar.length])).toEqual([['SUP-A',3000],['SUP-B',1500],['SUP-B',1500]]);
    expect(new Set(bars.map(bar=>bar.code)).size).toBe(3);
    expect((await readExpectedReceiptLinesTx(pool,{page:1,pageSize:100},[orderLineId])).items[0].remaining).toBe(2);
  });
  it('identifies two physical bars with stable codes and resolves the exact bar label',async()=>{
    const articleId=randomUUID(),lotId=randomUUID(),actor={user_id:user,role:'Directeur',request_id:null,correlation_id:null};
    await pool.query(`INSERT INTO public.articles(id,root_article_id,code,designation,family_code,version_number,plan_index,status,article_type,article_category,unite,stock_managed,lot_tracking,created_by,updated_by)
      VALUES($1,$1,$2,'Rond acier fixture','TEST1248',1,1,'VALIDE','PURCHASED','matiere','mm',true,true,$3,$3)`,[articleId,`MP-${articleId}`,user]);
    await pool.query(`INSERT INTO public.lots(id,article_id,lot_code,lot_status,created_by,updated_by) VALUES($1,$2,$3,'LIBERE',$4,$4)`,[lotId,articleId,`LOT-${lotId}`,user]);
    const location=(await pool.query(`SELECT id::text,warehouse_id::text FROM public.locations ORDER BY id LIMIT 1`)).rows[0];
    const unit=(await pool.query(`SELECT id::text FROM public.units WHERE code='mm'`)).rows[0];
    const tx=await pool.connect();let batchId:string,bars:Array<{id:string;public_number:string}>;
    try{
      await tx.query('BEGIN');
      const levelId=await ensureStockLevel(tx,{article_id:articleId,unit_id:unit.id,warehouse_id:location.warehouse_id,location_id:location.id,actor_user_id:user});
      batchId=await ensureStockBatchId(tx,{stock_level_id:levelId,lot_id:lotId});
      // Synthetic opening balance for identity qualification, not a receipt or production result.
      await tx.query(`UPDATE public.stock_batches SET qty_total=6000 WHERE id=$1`,[batchId]);
      await tx.query(`INSERT INTO public.stock_material_bar_inventories(stock_batch_id,movement_count,confirmed_by,note) VALUES($1,0,$2,'Fixture identité des barres')`,[batchId,user]);
      bars=(await tx.query(`INSERT INTO public.stock_material_bars(stock_batch_id,initial_length_mm,remaining_length_mm,created_by,updated_by)
        VALUES($1,3000,3000,$2,$2),($1,3000,3000,$2,$2) RETURNING id::text,public_number::text`,[batchId,user])).rows;
      for(const bar of bars)await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,after_state,reason,created_by)
        VALUES($1,$2,'INITIALIZE',$3::jsonb,'Fixture identité des barres',$4)`,[bar.id,randomUUID(),JSON.stringify({id:bar.id,batchId,lengthMm:3000,version:1,holds:[]}),user]);
      await tx.query('COMMIT');
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
    const inventory=await readMaterialBarInventoryTx(pool,batchId!);
    expect(inventory.status).toBe('CONFIRMED');expect(inventory.bars).toHaveLength(2);
    expect(new Set(inventory.bars.map(bar=>bar.code)).size).toBe(2);
    expect(inventory.bars.every(bar=>/^BAR-\d{6,}$/.test(bar.code??''))).toBe(true);
    const selected=bars![1],key=randomUUID();
    const issued=await issueLabel({body:{entity_type:'STOCK_MATERIAL_BAR',entity_id:selected.id},actor,idempotencyKey:key});
    expect(issued.label.human_code).toBe(inventory.bars.find(bar=>bar.id===selected.id)!.code);
    expect((await issueLabel({body:{entity_type:'STOCK_MATERIAL_BAR',entity_id:selected.id},actor,idempotencyKey:key})).label.id).toBe(issued.label.id);
    const input={event_id:randomUUID(),code:issued.label.payload,source:'KEYBOARD' as const,flow:'CONSUME' as const,expected_entity_types:['STOCK_MATERIAL_BAR' as const],client_scanned_at:new Date().toISOString()};
    const scan=await resolveIdentification(input,actor);
    expect(scan).toMatchObject({ok:true,entity:{type:'STOCK_MATERIAL_BAR',id:selected.id,code:issued.label.human_code},target_route:`/stock/lots/${lotId}`});
    expect((await resolveIdentification(input,actor)).idempotent_replay).toBe(true);
    const printed=await printLabel({labelId:issued.label.id,actor,body:{symbology:'QR_CODE',label_profile:'STANDARD_50X30'},idempotencyKey:randomUUID()});
    expect(printed.label.payload).toBe(issued.label.payload);expect(printed.print.svg).toContain('<svg');
    await expect(pool.query(`UPDATE public.stock_material_bars SET public_number=public_number+1000000 WHERE id=$1`,[selected.id])).rejects.toMatchObject({code:'428C9'});
    await expect(pool.query(`UPDATE public.stock_material_bars SET public_number=DEFAULT WHERE id=$1`,[selected.id])).rejects.toMatchObject({code:'23514'});
    await pool.query(`UPDATE public.lots SET lot_status='BLOQUE' WHERE id=$1`,[lotId]);
    expect(await resolveIdentification({...input,event_id:randomUUID()},actor)).toMatchObject({ok:false,result_code:'FORBIDDEN_STATUS'});
  });
  it.skipIf(!returnControlEnabled)("binds the complete machining proof to the sent lot and keeps formal release for the return", async () => {
    const f = await subcontractFixture(false);
    const actor = { ...audit(), role: "Directeur", request_id: null };
    const machining = randomUUID(), operationSource = randomUUID(), plan = randomUUID(), control = randomUUID();
    await pool.query("UPDATE public.of_revisions SET statut='ACTIVE' WHERE of_id=$1", [f.ofId]);
    await pool.query(
      "INSERT INTO public.pieces_techniques_operations(id,piece_technique_id,phase,designation,type_operation) " +
      "SELECT $1,ofr.piece_technique_id,5,'Fraisage fixture','FRAISAGE' FROM public.ordres_fabrication ofr WHERE id=$2",
      [operationSource, f.ofId],
    );
    await pool.query(
      "INSERT INTO public.of_operations(id,of_id,phase,designation,revision_id,source_piece_operation_id) " +
      "SELECT $1,of_id,5,'Fraisage fixture',revision_id,$2 FROM public.of_operations WHERE id=$3",
      [machining, operationSource, f.operationId],
    );
    await pool.query(
      "INSERT INTO public.quality_control_plan(id,code,label,status,trigger_type,sampling_rule,published_at,published_by,created_by,updated_by,piece_technique_id) " +
      "SELECT $1,$2,'Relevé sortie fixture','PUBLISHED','IN_PROCESS','LOT',now(),$3,$3,$3,piece_technique_id FROM public.ordres_fabrication WHERE id=$4",
      [plan, "PLAN-" + plan, user, f.ofId],
    );
    const snapshot = { schema: "cerp.quality.plan-snapshot.v1", characteristics: [{
      key: "e1", position: 1, label: "Épaisseur", characteristic_type: "DIMENSION", value_kind: "NUMERIC", unit: "mm",
      nominal: 15, tolerance_min: -0.1, tolerance_max: 0.1, precision: null, expected_boolean: null,
      allowed_values: null, criticality: "MAJOR", mandatory: true, requires_instrument: false, instrument_category: null,
      method: null, acceptance_rule: null, sampling: { rule: "LOT", value: null, justification: null }, trigger: "IN_PROCESS",
    }] };
    const seedControl = (id: string) => pool.query(
      "INSERT INTO public.quality_control(id,reference,control_type,status,control_date,controlled_by,of_id,operation_id,source_type,source_id," +
      "trigger_type,plan_id,plan_version,plan_snapshot,plan_snapshot_sha256,qty_population,unite,created_by,updated_by) " +
      "VALUES($1,$2,'IN_PROCESS','IN_PROGRESS',now(),$3,$4,$5,'OF_OPERATION',$5::uuid::text," +
      "'IN_PROCESS',$6,1,$7::jsonb,$8,100,'u',$3,$3)",
      [id, "CQ-" + id, user, f.ofId, machining, plan, JSON.stringify(snapshot), qualitySha256(snapshot)],
    );
    await seedControl(control);
    const confirm = async (id = control, lot_id?: string) => repoRecordAutocontrolCapture({ id, actor, idempotencyKey: randomUUID(),
      body: { mode: "DIGITAL", confirm: true, lot_id, expected_updated_at: new Date((await repoGetExecution(id))!.updated_at).toISOString() } });
    async function issue(issueId: string, lotId = f.sourceLot, materialOriginId: string | null = f.sourceLot, packageId = f.packageId) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("INSERT INTO public.subcontract_work_package_ledger(id,package_id,event_type,lot_id,qty,unit,idempotency_key,created_by) " +
          "VALUES($1,$2,'ISSUE',$3,100,'u',$4,$5)", [issueId, packageId, lotId, randomUUID(), user]);
        await bindSubcontractIssueAutocontrol(tx, { ofId: f.ofId, operationId: f.operationId, issueId, lotId,
          materialOriginId, quantity: 100, unit: "u" }, actor);
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally { tx.release(); }
    }
    expect(await repoGetExecution(control)).toMatchObject({ autocontrol_confirmable: true, autocontrol_lots: [] });
    await expect(issue(f.issueEventId)).rejects.toMatchObject({ code: "SUBCONTRACT_AUTOCONTROL_LOT_UNVERIFIED" });
    await expect(confirm()).rejects.toMatchObject({ code: "AUTOCONTROL_MEASUREMENTS_INCOMPLETE" });
    const measurement = async (value: number, correction_reason?: string, id = control) => repoRecordMeasurements({ id, actor,
      body: { expected_updated_at: new Date((await repoGetExecution(id))!.updated_at).toISOString(),
        correction_reason, measurements: [measurementInputSchema.parse({ characteristic_key: "e1", sample_no: 1, value_numeric: value, unit: "mm" })] },
    });
    await measurement(15);
    expect(await confirm()).toMatchObject({ autocontrol_confirmation: { mode: "DIGITAL", lot_id: null }, ledger: { released: 0 } });
    await pool.query("INSERT INTO public.subcontract_purchase_origins(line_id,of_id,operation_id,material_origin_id,preparation_snapshot,created_by) " +
      "SELECT supplier_order_line_id,$2,$3,$4,'{}',$5 FROM public.subcontract_work_packages WHERE id=$1",
      [f.packageId, f.ofId, f.operationId, f.sourceLot, user]);
    await issue(f.issueEventId);
    await measurement(15.025, "Relecture de la mesure");
    expect((await repoGetExecution(control))!.autocontrol_confirmation).toBeUndefined();
    expect(await confirm()).toMatchObject({ autocontrol_confirmation: { lot_id: f.sourceLot } });
    await bindReceiptSubcontract(f.receipt, f.line, { idempotencyKey: randomUUID(), expectedVersion: 1,
      origins: [{ issueEventId: f.issueEventId, quantity: 100 }] }, actor);
    const state = await readReceiptReturnControl(f.receipt, f.line, true);
    expect(state).toMatchObject({ canRecord: true, sources: [{ issueId: f.issueEventId,
      proofs: [{ controlId: control, operationId: machining, measurements: [{ valueMm: 15, minMm: 14.9, maxMm: 15.1 }] }],
    }] });
    expect(await readReceiptReturnControl(f.receipt, f.line, false)).toMatchObject({ canRecord: false });
    await expect(assertSubcontractReturnVerified(pool, f.line)).rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_CONTROL_REQUIRED" });
    const input = { idempotencyKey: randomUUID(), expectedVersion: state.version, sourceIssueId: f.issueEventId,
      appearance: "OK" as const, verdict: "CONFORME" as const,
      measurements: [{ controlId: control, characteristicKey: "e1", sampleNo: 1, valueMm: 15.2 }],
    };
    await expect(recordReceiptReturnControl(f.receipt, f.line, { ...input, sourceIssueId: randomUUID() }, actor))
      .rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_PROOF_REQUIRED" });
    await expect(recordReceiptReturnControl(f.receipt, f.line, input, actor)).rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_VERDICT_INVALID" });
    await expect(recordReceiptReturnControl(f.receipt, f.line, { ...input, verdict: "NON_CONFORME", measurements: [] }, actor))
      .rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_NONCONFORMITY_EVIDENCE_REQUIRED" });
    const refusal = { ...input, verdict: "NON_CONFORME" as const, appearance: "NOK" as const, measurements: [], comment: "Aspect rayé au retour." };
    const recorded = await recordReceiptReturnControl(f.receipt, f.line, refusal, actor);
    expect(recorded).toMatchObject({ verdict: "NON_CONFORME", nonConformityId: expect.any(String) });
    expect(await recordReceiptReturnControl(f.receipt, f.line, refusal, actor)).toEqual(recorded);
    await expect(assertSubcontractReturnVerified(pool, f.line)).resolves.toBeUndefined();
    expect(await readReceiptReturnControl(f.receipt, f.line, true)).toMatchObject({ canRecord: false,
      sources: [{ lotCode: expect.any(String), recorded: { verdict: "NON_CONFORME", appearance: "NOK", nonConformityId: recorded.nonConformityId } }],
    });
    expect((await pool.query("SELECT lot_status FROM public.lots WHERE id=$1", [f.lot])).rows[0].lot_status).not.toBe("LIBERE");
    expect((await readProcessingLine(pool, f.line)).stocked).toBe(0);
    const secondLot = randomUUID(), secondControl = randomUUID(), secondLine = randomUUID(), secondPackage = randomUUID();
    await pool.query("INSERT INTO public.lots(id,article_id,lot_code,lot_status,created_by,updated_by) VALUES($1,$2,$3,'LIBERE',$4,$4)",
      [secondLot, f.mp, "LOT-" + secondLot, user]);
    await pool.query("INSERT INTO public.commande_fournisseur_ligne(id,commande_id,type,designation,quantite,article_id,of_id,position) " +
      "SELECT $1,cl.commande_id,cl.type,cl.designation,cl.quantite,cl.article_id,cl.of_id,cl.position+1 FROM public.commande_fournisseur_ligne cl " +
      "JOIN public.subcontract_work_packages p ON p.supplier_order_line_id=cl.id WHERE p.id=$2",
      [secondLine, f.packageId]);
    await pool.query("INSERT INTO public.subcontract_work_packages(id,supplier_order_line_id,of_operation_id,unit,qty_planned,ged_evidence_document_id,created_by) " +
      "SELECT $1,$2,of_operation_id,unit,qty_planned,ged_evidence_document_id,created_by FROM public.subcontract_work_packages WHERE id=$3",
      [secondPackage, secondLine, f.packageId]);
    await pool.query("INSERT INTO public.subcontract_purchase_origins(line_id,of_id,operation_id,material_origin_id,preparation_snapshot,created_by) " +
      "VALUES($1,$2,$3,$4,'{}',$5)", [secondLine, f.ofId, f.operationId, secondLot, user]);
    await seedControl(secondControl);
    await measurement(15.3, undefined, secondControl);
    await expect(confirm(secondControl)).rejects.toMatchObject({ code: "AUTOCONTROL_LOT_REQUIRED" });
    await expect(confirm(control, secondLot)).rejects.toMatchObject({ code: "AUTOCONTROL_LOT_CHANGED" });
    expect(await confirm(secondControl, secondLot)).toMatchObject({ verdict: "NON_CONFORME",
      autocontrol_confirmation: { lot_id: secondLot }, ledger: { conforming: 0, released: 0 },
    });
    const secondIssue = randomUUID();
    await expect(issue(secondIssue, secondLot, secondLot, secondPackage)).rejects.toMatchObject({ code: "SUBCONTRACT_AUTOCONTROL_REQUIRED" });
    expect((await pool.query("SELECT 1 FROM public.subcontract_work_package_ledger WHERE id=$1", [secondIssue])).rowCount).toBe(0);
    const removableDocument = randomUUID(), pinnedDocument = randomUUID();
    await pool.query(
      "INSERT INTO public.quality_documents(id,entity_type,entity_id,document_type,original_name,stored_name,storage_path,mime_type,size_bytes,uploaded_by) " +
      "SELECT id,'CONTROL',$1,'REPORT','fiche.pdf',id::text,id::text,'application/pdf',1,$2 FROM unnest($3::uuid[]) id",
      [control, user, [removableDocument, pinnedDocument]],
    );
    await pool.query("INSERT INTO public.quality_event_log(entity_type,entity_id,event_type,user_id,new_values) " +
      "VALUES('CONTROL',$1,'SUBCONTRACT_AUTOCONTROL_ISSUED',$2,$3::jsonb)",
      [control, user, JSON.stringify({ issueId: f.issueEventId, proof: { documentId: pinnedDocument } })]);
    await expect(repoRemoveDocument({ entity_type: "CONTROL", entity_id: control, doc_id: removableDocument, audit: actor })).resolves.toBe(true);
    await expect(repoRemoveDocument({ entity_type: "CONTROL", entity_id: control, doc_id: pinnedDocument, audit: actor }))
      .rejects.toMatchObject({ code: "AUTOCONTROL_SCAN_IN_USE" });
  });
  it.skipIf(!returnControlEnabled)("requires a scanned handwritten sheet when there is no plan and keeps its pinned GED version on return", async () => {
    const f = await subcontractFixture(false);
    const actor = { ...audit(), role: "Directeur", request_id: null };
    const machining = randomUUID(), operationSource = randomUUID(), documentId = randomUUID(), versionId = randomUUID(),
      uploadId = randomUUID(), blobId = randomUUID();
    await pool.query("UPDATE public.of_revisions SET statut='ACTIVE' WHERE of_id=$1", [f.ofId]);
    await pool.query(
      "INSERT INTO public.pieces_techniques_operations(id,piece_technique_id,phase,designation,type_operation) " +
      "SELECT $1,ofr.piece_technique_id,5,'Tournage fixture','TOURNAGE' FROM public.ordres_fabrication ofr WHERE id=$2",
      [operationSource, f.ofId],
    );
    await pool.query(
      "INSERT INTO public.of_operations(id,of_id,phase,designation,revision_id,source_piece_operation_id) " +
      "SELECT $1,of_id,5,'Tournage fixture',revision_id,$2 FROM public.of_operations WHERE id=$3",
      [machining, operationSource, f.operationId],
    );
    await pool.query("INSERT INTO public.subcontract_purchase_origins(line_id,of_id,operation_id,material_origin_id,preparation_snapshot,created_by) " +
      "SELECT supplier_order_line_id,$2,$3,$4,'{}',$5 FROM public.subcontract_work_packages WHERE id=$1",
      [f.packageId, f.ofId, f.operationId, f.sourceLot, user]);
    expect(await getPaperSubcontractAttestationOptions(pool, f.operationId)).toMatchObject({ of_id: f.ofId,
      operations: [{ id: machining, phase: 5, label: "Tournage fixture" }], documents: [] });

    const pdf = Buffer.from("%PDF-1.4\n% Handwritten evidence fixture " + randomUUID() + "\n%%EOF\n");
    const blob = await writeBlob(pdf);
    await pool.query("INSERT INTO public.ged_documents(id,code,class_key,title) VALUES($1,$2,'RELEVE_CONTROLE','Fiche manuelle fixture')",
      [documentId, "GED-" + documentId]);
    await pool.query("INSERT INTO public.ged_blobs(id,sha256,size_bytes,mime_type,storage_key,created_by) VALUES($1,$2,$3,'application/pdf',$4,$5)",
      [blobId, blob.sha256, blob.size_bytes, blob.storage_key, user]);
    await pool.query("INSERT INTO public.ged_upload_sessions(id,class_key,document_id,status,sha256,size_bytes,mime_type,original_name,expires_at,created_by," +
      "scan_status,quarantine_status) VALUES($1,'RELEVE_CONTROLE',$2,'PUBLISHED',$3,$4,'application/pdf','fiche.pdf',now()+interval '1 day',$5,'clean','released')",
      [uploadId, documentId, blob.sha256, blob.size_bytes, user]);
    await pool.query("INSERT INTO public.ged_document_versions(id,document_id,version_number,blob_id,original_name,created_by,upload_session_id) " +
      "VALUES($1,$2,1,$3,'fiche.pdf',$4,$5)", [versionId, documentId, blobId, user, uploadId]);
    await pool.query("UPDATE public.ged_document_versions SET status='APPLICABLE',published_at=now() WHERE id=$1", [versionId]);
    await pool.query("UPDATE public.ged_documents SET current_version_id=$2 WHERE id=$1", [documentId, versionId]);
    const attestation = { operation_id: machining, document_version_id: versionId, complete_sheet: true as const, conforming_qty: 100 };
    async function issue(paperAttestations?: typeof attestation[]) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("INSERT INTO public.subcontract_work_package_ledger(id,package_id,event_type,lot_id,qty,unit,idempotency_key,created_by) " +
          "VALUES($1,$2,'ISSUE',$3,100,'u',$4,$5)", [f.issueEventId, f.packageId, f.sourceLot, randomUUID(), user]);
        await bindSubcontractIssueAutocontrol(tx, { ofId: f.ofId, operationId: f.operationId, issueId: f.issueEventId,
          lotId: f.sourceLot, materialOriginId: f.sourceLot, quantity: 100, unit: "u", paperAttestations }, actor);
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally { tx.release(); }
    }
    await expect(issue()).rejects.toMatchObject({ code: "SUBCONTRACT_PAPER_FORM_REQUIRED" });
    await expect(issue([attestation])).rejects.toMatchObject({ code: "SUBCONTRACT_PAPER_SCAN_SCOPE" });
    await pool.query("INSERT INTO public.ged_document_links(document_id,entity_type,entity_id,link_role,created_by) " +
      "VALUES($1,'ORDRE_FABRICATION',$2,'RELEVE_CONTROLE_REALISE',$3)", [documentId, String(f.ofId), user]);
    expect(await getPaperSubcontractAttestationOptions(pool, f.operationId)).toMatchObject({ documents: [{ version_id: versionId }] });
    await expect(issue([{ ...attestation, conforming_qty: 99 }])).rejects.toMatchObject({ code: "SUBCONTRACT_PAPER_QUANTITY" });
    await issue([attestation]);
    expect(await readPaperSubcontractIssueHash(pool, f.issueEventId)).toBe(hashPaperSubcontractAttestations([attestation]));
    await bindReceiptSubcontract(f.receipt, f.line, { idempotencyKey: randomUUID(), expectedVersion: 1,
      origins: [{ issueEventId: f.issueEventId, quantity: 100 }] }, actor);
    await pool.query("UPDATE public.ged_document_versions SET status='OBSOLETE',obsoleted_at=now() WHERE id=$1", [versionId]);
    await pool.query("UPDATE public.ged_documents SET current_version_id=NULL,archived_at=now(),archived_by=$2 WHERE id=$1", [documentId, user]);
    expect(await getPaperSubcontractAttestationOptions(pool, f.operationId)).toMatchObject({ documents: [] });
    const state = await readReceiptReturnControl(f.receipt, f.line, true);
    expect(state).toMatchObject({ canRecord: true, sources: [{ issueId: f.issueEventId, proofs: [{ operationId: machining,
      mode: "PAPER", documentId: versionId, measurements: [] }] }] });
    expect(state.sources[0].proofs[0].controlId).toBeUndefined();
    expect(await readReceiptReturnDocument(f.receipt, f.line, f.issueEventId, versionId)).toEqual({ bytes: pdf, mimeType: "application/pdf" });
    await expect(readReceiptReturnDocument(f.receipt, f.line, f.issueEventId, randomUUID())).rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_SCAN_NOT_FOUND" });
    await expect(assertSubcontractReturnVerified(pool, f.line)).rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_CONTROL_REQUIRED" });
    const input = { idempotencyKey: randomUUID(), expectedVersion: state.version, sourceIssueId: f.issueEventId, appearance: "NOK" as const,
      verdict: "NON_CONFORME" as const, comment: "Trace dans la zone tolérancée.", measurements: [] };
    await expect(recordReceiptReturnControl(f.receipt, f.line, input, actor)).rejects.toMatchObject({ code: "SUBCONTRACT_RETURN_NONCONFORMITY_EVIDENCE_REQUIRED" });
    const result = await recordReceiptReturnControl(f.receipt, f.line, { ...input, paperMeasurement: { label: "Épaisseur", valueMm: 14.8 } }, actor);
    expect(result).toMatchObject({ verdict: "NON_CONFORME", nonConformityId: expect.any(String) });
    const nc = (await pool.query("SELECT description FROM public.non_conformity WHERE id=$1", [result.nonConformityId])).rows[0];
    expect(nc.description).toContain(input.comment);
    expect(nc.description).toContain("Épaisseur : 14.8 mm");
    expect((await pool.query("SELECT 1 FROM public.quality_control WHERE of_id=$1 AND operation_id=$2", [f.ofId, machining])).rowCount).toBe(0);
    expect((await readProcessingLine(pool, f.line)).stocked).toBe(0);
  });
  it.skipIf(!externalEnabled)(
    "accumulates small transfers toward a downstream threshold",
    async () => {
      const f = await subcontractFixture(),
        next = randomUUID();
      await pool.query(
        "UPDATE public.of_revisions SET statut='ACTIVE' WHERE of_id=$1",
        [f.ofId],
      );
      await pool.query(
        "INSERT INTO public.of_operations(id,of_id,revision_id,phase,designation) SELECT $1,$2,revision_id,20,'Reprise après traitement' FROM public.of_operations WHERE id=$3",
        [next, f.ofId, f.operationId],
      );
      await pool.query(
        "INSERT INTO public.planning_operation_dependencies(predecessor_id,successor_id,transfer_quantity) VALUES($1,$2,20)",
        ["op:" + f.operationId, "op:" + next],
      );
      await bindReceiptSubcontract(
        f.receipt,
        f.line,
        {
          idempotencyKey: randomUUID(),
          expectedVersion: 1,
          origins: [{ issueEventId: f.issueEventId, quantity: 100 }],
        },
        audit(),
      );
      await pool.query(
        "UPDATE public.lots SET lot_status='LIBERE' WHERE id=$1",
        [f.lot],
      );
      for (const total of [10, 20]) {
        const before = (await getSubcontractFlow(f.packageId)).flow!;
        await transferSubcontractReturn(
          f.packageId,
          {
            return_id: before.returns[0].id,
            successor_operation_id: next,
            quantity: 10,
            expected_version: before.version,
            reason: "Lot de dix pièces",
            action: "RELEASE",
          },
          audit(),
          randomUUID(),
        );
        expect((await getSubcontractFlow(f.packageId)).flow!.transferred).toBe(
          total,
        );
      }
    },
  );
  it.skipIf(!externalEnabled)(
    "caps external WIP, rejects concurrent over-allocation and replays one transfer without stock duplication",
    async () => {
      const f = await subcontractFixture(),
        next = randomUUID();
      await pool.query(
        "UPDATE public.of_revisions SET statut='ACTIVE' WHERE of_id=$1",
        [f.ofId],
      );
      await pool.query(
        "INSERT INTO public.of_operations(id,of_id,revision_id,phase,designation) SELECT $1,$2,revision_id,20,'Reprise après traitement' FROM public.of_operations WHERE id=$3",
        [next, f.ofId, f.operationId],
      );
      await pool.query(
        "INSERT INTO public.planning_operation_dependencies(predecessor_id,successor_id,transfer_quantity) VALUES($1,$2,20)",
        ["op:" + f.operationId, "op:" + next],
      );
      await bindReceiptSubcontract(
        f.receipt,
        f.line,
        {
          idempotencyKey: randomUUID(),
          expectedVersion: 1,
          origins: [{ issueEventId: f.issueEventId, quantity: 100 }],
        },
        audit(),
      );
      expect((await getSubcontractFlow(f.packageId)).flow?.released).toBe(0);
      await pool.query(
        "UPDATE public.lots SET lot_status='LIBERE' WHERE id=$1",
        [f.lot],
      );
      const state = await getSubcontractFlow(f.packageId);
      expect(state.flow).toMatchObject({
        returned: 100,
        released: 60,
        transferred: 0,
      });
      expect(state.successors).toContainEqual(
        expect.objectContaining({ id: next, minimum: 20 }),
      );
      const body = {
          return_id: state.flow!.returns[0].id,
          successor_operation_id: next,
          quantity: 40,
          expected_version: state.flow!.version,
          reason: "Transfert du premier lot",
          action: "RELEASE" as const,
        },
        key = randomUUID();
      const results = await Promise.allSettled([
        transferSubcontractReturn(f.packageId, body, audit(), key),
        transferSubcontractReturn(f.packageId, body, audit(), randomUUID()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // Replay the winning payload even though the flow version has changed.
      if (results[0].status === "fulfilled")
        expect(
          await transferSubcontractReturn(f.packageId, body, audit(), key),
        ).toEqual(results[0].value);
      expect((await getSubcontractFlow(f.packageId)).flow).toMatchObject({
        released: 60,
        transferred: 40,
      });
      const processing = await readProcessingLine(pool, f.line);
      expect(processing.transferred).toBe(40);
      expect(processing.queues.TO_PACK).toBe(20);
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM public.stock_movement_lines WHERE lot_id=$1",
              [f.lot],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
      const current = (await getSubcontractFlow(f.packageId)).flow!;
      await expect(
        transferSubcontractReturn(
          f.packageId,
          { ...body, quantity: 21, expected_version: current.version },
          audit(),
          randomUUID(),
        ),
      ).rejects.toMatchObject({
        code: "SUBCONTRACT_TRANSFER_QUANTITY_EXCEEDED",
      });
      await packReceipt(
        f.receipt,
        f.line,
        {
          idempotencyKey: randomUUID(),
          expectedVersion: processing.version,
          quantity: 20,
          packaging: "Bac de solde",
          packageCount: 1,
        },
        audit(),
      );
      await repoCreateStockReceipt(
        f.receipt,
        f.line,
        { qty: 20, dst_magasin_id: warehouse, dst_emplacement_id: place },
        audit(),
        randomUUID(),
      );
      const shared = (await getSubcontractFlow(f.packageId)).flow!;
      expect(shared).toMatchObject({ released: 40, transferred: 40 });
      expect(shared.returns[0].transferable).toBe(0);
      await expect(
        transferSubcontractReturn(
          f.packageId,
          { ...body, quantity: 1, expected_version: shared.version },
          audit(),
          randomUUID(),
        ),
      ).rejects.toMatchObject({
        code: "SUBCONTRACT_TRANSFER_QUANTITY_EXCEEDED",
      });
      await pool.query(
        "UPDATE public.lots SET lot_status='QUARANTAINE' WHERE id=$1",
        [f.lot],
      );
      expect((await getSubcontractFlow(f.packageId)).flow).toMatchObject({
        released: 0,
        transferred: 40,
      });
      await expect(
        transferSubcontractReturn(
          f.packageId,
          { ...body, expected_version: current.version },
          audit(),
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "SUBCONTRACT_FLOW_CHANGED" });
      const changed = (await getSubcontractFlow(f.packageId)).flow!;
      await transferSubcontractReturn(
        f.packageId,
        {
          ...body,
          action: "RETURN",
          quantity: 40,
          expected_version: changed.version,
        },
        audit(),
        randomUUID(),
      );
      expect((await getSubcontractFlow(f.packageId)).flow?.transferred).toBe(0);
      const snapshot = await readCentralSnapshot({
        from: new Date().toISOString(),
        to: new Date(Date.now() + 30 * 86400000).toISOString(),
        limit: 10000,
        includeTaskIds: ["op:" + f.operationId],
      });
      expect(snapshot.tasks.some((t) => t.operationId === f.operationId)).toBe(
        true,
      );
      const task = snapshot.tasks.find((t) => t.operationId === f.operationId)!;
      task.view = "external";
      await hydrateExternalPlanning(
        pool,
        [task],
        snapshot.resources,
        snapshot.dependencies,
        new Date().toISOString(),
        new Date(Date.now() + 30 * 86400000).toISOString(),
      );
      expect(task.external?.packages).toHaveLength(1);
      expect(task.resourceIds[0]).toMatch(/^supplier:/);
      expect((await getSubcontractCreationOptions(f.ofId)).lines).toHaveLength(
        1,
      );
    },
  );
  it("physical receipt never creates stock and forces the piece policy", async () => {
    const f = await fixture(),
      line = await readProcessingLine(pool, f.line);
    expect(line.policy).toBe("PIECES_CONTROLE_EMBALLAGE");
    expect(line.stocked).toBe(0);
    expect(line.packed).toBe(0);
    await expect(
      repoCreateStockReceipt(f.receipt, f.line, body(1), audit(), randomUUID()),
    ).rejects.toMatchObject({ code: "RECEIPT_PACKAGING_REQUIRED" });
  });
  it.skipIf(!externalEnabled)(
    "commits an external preview only on human apply and can unplan without creating factory capacity",
    async () => {
      const f = await subcontractFixture(false, {
          operations: [{ phase: 10, type_operation: "SOUS_TRAITANCE" }],
        }),
        from = new Date().toISOString(),
        to = new Date(Date.now() + 30 * 86400000).toISOString();
      await pool.query(
        "UPDATE public.commande_fournisseur_ligne SET date_promesse=CURRENT_DATE+10 WHERE id=(SELECT supplier_order_line_id FROM public.subcontract_work_packages WHERE id=$1)",
        [f.packageId],
      );
      await pool.query(
        "UPDATE public.of_revisions SET statut='ACTIVE' WHERE of_id=$1",
        [f.ofId],
      );
      await pool.query(
        "UPDATE public.planning_central_settings SET activation='COMMIT' WHERE singleton",
      );
      const snapshot = await readCentralSnapshot({
          from,
          to,
          limit: 10000,
          includeTaskIds: ["op:" + f.operationId],
        }),
        task = snapshot.tasks.find((t) => t.operationId === f.operationId)!;
      expect(task.external?.packages).toHaveLength(1);
      const preview = await createCentralSimulation(
        {
          from,
          to,
          revision: snapshot.revision,
          changes: [
            {
              taskId: task.id,
              expectedVersion: task.version,
              earliestStart: from,
            },
          ],
        },
        audit(),
        randomUUID(),
      );
      expect(preview.result.feasible).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT committed_start FROM public.planning_tasks WHERE id=$1",
            [task.id],
          )
        ).rows[0].committed_start,
      ).toBeNull();
      await applyCentralSimulation(
        preview.id,
        preview.revision,
        audit(),
        randomUUID(),
      );
      const committed = await readCentralSnapshot({
          from,
          to,
          limit: 10000,
          includeTaskIds: [task.id],
        }),
        current = committed.tasks.find((t) => t.id === task.id)!;
      expect(current.commitment).toBe("COMMITTED");
      expect(current.committed).not.toBeNull();
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM public.planning_events WHERE of_operation_id=$1",
              [f.operationId],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
      await unplanCentral(
        {
          from,
          to,
          revision: committed.revision,
          tasks: [{ id: current.id, expectedVersion: current.version }],
        },
        audit(),
        randomUUID(),
      );
      expect(
        (
          await pool.query(
            "SELECT committed_start FROM public.planning_tasks WHERE id=$1",
            [task.id],
          )
        ).rows[0].committed_start,
      ).toBeNull();
    },
  );
  it.skipIf(!externalEnabled)(
    "keeps 60 at the supplier after a partial return of 40 and invalidates the forecast on a new promise",
    async () => {
      const f = await subcontractFixture();
      await pool.query(
        "UPDATE public.reception_fournisseur_lignes SET qty_received=40 WHERE id=$1",
        [f.line],
      );
      await bindReceiptSubcontract(
        f.receipt,
        f.line,
        {
          idempotencyKey: randomUUID(),
          expectedVersion: 1,
          origins: [{ issueEventId: f.issueEventId, quantity: 40 }],
        },
        audit(),
      );
      const before = (await getSubcontractFlow(f.packageId)).flow!;
      expect(before).toMatchObject({
        issued: 100,
        returned: 40,
        custody: 60,
        released: 0,
        transferred: 0,
      });
      await expect(
        pool.query(
          "UPDATE public.subcontract_work_packages SET status='CLOSED',closed_at=now(),close_reason='Test refus clôture' WHERE id=$1",
          [f.packageId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "INSERT INTO public.subcontract_work_package_ledger(package_id,event_type,lot_id,qty,unit,idempotency_key) VALUES($1,'ISSUE',$2,1,'u',$3)",
          [f.packageId, f.sourceLot, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const revision = (
        await pool.query(
          "SELECT revision::text FROM public.planning_central_settings WHERE singleton",
        )
      ).rows[0].revision;
      await pool.query(
        "UPDATE public.commande_fournisseur_ligne SET date_promesse='2026-10-01' WHERE id=(SELECT supplier_order_line_id FROM public.subcontract_work_packages WHERE id=$1)",
        [f.packageId],
      );
      const after = (await getSubcontractFlow(f.packageId)).flow!;
      expect(after.promisedDate).toBe("2026-10-01");
      expect(after.version).not.toBe(before.version);
      expect(
        (
          await pool.query(
            "SELECT revision::text FROM public.planning_central_settings WHERE singleton",
          )
        ).rows[0].revision,
      ).not.toBe(revision);
    },
  );
  it("quality alone cannot post stock; 100/60/50 allows exactly 50 with MP genealogy", async () => {
    const f = await fixture(60);
    await expect(
      repoCreateStockReceipt(f.receipt, f.line, body(1), audit(), randomUUID()),
    ).rejects.toMatchObject({ code: "RECEIPT_PACKAGING_REQUIRED" });
    const packed = await packReceipt(
      f.receipt,
      f.line,
      {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        quantity: 50,
        packaging: "Bacs",
        packageCount: 5,
      },
      audit(),
    );
    expect(packed.queues).toEqual({
      TO_CONTROL: 40,
      TO_PACK: 10,
      TO_STOCK: 50,
    });
    expect(packed.stocked).toBe(0);
    await expect(
      repoCreateStockReceipt(
        f.receipt,
        f.line,
        body(51),
        audit(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_PACKAGING_REQUIRED" });
    const key = randomUUID(),
      first = await repoCreateStockReceipt(
        f.receipt,
        f.line,
        body(50),
        audit(),
        key,
      );
    const replay = await repoCreateStockReceipt(
      f.receipt,
      f.line,
      body(50),
      audit(),
      key,
    );
    expect(replay?.stock_movement_id).toBe(first?.stock_movement_id);
    const portions = (
      await pool.query(
        `SELECT p.stock_lot_id::text,l.article_id::text,p.stock_quantity::float8 FROM public.reception_stock_portions p JOIN public.lots l ON l.id=p.stock_lot_id WHERE receipt_line_id=$1::uuid`,
        [f.line],
      )
    ).rows;
    expect(portions).toHaveLength(1);
    expect(portions[0]).toMatchObject({ article_id: f.mp, stock_quantity: 50 });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM public.stock_lot_genealogy_edges WHERE parent_lot_id=$1::uuid AND child_lot_id=$2::uuid",
          [f.lot, portions[0].stock_lot_id],
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      assertOperationalLotQualityEligibility({
        client: pool,
        lotId: portions[0].stock_lot_id,
        qty: 50,
        unit: "u",
        purpose: "RESERVE",
      }),
    ).resolves.toMatchObject({ target: { qty_released: 50 } });
    await expect(
      assertOperationalLotQualityEligibility({
        client: pool,
        lotId: portions[0].stock_lot_id,
        qty: 51,
        unit: "u",
        purpose: "RESERVE",
      }),
    ).rejects.toMatchObject({ code: "QUALITY_NOT_ELIGIBLE" });
  });
  it("serializes two operators and prevents over-packing accepted quantities", async () => {
    const f = await fixture(60),
      commands = [1, 2].map(() =>
        packReceipt(
          f.receipt,
          f.line,
          {
            idempotencyKey: randomUUID(),
            expectedVersion: 1,
            quantity: 40,
            packaging: "Bac",
            packageCount: 1,
          },
          audit(),
        ),
      );
    const results = await Promise.allSettled(commands);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await readProcessingLine(pool, f.line)).packed).toBe(40);
  });
  it("serializes two stock confirmations and cannot exceed packed quantity", async () => {
    const f = await fixture(60);
    await packReceipt(
      f.receipt,
      f.line,
      {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        quantity: 50,
        packaging: "Bac",
        packageCount: 1,
      },
      audit(),
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        repoCreateStockReceipt(
          f.receipt,
          f.line,
          body(40),
          audit(),
          randomUUID(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await readProcessingLine(pool, f.line)).stocked).toBe(40);
  });
  it("rejects manual receipt-lot stock entry through the common posting service", async () => {
    const f = await fixture(60);
    const movement = await repoCreateMovement(manualMovement(f), audit());
    await expect(
      repoPostMovement(movement.movement.id, {}, audit(), randomUUID()),
    ).rejects.toMatchObject({ code: "RECEIPT_PACKAGING_REQUIRED" });
  });
  it("guards an importer that inserts a posted header before attaching its receipt lot", async () => {
    const f = await fixture(60),
      tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const movement = await repoCreateMovement(manualMovement(f), audit(), {
        client: tx,
      });
      const saved = await tx.query(
        "DELETE FROM public.stock_movement_lines WHERE movement_id=$1::uuid RETURNING *",
        [movement.movement.id],
      );
      await tx.query(
        "UPDATE public.stock_movements SET status='POSTED',posted_at=now(),posted_by=$2 WHERE id=$1::uuid",
        [movement.movement.id, user],
      );
      await tx.query(
        "INSERT INTO public.stock_movement_lines SELECT * FROM jsonb_populate_record(NULL::public.stock_movement_lines,$1::jsonb)",
        [JSON.stringify(saved.rows[0])],
      );
      await expect(tx.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("RECEIPT_PACKAGING_REQUIRED"),
      });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });
  it("rechecks quality after packaging and retains the validated history", async () => {
    const f = await fixture(60);
    await packReceipt(
      f.receipt,
      f.line,
      {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        quantity: 50,
        packaging: "Bac",
        packageCount: 1,
      },
      audit(),
    );
    await pool.query(
      "UPDATE public.quality_control SET qty_released=40,qty_held=60 WHERE reception_ligne_id=$1::uuid",
      [f.line],
    );
    await expect(
      repoCreateStockReceipt(
        f.receipt,
        f.line,
        body(50),
        audit(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_QUANTITY_INCONSISTENT" });
    expect((await readProcessingLine(pool, f.line)).packed).toBe(50);
    expect((await readProcessingLine(pool, f.line)).stocked).toBe(0);
    // Restore the synthetic quality downgrade after proving the fail-closed path.
    await pool.query(
      "UPDATE public.quality_control SET qty_released=60,qty_held=40 WHERE reception_ligne_id=$1::uuid",
      [f.line],
    );
  });
  it("requires an intact delivery note before packaging", async () => {
    const f = await fixture(60);
    await pool.query(
      "UPDATE public.reception_fournisseur_documents SET sha256=repeat('0',64) WHERE reception_id=$1::uuid",
      [f.receipt],
    );
    await expect(
      packReceipt(
        f.receipt,
        f.line,
        {
          idempotencyKey: randomUUID(),
          expectedVersion: 1,
          quantity: 50,
          packaging: "Bac",
          packageCount: 1,
        },
        audit(),
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_DELIVERY_NOTE_CHANGED" });
  });
  it("keeps direct consumables and pieces on independent stages within the same receipt", async () => {
    const piece = await fixture(),
      consumable = await fixture(0, "CONSUMABLE");
    await pool.query(
      "UPDATE public.reception_fournisseur_lignes SET reception_id=$2::uuid,line_no=2 WHERE id=$1::uuid",
      [consumable.line, piece.receipt],
    );
    await repoCreateStockReceipt(
      piece.receipt,
      consumable.line,
      body(100),
      audit(),
      randomUUID(),
    );
    expect((await readProcessingLine(pool, consumable.line)).stage).toBe(
      "DONE",
    );
    expect((await readProcessingLine(pool, piece.line)).stocked).toBe(0);
    await expect(
      assertReceiptProcessingClosed(pool, { receptionId: piece.receipt }),
    ).rejects.toMatchObject({ code: "RECEIPT_PROCESSING_OPEN" });
  });
  it("posts tools once into the legacy tool ledger and never into article stock", async () => {
    const f = await fixture(0, "TOOL");
    const command = {
      idempotencyKey: randomUUID(),
      expectedVersion: 1,
      quantity: 20,
    };
    await stockToolReceipt(f.receipt, f.line, command, audit());
    await stockToolReceipt(f.receipt, f.line, command, audit());
    expect(
      (
        await pool.query(
          "SELECT quantite::integer FROM public.gestion_outils_stock WHERE id_outil=$1",
          [f.toolId],
        )
      ).rows[0].quantite,
    ).toBe(20);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM public.stock_movement_lines WHERE article_id=$1::uuid",
          [f.id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM public.reception_tool_stock_receipts WHERE receipt_line_id=$1::uuid",
          [f.line],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("associates one finished article with several clients and enforces CRP coherence", async () => {
    const f = await fixture();
    const pt = await technicalPiece();
    const clients: string[] = [];
    for (let i = 0; i < 2; i++)
      clients.push(
        (
          await pool.query(
            "INSERT INTO public.clients(company_name,client_code) VALUES('Client fixture 1069',$1) RETURNING client_id",
            [`C-${randomUUID()}`],
          )
        ).rows[0].client_id,
      );
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        "UPDATE public.articles SET article_category='fabrique',article_type='PIECE_TECHNIQUE',piece_technique_id=$2::uuid WHERE id=$1::uuid",
        [f.id, pt],
      );
      await syncArticleCommercialTx(
        tx,
        f.id,
        { commercial_scope: "CLIENTS", client_ids: clients },
        user,
      );
      await tx.query("COMMIT");
      expect(
        (
          await pool.query(
            "SELECT client_id FROM public.article_client_links WHERE article_id=$1::uuid",
            [f.id],
          )
        ).rows,
      ).toHaveLength(2);
      await tx.query("BEGIN");
      await expect(
        syncArticleCommercialTx(
          tx,
          f.id,
          { commercial_scope: "CRP", client_ids: clients },
          user,
        ),
      ).rejects.toMatchObject({ status: 422 });
      await tx.query("ROLLBACK");
      await tx.query("BEGIN");
      await tx.query(
        "UPDATE public.articles SET internal_reference='CRP-TEST-1069' WHERE id=$1::uuid",
        [f.id],
      );
      await syncArticleCommercialTx(
        tx,
        f.id,
        { commercial_scope: "CRP", client_ids: [] },
        user,
      );
      await tx.query("COMMIT");
      expect(
        (
          await pool.query(
            "SELECT client_id FROM public.article_client_links WHERE article_id=$1::uuid",
            [f.id],
          )
        ).rows,
      ).toHaveLength(0);
      await expect(
        pool.query(
          "UPDATE public.articles SET internal_reference=NULL WHERE id=$1::uuid",
          [f.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });
  it("links a subcontract return to its dispatched lot, OF and operation before MP stocking", async () => {
    const f = await subcontractFixture();
    expect((await readProcessingLine(pool, f.line)).subcontract?.linked).toBe(
      false,
    );
    const command = {
      idempotencyKey: randomUUID(),
      expectedVersion: 1,
      origins: [{ issueEventId: f.issueEventId, quantity: 100 }],
    };
    await bindReceiptSubcontract(f.receipt, f.line, command, audit());
    await bindReceiptSubcontract(f.receipt, f.line, command, audit());
    expect(
      (
        await pool.query(
          "SELECT 1 FROM public.subcontract_work_package_ledger WHERE package_id=$1::uuid AND event_type='RETURN'",
          [f.packageId],
        )
      ).rows,
    ).toHaveLength(1);
    expect((await readProcessingLine(pool, f.line)).stocked).toBe(0);
    await pool.query(
      "UPDATE public.lots SET lot_status='LIBERE' WHERE id=$1::uuid",
      [f.lot],
    );
    await packReceipt(
      f.receipt,
      f.line,
      {
        idempotencyKey: randomUUID(),
        expectedVersion: 2,
        quantity: 50,
        packaging: "Bac",
        packageCount: 1,
      },
      audit(),
    );
    await repoCreateStockReceipt(
      f.receipt,
      f.line,
      body(50),
      audit(),
      randomUUID(),
    );
    const line = await readProcessingLine(pool, f.line);
    expect(line.stocked).toBe(50);
    expect(line.subcontract?.links[0]).toMatchObject({
      source_lot_id: f.sourceLot,
      of_operation_id: f.operationId,
      of_id: String(f.ofId),
    });
  });
  it("reuses an existing subcontract RETURN without recording custody twice", async () => {
    const f = await subcontractFixture(),
      returnId = randomUUID();
    await pool.query(
      "INSERT INTO public.subcontract_work_package_ledger(id,package_id,event_type,lot_id,qty,unit,idempotency_key,created_by) VALUES($1::uuid,$2::uuid,'RETURN',$3::uuid,100,'u',$4,$5)",
      [returnId, f.packageId, f.lot, randomUUID(), user],
    );
    await bindReceiptSubcontract(
      f.receipt,
      f.line,
      {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        returnEventId: returnId,
        origins: [{ issueEventId: f.issueEventId, quantity: 100 }],
      },
      audit(),
    );
    const line = await readProcessingLine(pool, f.line);
    expect(line.subcontract?.links[0].return_event_id).toBe(returnId);
    expect(line.subcontract?.returns).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM public.subcontract_work_package_ledger WHERE package_id=$1::uuid AND event_type='RETURN'",
          [f.packageId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("closes a partial receipt only after its rejected quantity has a closed disposition", async () => {
    const f = await fixture(60);
    await packReceipt(
      f.receipt,
      f.line,
      {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        quantity: 60,
        packaging: "Bac",
        packageCount: 1,
      },
      audit(),
    );
    await repoCreateStockReceipt(
      f.receipt,
      f.line,
      body(60),
      audit(),
      randomUUID(),
    );
    const ncId = randomUUID();
    await pool.query(
      "INSERT INTO public.non_conformity(id,description,control_id,lot_id,reception_ligne_id,qty,unite,detected_by,created_by,updated_by) SELECT $1::uuid,'Refus partiel fixture',id,lot_id,reception_ligne_id,40,'u',$3,$3,$3 FROM public.quality_control WHERE reception_ligne_id=$2::uuid",
      [ncId, f.line, user],
    );
    expect(await readReceiptDispositionContext(pool, ncId, f.lot)).toMatchObject({
      receiptLineId: f.line, remainingQty: 40, unit: "u", reconciliationRequired: false,
    });
    const readAcceptedStock = () => pool.query(
      `SELECT m.stock_batch_id::text,b.qty_total::float8,b.qty_reserved::float8,b.qty_depreciated::float8
       FROM public.reception_fournisseur_stock_receipts r
       JOIN public.stock_movements m ON m.id=r.stock_movement_id
       JOIN public.stock_batches b ON b.id=m.stock_batch_id
       WHERE r.reception_line_id=$1::uuid ORDER BY b.id`, [f.line],
    );
    const acceptedStockBefore = (await readAcceptedStock()).rows;
    expect(acceptedStockBefore).toHaveLength(1);
    expect(acceptedStockBefore[0].qty_total).toBe(60);
    const decision = {
      id: ncId,
      body: {
        idempotency_key: randomUUID(),
        disposition_type: "RETURN_SUPPLIER" as const,
        qty: 40,
        unite: "u",
        comment: "Retour fournisseur des 40 refusées",
      },
      audit: audit(),
    };
    const disposition = await repoCreateNonConformityDisposition(decision);
    expect(disposition.stock_movement_id).toBeNull();
    expect((await repoCreateNonConformityDisposition(decision)).id).toBe(disposition.id);
    expect((await readAcceptedStock()).rows).toEqual(acceptedStockBefore);
    expect(await readReceiptDispositionContext(pool, ncId, f.lot)).toMatchObject({ remainingQty: 0, unit: "u" });
    const releaseTx = await pool.connect();
    try {
      await releaseTx.query("BEGIN");
      const scope = await lockReceiptReleaseScope(releaseTx, f.line);
      await expect(
        assertReceiptReleaseAvailable(releaseTx, scope, 60, "u"),
      ).resolves.toBeUndefined();
      await expect(
        assertReceiptReleaseAvailable(releaseTx, scope, 61, "u"),
      ).rejects.toMatchObject({ code: "RECEIPT_RELEASE_DISPOSED_QUANTITY" });
    } finally {
      await releaseTx.query("ROLLBACK");
      releaseTx.release();
    }
    await expect(
      repoCreateNonConformityDisposition({
        id: ncId,
        body: { disposition_type: "RETURN_SUPPLIER", qty: 1, unite: "u" },
        audit: audit(),
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_DISPOSITION_QUANTITY" });
    await expect(
      assertReceiptProcessingClosed(pool, { receptionId: f.receipt }),
    ).rejects.toMatchObject({ code: "RECEIPT_PROCESSING_OPEN" });
    await pool.query(
      "UPDATE public.non_conformity SET status='CLOSED',closed_at=now(),closed_by=$2 WHERE id=$1::uuid",
      [ncId, user],
    );
    const line = await readProcessingLine(pool, f.line);
    expect(line).toMatchObject({
      stocked: 60,
      disposed: 40,
      stage: "DONE",
      queues: { TO_CONTROL: 0, TO_PACK: 0, TO_STOCK: 0 },
    });
    await expect(
      assertReceiptProcessingClosed(pool, { receptionId: f.receipt }),
    ).resolves.toBeUndefined();
    const queue = await listProcessingLines({
      q: line.receptionNumber,
      stage: "DONE",
      page: 1,
      pageSize: 30,
    });
    expect(queue.items.map((item) => item.id)).toEqual([f.line]);
  });
});
