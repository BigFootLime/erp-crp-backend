import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { errorHandler } from "../middlewares/errorHandler";

const integrationUrl = process.env.SUBCONTRACT_WORK_PACKAGES_TEST_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;

const ids = {
  order: "11111111-1111-4111-8111-111111111111",
  line: "22222222-2222-4222-8222-222222222222",
  of: 101,
  operation: "44444444-4444-4444-8444-444444444444",
  sourceOperation: "55555555-5555-4555-8555-555555555555",
  evidence: "66666666-6666-4666-8666-666666666666",
  issueLot: "77777777-7777-4777-8777-777777777777",
  otherOrder: "88888888-8888-4888-8888-888888888888",
  otherLine: "99999999-9999-4999-8999-999999999999",
  otherOf: 202,
  otherOperation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherEvidence: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

suite("#626 subcontract work packages: PostgreSQL custody invariants", () => {
  let pool: import("pg").Pool;
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_URL = integrationUrl;
    const pg = await import("pg");
    const bootstrap = new pg.Client({ connectionString: integrationUrl });
    await bootstrap.connect();
    const database = await bootstrap.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) {
      throw new Error("SUBCONTRACT_WORK_PACKAGES_TEST_DATABASE_URL must target a test/local/sandbox database");
    }
    await bootstrap.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await bootstrap.query(`
      CREATE TABLE public.commande_fournisseur (id uuid PRIMARY KEY, statut text NOT NULL);
      CREATE TABLE public.commande_fournisseur_ligne (
        id uuid PRIMARY KEY, commande_id uuid NOT NULL REFERENCES public.commande_fournisseur(id), of_id integer NOT NULL,
        type text NOT NULL, statut_ligne text NOT NULL
      );
      CREATE TABLE public.pieces_techniques_operations (id uuid PRIMARY KEY, type_operation text NOT NULL);
      CREATE TABLE public.of_operations (id uuid PRIMARY KEY, of_id integer NOT NULL, source_piece_operation_id uuid REFERENCES public.pieces_techniques_operations(id));
      CREATE TABLE public.ged_documents (id uuid PRIMARY KEY, archived_at timestamptz);
      CREATE TABLE public.ged_document_links (document_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, link_role text NOT NULL, created_by integer);
      CREATE TABLE public.lots (id uuid PRIMARY KEY, lot_status text NOT NULL);
      CREATE TABLE public.erp_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id integer, action text, entity_type text, entity_id uuid, details jsonb);
    `);
    await bootstrap.query(await fs.readFile(path.resolve(process.cwd(), "db/patches/20260823_subcontract_work_packages_626.sql"), "utf8"));
    await bootstrap.end();

    const databaseModule = await import("../config/database");
    pool = databaseModule.default;
    const subcontractRouter = (await import("../module/subcontract/subcontract.routes")).default;
    app = express();
    app.use(express.json());
    // This is the real router mounted at its production prefix. The test identity
    // intentionally does not grant the account/module override, so its route RBAC
    // guard remains part of the exercised surface.
    app.use((req: any, _res, next) => { req.user = { id: 1, role: req.header("x-test-role") ?? "Production Achat" }; next(); });
    app.use("/api/v1/subcontract-work-packages", subcontractRouter);
    app.use(errorHandler);
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE public.subcontract_work_package_ledger, public.subcontract_work_packages, public.ged_document_links, public.erp_audit_logs, public.lots, public.ged_documents, public.of_operations, public.pieces_techniques_operations, public.commande_fournisseur_ligne, public.commande_fournisseur RESTART IDENTITY CASCADE`);
    await pool.query("INSERT INTO public.commande_fournisseur(id,statut) VALUES($1,'ENVOYEE')", [ids.order]);
    await pool.query("INSERT INTO public.commande_fournisseur_ligne(id,commande_id,of_id,type,statut_ligne) VALUES($1,$2,$3,'SOUS_TRAITANCE','ACTIVE')", [ids.line, ids.order, ids.of]);
    await pool.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES($1,'SOUS_TRAITANCE')", [ids.sourceOperation]);
    await pool.query("INSERT INTO public.of_operations(id,of_id,source_piece_operation_id) VALUES($1,$2,$3)", [ids.operation, ids.of, ids.sourceOperation]);
    await pool.query("INSERT INTO public.ged_documents(id) VALUES($1)", [ids.evidence]);
    await pool.query("INSERT INTO public.lots(id,lot_status) VALUES($1,'LIBERE')", [ids.issueLot]);
  });

  afterAll(async () => { await pool?.end(); });

  function createPackage() {
    return request(app).post("/api/v1/subcontract-work-packages").send({
      supplier_order_line_id: ids.line, of_operation_id: ids.operation, ged_evidence_document_id: ids.evidence, unit: "PCS", qty_planned: 10,
    });
  }

  it("enforces mounted-route RBAC, creates exactly the canonical package, and replays a ledger key", async () => {
    const denied = await createPackage().set("x-test-role", "Employee");
    expect(denied.status).toBe(403);

    const created = await createPackage();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ supplier_order_line_id: ids.line, of_operation_id: ids.operation, ged_evidence_document_id: ids.evidence, status: "SENT" });
    const packageId = created.body.id as string;
    expect((await pool.query("SELECT document_id,entity_type,entity_id FROM public.ged_document_links")).rows[0]).toMatchObject({ document_id: ids.evidence, entity_type: "SUBCONTRACT_WORK_PACKAGE", entity_id: packageId });

    const body = { lot_id: ids.issueLot, unit: "PCS", qty: 10 };
    const first = await request(app).post(`/api/v1/subcontract-work-packages/${packageId}/issues`).set("Idempotency-Key", "issue-proof-0001").send(body);
    const replay = await request(app).post(`/api/v1/subcontract-work-packages/${packageId}/issues`).set("Idempotency-Key", "issue-proof-0001").send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ledger_event_id: first.body.ledger_event_id, idempotent_replay: true });
    expect((await pool.query("SELECT count(*)::int AS count FROM public.subcontract_work_package_ledger")).rows[0].count).toBe(1);

    await pool.query("INSERT INTO public.commande_fournisseur(id,statut) VALUES($1,'ENVOYEE')", [ids.otherOrder]);
    await pool.query("INSERT INTO public.commande_fournisseur_ligne(id,commande_id,of_id,type,statut_ligne) VALUES($1,$2,$3,'SOUS_TRAITANCE','ACTIVE')", [ids.otherLine, ids.otherOrder, ids.otherOf]);
    await pool.query("INSERT INTO public.of_operations(id,of_id,source_piece_operation_id) VALUES($1,$2,$3)", [ids.otherOperation, ids.otherOf, ids.sourceOperation]);
    await pool.query("INSERT INTO public.ged_documents(id) VALUES($1)", [ids.otherEvidence]);
    const other = await request(app).post("/api/v1/subcontract-work-packages").send({ supplier_order_line_id: ids.otherLine, of_operation_id: ids.otherOperation, ged_evidence_document_id: ids.otherEvidence, unit: "PCS", qty_planned: 3 });
    expect(other.status).toBe(201);

    const missingFilter = await request(app).get("/api/v1/subcontract-work-packages");
    const invalidFilter = await request(app).get("/api/v1/subcontract-work-packages?of_id=0");
    expect(missingFilter.status).toBe(422);
    expect(invalidFilter.status).toBe(422);
    expect(missingFilter.body.code).toBe("SUBCONTRACT_OF_FILTER_REQUIRED");
    expect(invalidFilter.body.code).toBe("SUBCONTRACT_OF_FILTER_REQUIRED");
    const board = await request(app).get(`/api/v1/subcontract-work-packages?of_id=${ids.of}`);
    expect(board.status).toBe(200);
    expect(board.body).toMatchObject({ of_id: ids.of, work_packages: [expect.objectContaining({ id: packageId, ledger_event_count: 1 })] });
    expect(board.body.work_packages).toHaveLength(1);
    expect(Number(board.body.work_packages[0].issued_qty)).toBe(10);
    expect(Number(board.body.work_packages[0].returned_qty)).toBe(0);
    expect(Number(board.body.work_packages[0].custody_open_qty)).toBe(10);
    expect(board.body.work_packages[0].ledger).toHaveLength(1);
    expect(board.body.work_packages[0].ledger[0]).toMatchObject({ event_type: "ISSUE", lot_id: ids.issueLot, qty: 10, unit: "PCS" });
  });

  it("serializes two return sessions, prevents over-return, preserves an append-only ledger, and blocks finalisation while custody is open", async () => {
    const created = await createPackage();
    expect(created.status).toBe(201);
    const packageId = created.body.id as string;
    expect((await request(app).post(`/api/v1/subcontract-work-packages/${packageId}/issues`).set("Idempotency-Key", "issue-race-0001").send({ lot_id: ids.issueLot, unit: "PCS", qty: 10 })).status).toBe(201);
    await pool.query("UPDATE public.lots SET lot_status='QUARANTAINE' WHERE id=$1", [ids.issueLot]);

    const [left, right] = await Promise.all([
      request(app).post(`/api/v1/subcontract-work-packages/${packageId}/returns`).set("Idempotency-Key", "return-race-0001").send({ lot_id: ids.issueLot, unit: "PCS", qty: 6 }),
      request(app).post(`/api/v1/subcontract-work-packages/${packageId}/returns`).set("Idempotency-Key", "return-race-0002").send({ lot_id: ids.issueLot, unit: "PCS", qty: 6 }),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    expect([left.body.code, right.body.code]).toContain("SUBCONTRACT_OVER_RETURN");
    const ledger = await pool.query("SELECT event_type,qty FROM public.subcontract_work_package_ledger WHERE package_id=$1 ORDER BY created_at", [packageId]);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows.map((row) => [row.event_type, Number(row.qty)])).toEqual(expect.arrayContaining([["ISSUE", 10], ["RETURN", 6]]));

    const close = await request(app).post(`/api/v1/subcontract-work-packages/${packageId}/close`).send({ expected_row_version: 1, reason: "Should remain blocked" });
    expect(close.status).toBe(409);
    expect(close.body.code).toBe("SUBCONTRACT_CUSTODY_OPEN");
    await expect(pool.query("DELETE FROM public.subcontract_work_package_ledger WHERE package_id=$1", [packageId])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("UPDATE public.subcontract_work_package_ledger SET qty=1 WHERE package_id=$1", [packageId])).rejects.toMatchObject({ code: "55000" });
  });
});
