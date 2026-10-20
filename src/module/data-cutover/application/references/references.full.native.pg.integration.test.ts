import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoPath } from "../../../../__tests__/helpers/repo-paths";
import { createCutoverApplicationService } from "../application.service";
import { cutoverReferenceAdapters } from "./references.adapter";
import { cutoverOrdersAdapter } from "../orders/orders.adapter";

const url = process.env.CERP_CUTOVER_NATIVE_INTEGRATION_URL;
const suite = url ? describe : describe.skip;
const batchId = randomUUID();
const token = randomUUID().slice(0, 8).toUpperCase();
const sourceId = `full-${token}`;
const customerCode = `C${token.slice(0, 7)}`;
const articleReference = `ART-${token}`;
const planReference = `PLAN-${token}`;
const poNumber = `PO-${token}`;
const familyCode = "CUT";
const sourceHash = createHash("sha256").update(`full-native:${token}`).digest("hex");
const snapshotHash = createHash("sha256").update(`full-native-snapshot:${token}`).digest("hex");
let db: Pool;

const applicationInput = (previewHash: string) => ({
  expected_version: 1,
  expected_preview_hash: previewHash,
  confirm: true as const,
  checkpoint: {
    backup_reference: "verified-native-clone-fixture",
    scope_stopped: true as const,
    signoffs_complete: true as const,
    no_external_emissions: true as const,
  },
});

