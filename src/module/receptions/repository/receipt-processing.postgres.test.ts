import fs from "node:fs/promises";
import path from "node:path";
import { getDocumentStoragePath } from "../../../utils/cerpStorage";
import {
  repoCreateEmplacement,
  repoCreateMovement,
  repoPostMovement,
} from "../../stock/repository/stock.repository";
import { createEmplacementSchema } from "../../stock/validators/stock.validators";
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
  type AuditContext,
} from "./receptions.repository";
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { stockToolReceipt } from "./receipt-tool-stock.repository";
import { syncArticleCommercialTx } from "../../stock/repository/article-commercial.repository";
import { assertReceiptProcessingClosed } from "./receipt-processing-guard";
import { bindReceiptSubcontract } from "./receipt-subcontract.repository";
import { repoCreateNonConformityDisposition } from "../../qualite/repository/qualite.repository";
import {
  lockReceiptReleaseScope,
  assertReceiptReleaseAvailable,
} from "./receipt-quality-release.repository";

// Full migrated schema, opt-in and restricted to the dedicated local rehearsal.
const enabled =
  process.env.CERP_RECEIPT_PG_TEST === "1" &&
  new URL(process.env.DATABASE_URL ?? "postgresql://localhost/unused")
    .pathname === "/cerp_1069_test";
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
  for (const [article, category] of [
    [id, "achat"],
    [mp, "matiere"],
  ])
    await pool.query(
      `INSERT INTO public.articles(id,root_article_id,code,designation,family_code,version_number,plan_index,status,article_type,article_category,unite,stock_managed,lot_tracking,created_by,updated_by)
    VALUES($1::uuid,$1::uuid,$2,'Fixture pièce 1069','TEST1069',1,1,'VALIDE','PURCHASED',$3,'u',true,true,$4,$4)`,
      [article, `T-${article.slice(0, 8)}`, category, user],
    );
  await pool.query(
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
    VALUES($1::uuid,$2::uuid,1,$3::uuid,100,'u',$4::uuid,'u',1,$5,$5,$6)`,
    [line, receipt, id, lot, user, kind === "PIECE" || accepted > 0],
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
async function technicalPiece() {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,name_piece,code_piece,designation) VALUES($1::uuid,$1::uuid,1,'Pièce fixture 1069',$2,'Pièce fixture 1069')",
    [id, `PT-${id}`],
  );
  return id;
}
async function subcontractFixture() {
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
  const ofId = Number(
    (
      await pool.query(
        "INSERT INTO public.ordres_fabrication(numero,piece_technique_id,quantite_lancee) VALUES($1,$2::uuid,100) RETURNING id",
        [`OF-T-${randomUUID().slice(0, 16)}`, pt],
      )
    ).rows[0].id,
  );
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
    ).toBe("cerp_1069_test");
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
    const disposition = await repoCreateNonConformityDisposition({
      id: ncId,
      body: {
        disposition_type: "RETURN_SUPPLIER",
        qty: 40,
        unite: "u",
        comment: "Retour fournisseur des 40 refusées",
      },
      audit: audit(),
    });
    expect(disposition.stock_movement_id).toBeNull();
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
