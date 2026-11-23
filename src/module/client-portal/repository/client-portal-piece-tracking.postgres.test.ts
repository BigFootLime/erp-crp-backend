import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pool from "../../../config/database";
import { repoTrackPortalPieces } from "./client-portal-piece-tracking.repository";

const dedicatedFixture = process.env.CERP_PORTAL_PIECE_TRACKING_POSTGRES === "1";
const account = "f95f5365-30fe-4c11-9fa2-85dbbb821111";
const allowed = "6b9baff9-2e01-4f88-9e71-4f11b2271111";
const otherSite = "6b9baff9-2e01-4f88-9e71-4f11b2272222";
const identity = { accountId: account, clientId: "T01", sessionEpoch: 0 };

// A dedicated PostgreSQL container models the order-line schema found in the
// restored common Test database. The usual E2E bootstrap provides both optional
// columns and would otherwise miss this regression.
describe.skipIf(!dedicatedFixture)("portal piece tracking on order-line schema variants", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/cerp_test");
    const { rows: [scope] } = await pool.query(
      "SELECT current_database() AS name, current_setting('cluster_name') AS cluster, " +
      "(SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS tables",
    );
    expect(scope).toEqual({ name: "cerp_test", cluster: "cerp_portal_piece_tracking_fixture", tables: 0 });

    await pool.query(`
      CREATE TABLE public.client_portal_orders_v(id text PRIMARY KEY, client_id varchar(3), statut text);
      CREATE TABLE public.commande_client(
        id bigint PRIMARY KEY, client_id varchar(3), numero text, code_client text,
        destinataire_id uuid, updated_at timestamptz, order_type text
      );
      CREATE TABLE public.client_portal_delivery_site_bindings(account_id uuid, delivery_address_id uuid);
      CREATE TABLE public.commande_ligne(
        id bigint PRIMARY KEY, commande_id bigint, code_piece text, designation text, unite text,
        quantite numeric, delai_client date
      );
      CREATE TABLE public.commande_ligne_affaire_allocation(id uuid, commande_ligne_id bigint, commande_id bigint);
      CREATE TABLE public.bon_livraison_ligne_allocations(
        commande_ligne_affaire_allocation_id uuid, bon_livraison_ligne_id uuid, quantite numeric
      );
      CREATE TABLE public.bon_livraison_ligne(id uuid, commande_ligne_id bigint, bon_livraison_id uuid, quantite numeric);
      CREATE TABLE public.bon_livraison(id uuid, client_id varchar(3), adresse_livraison_id uuid, statut text);
      CREATE TABLE public.ordres_fabrication(
        id bigint, commande_id bigint, commande_ligne_id bigint, client_id varchar(3), parent_of_id bigint,
        statut text, quantite_bonne numeric, quantite_lancee numeric, date_fin_prevue date
      );
      CREATE TABLE public.production_consolidation_allocations(source_of_id bigint, state text);
      CREATE TABLE public.delivery_promise_roots(id uuid, line_id bigint, commande_id bigint);
      CREATE TABLE public.delivery_promise_site_evidence(root_id uuid, delivery_address_id uuid);
      CREATE TABLE public.delivery_promise_parts(id uuid, root_id uuid, due_date date, quantity numeric, retired_at timestamptz);
      CREATE TABLE public.delivery_promise_shipments(part_id uuid, quantity numeric);
    `);
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO public.client_portal_delivery_site_bindings VALUES($1,$2)",
        [account, allowed],
      );
      await db.query(
        `INSERT INTO public.commande_client VALUES
           (1,'T01','T01-001','F-CLIENT',$1,'2026-11-20T12:00:00Z','FERME'),
           (2,'T01','T01-002','F-AUTRE-SITE',$2,'2026-11-21T12:00:00Z','FERME'),
           (3,'T02','T02-003','F-AUTRE-CLIENT',$1,'2026-11-22T12:00:00Z','FERME')`,
        [allowed, otherSite],
      );
      await db.query(`
        INSERT INTO public.client_portal_orders_v VALUES
          ('1','T01','EN_COURS'),('2','T01','EN_COURS'),('3','T02','EN_COURS');
        INSERT INTO public.commande_ligne VALUES
          (10,1,'P-001','Première pièce','u',5,CURRENT_DATE+10),
          (20,1,'P-002','Seconde pièce','u',8,CURRENT_DATE+14),
          (30,2,'P-002-SITE','Seconde pièce hors site','u',8,CURRENT_DATE+14),
          (40,3,'P-002-CLIENT','Seconde pièce autre client','u',8,CURRENT_DATE+14);
        INSERT INTO public.ordres_fabrication VALUES
          (100,1,20,'T01',NULL,'PLANIFIE',0,8,CURRENT_DATE+3);
      `);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  });

  afterAll(() => pool.end());

  it("supports lines without an explicit position or timestamp and keeps positions under search and pagination", async () => {
    const full = await repoTrackPortalPieces(identity, { q: "", page: 1, pageSize: 20 });
    expect(full.pagination.total).toBe(2);
    expect(full.data.map((line: { part_number: string; line_number: number }) => [line.part_number, line.line_number]))
      .toEqual([["P-002", 2], ["P-001", 1]]);
    expect(full.data[0]).toMatchObject({ stage: "PLANNED", ordered_quantity: "8", customer_order: "F-CLIENT" });
    expect(full.data[0].estimated_workshop_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const filtered = await repoTrackPortalPieces(identity, { q: "seconde", page: 1, pageSize: 20 });
    expect(filtered.pagination.total).toBe(1);
    expect(filtered.data).toEqual([expect.objectContaining({ part_number: "P-002", line_number: 2 })]);

    const next = await repoTrackPortalPieces(identity, { q: "", page: 2, pageSize: 1 });
    expect(next.pagination.total).toBe(2);
    expect(next.data).toEqual([expect.objectContaining({ part_number: "P-001", line_number: 1 })]);
  });

  it("preserves explicit line positions and timestamps when the schema supplies them", async () => {
    await pool.query(`
      ALTER TABLE public.commande_ligne ADD COLUMN ordre integer, ADD COLUMN updated_at timestamptz;
      UPDATE public.commande_ligne SET ordre = 70, updated_at = '2026-11-24T12:00:00Z' WHERE id=10;
    `);
    const full = await repoTrackPortalPieces(identity, { q: "", page: 1, pageSize: 20 });
    expect(full.data.map((line: { part_number: string; line_number: number }) => [line.part_number, line.line_number]))
      .toEqual([["P-001", 70], ["P-002", 2]]);
  });
});