suite("full native cutover application PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Native cutover URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== "55471" || parsed.pathname !== "/cerp_cutover_native_1710") throw new Error("Refusing non-disposable native clone");
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_native_1710") throw new Error("Unexpected native clone identity");
    await db.query(readFileSync(repoPath("db", "patches", "20261020_01_data_cutover_preparation_1710.sql"), "utf8"));
    await db.query(readFileSync(repoPath("db", "patches", "20261020_04_data_cutover_application_1710.sql"), "utf8"));
    await db.query("INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING");
    await db.query("INSERT INTO public.users(id,username,password,name,surname,email,role) VALUES(1,'cutover-native','$2b$10$2b2xOYbkQN.mZSOEbttK8uF.4RF6W2Ah4D.yMY0J9ZwT4xteq1RQC','Cutover','Native','cutover-native@example.invalid','Administrateur Systeme et Reseau') ON CONFLICT(id) DO NOTHING");
    await db.query("INSERT INTO public.units(code,label) VALUES('U','Unité') ON CONFLICT(code) DO NOTHING");
    await db.query("INSERT INTO public.article_category_ref(code,label) VALUES('piece_finie_fabriquee','Pièce finie fabriquée') ON CONFLICT(code) DO NOTHING");
    await db.query("INSERT INTO public.articles_fabrique_families(code,designation) VALUES($1,'Famille cutover native') ON CONFLICT(code) DO NOTHING", [familyCode]);
  });
  afterAll(async () => { await db?.end(); });

  it("previews temporary dependencies but persists only real customer/PT/article IDs before the sales remainder", async () => {
    const rows = [
      { id: randomUUID(), domain: "CUSTOMER", legacy_key: `CUSTOMER:${customerCode}`, values: { customerCode, name: `Client ${token}`, resolution: "CREATE", country: "FR", address: "1 rue de la Reprise", postalCode: "69001", city: "Lyon", creationDate: "2026-10-20", deliverySameAsBilling: true } },
      { id: randomUUID(), domain: "TECHNICAL_PIECE", legacy_key: `PT:${planReference}`, values: { articleReference: planReference, customerCode, designation: `Pièce ${token}`, planReference, withoutRevision: true, technicalStatus: "DRAFT", resolution: "CREATE" } },
      { id: randomUUID(), domain: "ARTICLE", legacy_key: `ARTICLE:${articleReference}`, values: { articleReference, designation: `Article ${token}`, category: "fabrique", resolution: "CREATE", unit: "U", familyCode, lotTracked: false, technicalPieceLegacyKey: `PT:${planReference}`, commercialScope: "CLIENTS", commercialCustomerCode: customerCode } },
      { id: randomUUID(), domain: "SALES_ORDER", legacy_key: `SALES:${poNumber}:1`, values: { customerCode, customerOrderNumber: poNumber, affairNumber: "23907", articleReference, quantityOrdered: "100", quantityDelivered: "70", quantityRemaining: "30", unit: "U", unitPrice: "26.40", vatRate: "20", currency: "EUR", orderDate: "2026-10-20", plannedDueDate: "2026-11-03", priceEvidence: `AR-${token}`, orderType: "FERME", orderEvidence: `AR-${token}` } },
    ] as const;
    await db.query("INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by,status,version,validation,cutoff_at) VALUES($1::uuid,$2,'CLIPPER_EXCEL',$3,$4::jsonb,1,'VALIDATED',1,'{}'::jsonb,now())", [batchId, `Full native ${token}`, sourceHash, JSON.stringify([{ id: sourceId, name: "full-native.xlsx", sha256: snapshotHash, snapshot_at: "2026-10-20T08:00:00Z" }])]);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      await db.query("INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,\"values\",source_issues,source_notes,decision,review_note,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,'Full', $6,$7::jsonb,$7::jsonb,'[]'::jsonb,'[]'::jsonb,'INCLUDE','validated fixture',1)", [row.id, batchId, row.domain, row.legacy_key, sourceId, index + 2, JSON.stringify(row.values)]);
    }

    const service = createCutoverApplicationService([...cutoverReferenceAdapters, cutoverOrdersAdapter], db);
    const preview = await service.preview(batchId, 1, 1);
    expect(preview.operations).toHaveLength(4);
    expect(preview.blockers).toEqual([]);
    expect(preview.can_apply).toBe(true);

    const receipt = await service.apply(batchId, applicationInput(preview.preview_hash), 1, `full-native-${token}`, "full-native");
    expect(receipt.business_writes).toBe(true);
    expect(receipt.external_effects).toBe(false);
    expect(receipt.operations).toHaveLength(4);

    const links = await db.query<{ domain: string; target_id: string }>("SELECT domain,target_id FROM public.data_cutover_application_crosswalk WHERE batch_id=$1::uuid ORDER BY domain", [batchId]);
    expect(links.rows).toHaveLength(4);
    const targetId = (domain: string) => links.rows.find((row) => row.domain === domain)?.target_id;
    const created = await db.query<{ client_id: string; client_code: string; article_id: string; piece_id: string; order_id: string; qty: string; piece_client_id: string; piece_client_code: string }>(
      `SELECT c.client_id::text AS client_id,c.client_code,a.id::text AS article_id,p.id::text AS piece_id,co.id::text AS order_id,cl.quantite::text AS qty
              ,p.client_id::text AS piece_client_id,p.code_client AS piece_client_code
         FROM public.clients c
         JOIN public.pieces_techniques p ON p.client_id=c.client_id
         JOIN public.articles a ON a.piece_technique_id=p.id
         JOIN public.commande_client co ON co.client_id=c.client_id AND co.code_client=$2
         JOIN public.commande_ligne cl ON cl.commande_id=co.id AND cl.article_id=a.id
        WHERE c.client_id=$1 AND a.id=$3::uuid AND p.id=$4::uuid AND co.id=$5::bigint`, [targetId("CUSTOMER"), poNumber, targetId("ARTICLE"), targetId("TECHNICAL_PIECE"), targetId("SALES_ORDER")]);
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]?.qty).toBe("30.000");
    expect(created.rows[0]?.client_id).toBe(targetId("CUSTOMER"));
    expect(created.rows[0]?.article_id).not.toMatch(/^00000000-0000-4000-8000-000000000000$/);
    expect(created.rows[0]?.piece_id).not.toMatch(/^00000000-0000-4000-8000-000000000000$/);
    expect(created.rows[0]?.order_id).toBeTruthy();
    expect(created.rows[0]?.piece_client_id).toBe(created.rows[0]?.client_id);
    expect(created.rows[0]?.piece_client_code).toBe(created.rows[0]?.client_code);
    const orderId = created.rows[0]!.order_id;
    const noSideEffects: Array<{ sql: string; values: unknown[] }> = [
      { sql: "SELECT count(*)::int AS n FROM public.affaire WHERE commande_id=$1::bigint", values: [orderId] },
      { sql: "SELECT count(*)::int AS n FROM public.bon_livraison WHERE commande_id=$1::bigint", values: [orderId] },
      { sql: "SELECT count(*)::int AS n FROM public.ordres_fabrication WHERE commande_id=$1::bigint", values: [orderId] },
      { sql: "SELECT count(*)::int AS n FROM public.commande_ar_log WHERE commande_id=$1::bigint", values: [orderId] },
      { sql: "SELECT count(*)::int AS n FROM public.stock_movements WHERE source_document_type='COMMANDE_CLIENT' AND source_document_id=$1", values: [orderId] },
    ];
    for (const check of noSideEffects) expect((await db.query<{ n: number }>(check.sql, check.values)).rows[0]?.n).toBe(0);

    // Another legacy alias must not bypass the durable partner/PO claim made
    // after the newly created customer obtained its real native identifier.
    const duplicateBatch = randomUUID(), duplicateRow = randomUUID();
    await db.query("INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by,status,version,validation,cutoff_at) SELECT $1::uuid,'Alias duplicate fixture',source_system,$2,sources,created_by,'VALIDATED',1,'{}'::jsonb,now() FROM public.data_cutover_batches WHERE id=$3::uuid", [duplicateBatch, createHash('sha256').update(duplicateBatch).digest('hex'), batchId]);
    const duplicateValues = { ...rows[3].values, customerCode: `OTHER-${token}`, customerTargetId: targetId("CUSTOMER"), articleTargetId: targetId("ARTICLE") };
    await db.query("INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,\"values\",decision,review_note,updated_by) VALUES($1::uuid,$2::uuid,'SALES_ORDER',$3,$4,'Alias',2,$5::jsonb,$5::jsonb,'INCLUDE','validated fixture',1)", [duplicateRow, duplicateBatch, `ALIAS-SALES:${token}`, sourceId, JSON.stringify(duplicateValues)]);
    const duplicatePreview = await service.preview(duplicateBatch, 1, 1);
    expect(duplicatePreview.can_apply).toBe(false);
    expect(duplicatePreview.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CUTOVER_ORDER_GROUP_ALREADY_APPLIED" })]));
    await expect(service.apply(duplicateBatch, applicationInput(duplicatePreview.preview_hash), 1, `alias-duplicate-${token}`, "full-native")).rejects.toMatchObject({ code: "CUTOVER_APPLICATION_BLOCKED" });
    expect((await db.query("SELECT count(*)::int AS n FROM public.commande_client WHERE client_id=$1 AND code_client=$2", [targetId("CUSTOMER"), poNumber])).rows[0]?.n).toBe(1);
  });
});
