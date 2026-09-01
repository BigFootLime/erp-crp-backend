import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Opt-in PostgreSQL integration coverage for the state-changing stock flow.
 *
 * It deliberately refuses any URL other than a loopback database named
 * `cerp_stock_delivery_integration`, and requires DATABASE_URL to be the
 * same value.  That makes the destructive schema reset below safe for the
 * disposable PostgreSQL container used by the targeted test command.
 *
 * Without CERP_INTEGRATION_DATABASE_URL this suite is skipped; the regular
 * unit suite remains database-free by design.
 */

type ReceiptRepository = typeof import("../module/production/repository/production-receipts.repository");
type DeliveryRepository = typeof import("../module/livraisons/repository/livraisons.repository");
type CommandeRepository = typeof import("../module/commande-client/repository/commande-client.repository");

const integrationDatabaseUrl = process.env.CERP_INTEGRATION_DATABASE_URL;
const describePg = integrationDatabaseUrl ? describe : describe.skip;

const ids = {
  article: "10000000-0000-4000-8000-000000000001",
  pieceTechnique: "10000000-0000-4000-8000-000000000002",
  location: "10000000-0000-4000-8000-000000000003",
  warehouse: "10000000-0000-4000-8000-000000000004",
  unit: "10000000-0000-4000-8000-000000000005",
  magasin: "10000000-0000-4000-8000-000000000006",
  client: "10000000-0000-4000-8000-000000000007",
  stockLevel: "10000000-0000-4000-8000-000000000008",
  lot: "10000000-0000-4000-8000-000000000009",
  stockBatch: "10000000-0000-4000-8000-000000000010",
  reservation: "10000000-0000-4000-8000-000000000011",
  deliveryAddress: "10000000-0000-4000-8000-000000000012",
  otherClient: "10000000-0000-4000-8000-000000000013",
  otherDeliveryAddress: "10000000-0000-4000-8000-000000000014",
  secondReservation: "10000000-0000-4000-8000-000000000015",
} as const;

let harnessPool: Pool | null = null;
let applicationPool: Pool | null = null;
let receiptRepository: ReceiptRepository;
let deliveryRepository: DeliveryRepository;
let commandeRepository: CommandeRepository;

function requireSafeIntegrationDatabase() {
  if (!integrationDatabaseUrl) throw new Error("CERP_INTEGRATION_DATABASE_URL is required for this suite");
  if (process.env.DATABASE_URL !== integrationDatabaseUrl) {
    throw new Error("DATABASE_URL must exactly match CERP_INTEGRATION_DATABASE_URL for this isolated suite");
  }

  const url = new URL(integrationDatabaseUrl);
  if (!(["127.0.0.1", "localhost"] as string[]).includes(url.hostname)) {
    throw new Error("The stock/delivery integration suite only accepts a loopback PostgreSQL host");
  }
  if (url.pathname !== "/cerp_stock_delivery_integration") {
    throw new Error("The stock/delivery integration suite only accepts database cerp_stock_delivery_integration");
  }
}

async function installMinimalSchema(db: Pool) {
  // The repositories use public-qualified tables.  This is an empty,
  // disposable database guarded by requireSafeIntegrationDatabase(), not an
  // application migration runner.  The schema keeps only the concrete SQL
  // dependencies of the three commands under test.
  await db.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE TYPE public.movement_type AS ENUM (
      'IN', 'OUT', 'RESERVE', 'UNRESERVE', 'DEPRECIATE', 'SCRAP', 'ADJUST', 'ADJUSTMENT', 'TRANSFER'
    );

    CREATE SEQUENCE public.stock_movement_no_seq START WITH 1;
    CREATE SEQUENCE public.bon_livraison_no_seq START WITH 1;

    CREATE TABLE public.issued_code_counters (
      code_key TEXT PRIMARY KEY,
      value BIGINT NOT NULL
    );
    CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_key TEXT)
    RETURNS BIGINT
    LANGUAGE plpgsql
    AS $function$
    DECLARE next_value BIGINT;
    BEGIN
      INSERT INTO public.issued_code_counters (code_key, value)
      VALUES (p_key, 1)
      ON CONFLICT (code_key) DO UPDATE SET value = public.issued_code_counters.value + 1
      RETURNING value INTO next_value;
      RETURN next_value;
    END;
    $function$;

    CREATE TABLE public.units (
      id UUID PRIMARY KEY,
      code CITEXT NOT NULL UNIQUE,
      label TEXT NULL
    );
    CREATE TABLE public.articles (
      id UUID PRIMARY KEY,
      piece_technique_id UUID NULL,
      article_type TEXT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      unite TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.locations (
      id UUID PRIMARY KEY,
      warehouse_id UUID NOT NULL
    );
    CREATE TABLE public.magasins (
      id UUID PRIMARY KEY,
      code TEXT NULL,
      code_magasin TEXT NULL,
      name TEXT NULL,
      libelle TEXT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE public.emplacements (
      id BIGINT PRIMARY KEY,
      magasin_id UUID NOT NULL,
      location_id UUID NOT NULL,
      code TEXT NOT NULL,
      name TEXT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE public.lots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id UUID NOT NULL,
      lot_code TEXT NOT NULL,
      lot_status TEXT NULL DEFAULT 'LIBERE',
      source_scope TEXT NULL DEFAULT 'NEW',
      received_at DATE NULL,
      manufactured_at DATE NULL,
      mp_reference TEXT NULL,
      tr_reference TEXT NULL,
      notes TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      UNIQUE (article_id, lot_code)
    );
    CREATE TABLE public.stock_levels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id UUID NOT NULL,
      unit_id UUID NOT NULL,
      warehouse_id UUID NOT NULL,
      location_id UUID NOT NULL,
      managed_in_stock BOOLEAN NOT NULL DEFAULT true,
      qty_total NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_reserved NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_depreciated NUMERIC(18,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      UNIQUE (article_id, location_id)
    );
    CREATE TABLE public.stock_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_level_id UUID NOT NULL,
      batch_code TEXT NOT NULL,
      qty_total NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_reserved NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_depreciated NUMERIC(18,3) NOT NULL DEFAULT 0,
      UNIQUE (stock_level_id, batch_code)
    );
    CREATE TABLE public.stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_no TEXT NOT NULL,
      movement_type public.movement_type NOT NULL,
      status TEXT NOT NULL,
      article_id UUID NOT NULL,
      stock_level_id UUID NOT NULL,
      stock_batch_id UUID NULL,
      qty NUMERIC(18,3) NOT NULL,
      currency TEXT NULL,
      effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_document_type TEXT NULL,
      source_document_id TEXT NULL,
      reason_code TEXT NULL,
      notes TEXT NULL,
      idempotency_key TEXT NULL,
      user_id INTEGER NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      posted_at TIMESTAMPTZ NULL,
      posted_by INTEGER NULL,
      created_by INTEGER NULL,
      updated_by INTEGER NULL
    );
    CREATE TABLE public.stock_movement_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_id UUID NOT NULL,
      line_no INTEGER NOT NULL,
      article_id UUID NOT NULL,
      lot_id UUID NULL,
      qty NUMERIC(18,3) NOT NULL,
      unite TEXT NULL,
      src_magasin_id UUID NULL,
      src_emplacement_id BIGINT NULL,
      dst_magasin_id UUID NULL,
      dst_emplacement_id BIGINT NULL,
      note TEXT NULL,
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      UNIQUE (movement_id, line_no)
    );
    CREATE TABLE public.stock_movement_event_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_movement_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      old_values JSONB NULL,
      new_values JSONB NULL,
      user_id INTEGER NULL,
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION public.fn_apply_stock_movement()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'POSTED' THEN RETURN NEW; END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.status IS DISTINCT FROM 'POSTED' OR OLD.status = 'POSTED' THEN RETURN NEW; END IF;
      END IF;

      IF NEW.movement_type = 'IN' THEN
        UPDATE public.stock_levels SET qty_total = qty_total + NEW.qty, updated_at = now() WHERE id = NEW.stock_level_id;
        IF NEW.stock_batch_id IS NOT NULL THEN
          UPDATE public.stock_batches SET qty_total = qty_total + NEW.qty WHERE id = NEW.stock_batch_id;
        END IF;
      ELSIF NEW.movement_type = 'OUT' THEN
        UPDATE public.stock_levels SET qty_total = qty_total - NEW.qty, updated_at = now() WHERE id = NEW.stock_level_id;
        IF NEW.stock_batch_id IS NOT NULL THEN
          UPDATE public.stock_batches SET qty_total = qty_total - NEW.qty WHERE id = NEW.stock_batch_id;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $function$;
    CREATE TRIGGER trg_apply_stock_movement
    AFTER INSERT OR UPDATE OF status ON public.stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.fn_apply_stock_movement();

    CREATE TABLE public.clients (
      client_id UUID PRIMARY KEY,
      company_name TEXT NOT NULL,
      delivery_address_id UUID NULL
    );
    CREATE TABLE public.commande_client (
      id BIGINT PRIMARY KEY,
      numero TEXT NOT NULL,
      client_id UUID NOT NULL,
      destinataire_id UUID NULL
    );
    CREATE TABLE public.commande_ligne (
      id BIGINT PRIMARY KEY,
      designation TEXT NOT NULL,
      code_piece TEXT NULL,
      unite TEXT NULL,
      delai_client TEXT NULL
    );
    CREATE TABLE public.commande_ligne_affaire_allocation (
      id BIGINT PRIMARY KEY,
      commande_id BIGINT NOT NULL,
      commande_ligne_id BIGINT NOT NULL,
      livraison_affaire_id BIGINT NOT NULL,
      article_ref_id UUID NOT NULL,
      qty_ordered NUMERIC(18,3) NOT NULL,
      qty_reserved NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_delivered NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_remaining NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_from_stock NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_produced NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_stocked NUMERIC(18,3) NOT NULL DEFAULT 0,
      delivery_status TEXT NOT NULL DEFAULT 'A_PREPARER',
      allocation_version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.stock_reservations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id UUID NOT NULL,
      location_id UUID NOT NULL,
      qty_reserved NUMERIC(18,3) NOT NULL,
      qty_consumed NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_prepared NUMERIC(18,3) NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL,
      commande_ligne_affaire_allocation_id BIGINT NULL,
      livraison_affaire_id BIGINT NULL,
      lot_id UUID NULL,
      stock_level_id UUID NULL,
      stock_batch_id UUID NULL,
      of_id BIGINT NULL,
      source_scope TEXT NULL DEFAULT 'NEW',
      version INTEGER NOT NULL DEFAULT 1,
      consumed_at TIMESTAMPTZ NULL,
      released_at TIMESTAMPTZ NULL,
      release_reason TEXT NULL,
      idempotency_key TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      CHECK (qty_consumed >= 0 AND qty_prepared >= 0 AND qty_consumed + qty_prepared <= qty_reserved)
    );
    CREATE UNIQUE INDEX stock_reservation_active_allocation_batch_uniq
      ON public.stock_reservations (commande_ligne_affaire_allocation_id, stock_batch_id)
      WHERE status = 'ACTIVE' AND commande_ligne_affaire_allocation_id IS NOT NULL AND stock_batch_id IS NOT NULL;
    CREATE TABLE public.stock_reservation_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reservation_id UUID NOT NULL,
      verified_qty NUMERIC(18,3) NOT NULL,
      scanned_lot_code TEXT NOT NULL,
      snapshot JSONB NOT NULL,
      verified_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.stock_reservation_corrections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reservation_id UUID NOT NULL,
      actor_user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      old_snapshot JSONB NOT NULL,
      new_snapshot JSONB NOT NULL,
      stock_movement_id UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE public.ordres_fabrication (
      id BIGINT PRIMARY KEY,
      numero TEXT NOT NULL,
      piece_technique_id UUID NOT NULL,
      article_id UUID NULL,
      commande_ligne_id BIGINT NULL,
      affaire_id BIGINT NULL,
      quantite_bonne NUMERIC(18,3) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by INTEGER NULL
    );
    CREATE TABLE public.of_output_lots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      of_id BIGINT NOT NULL,
      lot_id UUID NOT NULL,
      qty_ok NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_scrap NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_rework NUMERIC(18,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      UNIQUE (of_id, lot_id)
    );
    CREATE TABLE public.of_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      of_id BIGINT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      expected_of_updated_at TIMESTAMPTZ NOT NULL,
      request_payload JSONB NOT NULL,
      result_payload JSONB NULL,
      lot_id UUID NULL,
      stock_movement_id UUID NULL,
      reservation_id UUID NULL,
      qty_ok NUMERIC(18,3) NOT NULL,
      qty_scrap NUMERIC(18,3) NOT NULL DEFAULT 0,
      qty_rework NUMERIC(18,3) NOT NULL DEFAULT 0,
      quality_status TEXT NOT NULL DEFAULT 'LIBERE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (actor_user_id, idempotency_key)
    );

    CREATE TABLE public.bon_livraison (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      numero TEXT NOT NULL,
      client_id UUID NOT NULL,
      commande_id BIGINT NULL,
      affaire_id BIGINT NULL,
      adresse_livraison_id UUID NULL,
      statut TEXT NOT NULL,
      date_creation DATE NOT NULL DEFAULT CURRENT_DATE,
      date_expedition DATE NULL,
      commentaire_interne TEXT NULL,
      shipping_version INTEGER NOT NULL DEFAULT 1,
      shipping_preview_hash TEXT NULL,
      shipped_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER NULL,
      updated_by INTEGER NULL
    );
    CREATE TABLE public.bon_livraison_ligne (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bon_livraison_id UUID NOT NULL,
      ordre INTEGER NOT NULL,
      designation TEXT NOT NULL,
      code_piece TEXT NULL,
      quantite NUMERIC(18,3) NOT NULL,
      unite TEXT NULL,
      commande_ligne_id BIGINT NULL,
      delai_client TEXT NULL,
      created_by INTEGER NULL,
      updated_by INTEGER NULL
    );
    CREATE TABLE public.bon_livraison_ligne_allocations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bon_livraison_ligne_id UUID NOT NULL,
      article_id UUID NOT NULL,
      lot_id UUID NULL,
      quantite NUMERIC(18,3) NOT NULL,
      unite TEXT NULL,
      reservation_id UUID NULL,
      magasin_id UUID NULL,
      emplacement_id BIGINT NULL,
      location_id UUID NULL,
      stock_level_id UUID NULL,
      stock_batch_id UUID NULL,
      commande_ligne_affaire_allocation_id BIGINT NULL,
      verified_at TIMESTAMPTZ NULL,
      verified_by INTEGER NULL,
      verification_snapshot JSONB NULL,
      qty_consumed NUMERIC(18,3) NOT NULL DEFAULT 0,
      stock_movement_line_id UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      CHECK (qty_consumed >= 0 AND qty_consumed <= quantite)
    );
    CREATE TABLE public.bon_livraison_event_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bon_livraison_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      old_values JSONB NULL,
      new_values JSONB NULL,
      user_id INTEGER NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.bon_livraison_pack_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bon_livraison_id UUID NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE public.bon_livraison_prepare_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      bon_livraison_id UUID NULL,
      result_payload JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (actor_user_id, idempotency_key)
    );
    CREATE TABLE public.bon_livraison_ship_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bon_livraison_id UUID NOT NULL,
      actor_user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      expected_shipping_version INTEGER NOT NULL,
      preview_hash TEXT NOT NULL,
      result_payload JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (actor_user_id, idempotency_key)
    );
    CREATE TABLE public.delivery_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      UNIQUE (event_type, aggregate_id)
    );
    CREATE TABLE public.erp_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      action TEXT NOT NULL,
      page_key TEXT NULL,
      entity_type TEXT NULL,
      entity_id TEXT NULL,
      path TEXT NULL,
      client_session_id UUID NULL,
      ip TEXT NULL,
      user_agent TEXT NULL,
      device_type TEXT NULL,
      os TEXT NULL,
      browser TEXT NULL,
      details JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.realtime_stream_enqueue_state (
      stream_id TEXT PRIMARY KEY,
      next_ordinal BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.erp_outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_key TEXT NOT NULL UNIQUE,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      correlation_id UUID NOT NULL,
      status TEXT NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      realtime_stream_id TEXT NULL,
      realtime_stream_ordinal BIGINT NULL
    );
  `);
}

async function clearScenario(db: Pool) {
  await db.query(`
    TRUNCATE TABLE
      public.erp_outbox_events,
      public.realtime_stream_enqueue_state,
      public.erp_audit_logs,
      public.delivery_outbox,
      public.bon_livraison_ship_receipts,
      public.bon_livraison_prepare_receipts,
      public.bon_livraison_pack_versions,
      public.bon_livraison_event_log,
      public.bon_livraison_ligne_allocations,
      public.bon_livraison_ligne,
      public.bon_livraison,
      public.of_receipts,
      public.of_output_lots,
      public.ordres_fabrication,
      public.stock_reservation_corrections,
      public.stock_reservation_verifications,
      public.stock_reservations,
      public.commande_ligne_affaire_allocation,
      public.commande_ligne,
      public.commande_client,
      public.clients,
      public.stock_movement_event_log,
      public.stock_movement_lines,
      public.stock_movements,
      public.stock_batches,
      public.stock_levels,
      public.lots,
      public.emplacements,
      public.magasins,
      public.locations,
      public.articles,
      public.units,
      public.issued_code_counters
    RESTART IDENTITY;
    ALTER SEQUENCE public.stock_movement_no_seq RESTART WITH 1;
    ALTER SEQUENCE public.bon_livraison_no_seq RESTART WITH 1;
  `);
}

async function seedCommonLocation(db: Pool) {
  await db.query(`INSERT INTO public.units (id, code, label) VALUES ($1::uuid, 'u', 'Unité')`, [ids.unit]);
  await db.query(`INSERT INTO public.locations (id, warehouse_id) VALUES ($1::uuid, $2::uuid)`, [ids.location, ids.warehouse]);
  await db.query(
    `INSERT INTO public.magasins (id, code, name, is_active) VALUES ($1::uuid, 'MAIN', 'Magasin principal', true)`,
    [ids.magasin]
  );
  await db.query(
    `INSERT INTO public.emplacements (id, magasin_id, location_id, code, name, is_active)
     VALUES (1, $1::uuid, $2::uuid, 'A-01', 'Emplacement test', true)`,
    [ids.magasin, ids.location]
  );
}

async function seedReceiptScenario(db: Pool): Promise<{ expectedOfUpdatedAt: string }> {
  await seedCommonLocation(db);
  await db.query(
    `INSERT INTO public.articles (id, piece_technique_id, article_type, is_active, unite)
     VALUES ($1::uuid, $2::uuid, 'PIECE_TECHNIQUE', true, 'u')`,
    [ids.article, ids.pieceTechnique]
  );
  await db.query(
    `INSERT INTO public.commande_ligne_affaire_allocation (
       id, commande_id, commande_ligne_id, livraison_affaire_id, article_ref_id,
       qty_ordered, qty_reserved, qty_delivered, qty_remaining
     ) VALUES (900, 42, 43, 700, $1::uuid, 10, 0, 0, 10)`,
    [ids.article]
  );
  await db.query(
    `INSERT INTO public.ordres_fabrication (
       id, numero, piece_technique_id, article_id, commande_ligne_id, affaire_id, quantite_bonne
     ) VALUES (101, 'OF-INT-101', $1::uuid, $2::uuid, 43, 700, 12)`,
    [ids.pieceTechnique, ids.article]
  );
  const of = await db.query<{ updated_at: string }>(
    `SELECT updated_at::text AS updated_at FROM public.ordres_fabrication WHERE id = 101`
  );
  const expectedOfUpdatedAt = of.rows[0]?.updated_at;
  if (!expectedOfUpdatedAt) throw new Error("Missing seeded OF timestamp");
  return { expectedOfUpdatedAt };
}

async function seedDeliveryScenario(db: Pool) {
  await seedCommonLocation(db);
  await db.query(
    `INSERT INTO public.articles (id, piece_technique_id, article_type, is_active, unite)
     VALUES ($1::uuid, $2::uuid, 'PIECE_TECHNIQUE', true, 'u')`,
    [ids.article, ids.pieceTechnique]
  );
  await db.query(
    `INSERT INTO public.clients (client_id, company_name, delivery_address_id)
     VALUES ($1::uuid, 'Client intégration', $2::uuid), ($3::uuid, 'Autre client', $4::uuid)`,
    [ids.client, ids.deliveryAddress, ids.otherClient, ids.otherDeliveryAddress]
  );
  await db.query(
    `INSERT INTO public.commande_client (id, numero, client_id, destinataire_id)
     VALUES (42, 'CMD-INT-0042', $1::uuid, $2::uuid)`,
    [ids.client, ids.deliveryAddress]
  );
  await db.query(
    `INSERT INTO public.commande_ligne (id, designation, code_piece, unite, delai_client)
     VALUES (43, 'Pièce intégration', 'PT-INT', 'u', '2026-09-01')`
  );
  await db.query(
    `INSERT INTO public.commande_ligne_affaire_allocation (
       id, commande_id, commande_ligne_id, livraison_affaire_id, article_ref_id,
       qty_ordered, qty_reserved, qty_delivered, qty_remaining, delivery_status
     ) VALUES (900, 42, 43, 700, $1::uuid, 10, 10, 0, 10, 'A_PREPARER')`,
    [ids.article]
  );
  await db.query(
    `INSERT INTO public.lots (id, article_id, lot_code, lot_status, source_scope)
     VALUES ($1::uuid, $2::uuid, 'LOT-INT-001', 'LIBERE', 'NEW')`,
    [ids.lot, ids.article]
  );
  await db.query(
    `INSERT INTO public.stock_levels (
       id, article_id, unit_id, warehouse_id, location_id, qty_total, qty_reserved, created_by, updated_by
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 10, 10, 7, 7)`,
    [ids.stockLevel, ids.article, ids.unit, ids.warehouse, ids.location]
  );
  await db.query(
    `INSERT INTO public.stock_batches (id, stock_level_id, batch_code, qty_total, qty_reserved)
     VALUES ($1::uuid, $2::uuid, 'LOT-INT-001', 10, 10)`,
    [ids.stockBatch, ids.stockLevel]
  );
  await db.query(
    `INSERT INTO public.stock_reservations (
       id, article_id, location_id, qty_reserved, source_type, source_id, status,
       commande_ligne_affaire_allocation_id, livraison_affaire_id, lot_id,
       stock_level_id, stock_batch_id, source_scope, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 10, 'COMMANDE_LIGNE', '43', 'ACTIVE',
       900, 700, $4::uuid, $5::uuid, $6::uuid, 'NEW', 7, 7
     )`,
    [ids.reservation, ids.article, ids.location, ids.lot, ids.stockLevel, ids.stockBatch]
  );
  await db.query(
    `INSERT INTO public.stock_reservation_verifications (
       reservation_id, verified_qty, scanned_lot_code, snapshot, verified_by
     ) VALUES ($1::uuid, 5, 'LOT-INT-001', $2::jsonb, 7)`,
    [ids.reservation, JSON.stringify({ verified_qty: 5, lot_code: "LOT-INT-001", source_scope: "NEW" })]
  );
}

async function seedAdditionalDeliveryReservation(
  db: Pool,
  params: { clientId?: string; deliveryAddressId?: string | null } = {}
) {
  const clientId = params.clientId ?? ids.client;
  const deliveryAddressId = params.deliveryAddressId === undefined ? ids.deliveryAddress : params.deliveryAddressId;
  await db.query(
    `INSERT INTO public.commande_client (id, numero, client_id, destinataire_id)
     VALUES (44, 'CMD-INT-0044', $1::uuid, $2::uuid)`,
    [clientId, deliveryAddressId]
  );
  await db.query(
    `INSERT INTO public.commande_ligne (id, designation, code_piece, unite, delai_client)
     VALUES (45, 'Seconde pièce intégration', 'PT-INT-2', 'u', '2026-09-02')`
  );
  await db.query(
    `INSERT INTO public.commande_ligne_affaire_allocation (
       id, commande_id, commande_ligne_id, livraison_affaire_id, article_ref_id,
       qty_ordered, qty_reserved, qty_delivered, qty_remaining, delivery_status
     ) VALUES (901, 44, 45, 701, $1::uuid, 4, 4, 0, 4, 'A_PREPARER')`,
    [ids.article]
  );
  await db.query(
    `INSERT INTO public.stock_reservations (
       id, article_id, location_id, qty_reserved, source_type, source_id, status,
       commande_ligne_affaire_allocation_id, livraison_affaire_id, lot_id,
       stock_level_id, stock_batch_id, source_scope, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 4, 'COMMANDE_LIGNE', '45', 'ACTIVE',
       901, 701, $4::uuid, $5::uuid, $6::uuid, 'NEW', 7, 7
     )`,
    [ids.secondReservation, ids.article, ids.location, ids.lot, ids.stockLevel, ids.stockBatch]
  );
  await db.query(
    `INSERT INTO public.stock_reservation_verifications (
       reservation_id, verified_qty, scanned_lot_code, snapshot, verified_by
     ) VALUES ($1::uuid, 4, 'LOT-INT-001', $2::jsonb, 7)`,
    [ids.secondReservation, JSON.stringify({ verified_qty: 4, lot_code: "LOT-INT-001", source_scope: "NEW" })]
  );
}

function countValue(row: { count: string } | undefined): number {
  return Number(row?.count ?? 0);
}

describePg("stock/delivery repositories — isolated PostgreSQL invariants", () => {
  beforeAll(async () => {
    requireSafeIntegrationDatabase();
    harnessPool = new Pool({ connectionString: integrationDatabaseUrl });
    await installMinimalSchema(harnessPool);

    // Import only after the safety check so the production singleton pool is
    // bound to this disposable test database, never a developer's .env URL.
    const databaseModule = await import("../config/database");
    applicationPool = databaseModule.default;
    receiptRepository = await import("../module/production/repository/production-receipts.repository");
    deliveryRepository = await import("../module/livraisons/repository/livraisons.repository");
    commandeRepository = await import("../module/commande-client/repository/commande-client.repository");
  });

  beforeEach(async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await clearScenario(harnessPool);
  });

  it("serializes a duplicate OF receipt and reserves only the still-needed quantity", async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    const { expectedOfUpdatedAt } = await seedReceiptScenario(harnessPool);
    const body = {
      article_id: ids.article,
      qty_ok: 12,
      qty_scrap: 0.5,
      qty_rework: 1,
      unite: "u",
      location_id: ids.location,
      lot_mode: "NEW" as const,
      expected_of_updated_at: expectedOfUpdatedAt,
      quality_status: "LIBERE" as const,
      commentaire: "Réception intégration",
    };
    const audit = {
      user_id: 7,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      path: "/integration/of-receipt",
      page_key: "production",
      client_session_id: null,
    };

    const [first, replay] = await Promise.all([
      receiptRepository.repoCreateOfReceipt({
        of_id: 101,
        body,
        audit,
        idempotency_key: "of-receipt-idempotency-001",
        quality_decision_allowed: true,
      }),
      receiptRepository.repoCreateOfReceipt({
        of_id: 101,
        body,
        audit,
        idempotency_key: "of-receipt-idempotency-001",
        quality_decision_allowed: true,
      }),
    ]);

    const results = [first, replay];
    expect(results.filter((result) => !result.idempotent_replay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotent_replay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.stock_movement_id))).toHaveLength(1);
    expect(new Set(results.map((result) => result.lot_id))).toHaveLength(1);
    expect(results.every((result) => result.qty_scrap === 0.5 && result.qty_rework === 1)).toBe(true);
    expect(results.every((result) => result.auto_reserved_qty === 10 && result.available_qty === 2)).toBe(true);

    const receiptCount = await harnessPool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.of_receipts`);
    const movementCount = await harnessPool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.stock_movements`);
    const output = await harnessPool.query<{ qty_ok: number; qty_scrap: number; qty_rework: number }>(
      `SELECT qty_ok::float8 AS qty_ok, qty_scrap::float8 AS qty_scrap, qty_rework::float8 AS qty_rework
       FROM public.of_output_lots WHERE of_id = 101`
    );
    const reservation = await harnessPool.query<{ qty_reserved: number; qty_consumed: number; qty_prepared: number }>(
      `SELECT qty_reserved::float8 AS qty_reserved, qty_consumed::float8 AS qty_consumed, qty_prepared::float8 AS qty_prepared
       FROM public.stock_reservations`
    );
    const allocation = await harnessPool.query<{ qty_reserved: number; qty_from_stock: number; qty_produced: number; qty_stocked: number }>(
      `SELECT qty_reserved::float8 AS qty_reserved, qty_from_stock::float8 AS qty_from_stock,
              qty_produced::float8 AS qty_produced, qty_stocked::float8 AS qty_stocked
       FROM public.commande_ligne_affaire_allocation WHERE id = 900`
    );
    const stock = await harnessPool.query<{ total: number; reserved: number }>(
      `SELECT qty_total::float8 AS total, qty_reserved::float8 AS reserved FROM public.stock_levels`
    );

    expect(countValue(receiptCount.rows[0])).toBe(1);
    expect(countValue(movementCount.rows[0])).toBe(1);
    expect(output.rows).toEqual([{ qty_ok: 12, qty_scrap: 0.5, qty_rework: 1 }]);
    expect(reservation.rows).toEqual([{ qty_reserved: 10, qty_consumed: 0, qty_prepared: 0 }]);
    expect(allocation.rows).toEqual([{ qty_reserved: 10, qty_from_stock: 10, qty_produced: 12, qty_stocked: 12 }]);
    expect(stock.rows).toEqual([{ total: 12, reserved: 10 }]);
  });

  it("reserves full OLD, split OLD/NEW, partial and empty stock in deterministic FIFO order", async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await seedCommonLocation(harnessPool);

    const articleOld = "20000000-0000-4000-8000-000000000001";
    const articleSplit = "20000000-0000-4000-8000-000000000002";
    const articlePartial = "20000000-0000-4000-8000-000000000003";
    const articleEmpty = "20000000-0000-4000-8000-000000000004";
    const articleIds = [articleOld, articleSplit, articlePartial, articleEmpty];
    for (const articleId of articleIds) {
      await harnessPool.query(
        `INSERT INTO public.articles (id, article_type, is_active, unite) VALUES ($1::uuid, 'PIECE_TECHNIQUE', true, 'u')`,
        [articleId]
      );
    }

    const stockFixtures = [
      {
        articleId: articleOld,
        levelId: "21000000-0000-4000-8000-000000000001",
        lots: [
          ["22000000-0000-4000-8000-000000000001", "LOT-OLD-ONLY", "OLD", "2026-01-01", 4],
        ],
      },
      {
        articleId: articleSplit,
        levelId: "21000000-0000-4000-8000-000000000002",
        lots: [
          ["22000000-0000-4000-8000-000000000002", "LOT-OLD-FIRST", "OLD", "2026-01-01", 3],
          ["22000000-0000-4000-8000-000000000003", "LOT-OLD-SECOND", "OLD", "2026-02-01", 2],
          ["22000000-0000-4000-8000-000000000004", "LOT-NEW-EARLY", "NEW", "2025-01-01", 10],
        ],
      },
      {
        articleId: articlePartial,
        levelId: "21000000-0000-4000-8000-000000000003",
        lots: [
          ["22000000-0000-4000-8000-000000000005", "LOT-PARTIAL-OLD", "OLD", "2026-01-01", 3],
          ["22000000-0000-4000-8000-000000000006", "LOT-PARTIAL-NEW", "NEW", "2026-01-01", 5],
        ],
      },
    ] as const;

    for (const fixture of stockFixtures) {
      const total = fixture.lots.reduce((sum, lot) => sum + Number(lot[4]), 0);
      await harnessPool.query(
        `INSERT INTO public.stock_levels (
           id, article_id, unit_id, warehouse_id, location_id, qty_total, qty_reserved, created_by, updated_by
         ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,0,7,7)`,
        [fixture.levelId, fixture.articleId, ids.unit, ids.warehouse, ids.location, total]
      );
      for (const [lotId, lotCode, scope, receivedAt, qty] of fixture.lots) {
        await harnessPool.query(
          `INSERT INTO public.lots (id, article_id, lot_code, lot_status, source_scope, received_at)
           VALUES ($1::uuid,$2::uuid,$3,'LIBERE',$4,$5::date)`,
          [lotId, fixture.articleId, lotCode, scope, receivedAt]
        );
        await harnessPool.query(
          `INSERT INTO public.stock_batches (id, stock_level_id, batch_code, qty_total, qty_reserved)
           VALUES (gen_random_uuid(),$1::uuid,$2,$3,0)`,
          [fixture.levelId, lotCode, qty]
        );
      }
    }

    const targets = [
      { allocation_id: 900, commande_ligne_id: 40, livraison_affaire_id: 700, article_id: articleOld, requested_qty: 4 },
      { allocation_id: 901, commande_ligne_id: 41, livraison_affaire_id: 700, article_id: articleSplit, requested_qty: 7 },
      { allocation_id: 902, commande_ligne_id: 42, livraison_affaire_id: 700, article_id: articlePartial, requested_qty: 10 },
      { allocation_id: 903, commande_ligne_id: 43, livraison_affaire_id: 700, article_id: articleEmpty, requested_qty: 4 },
    ];

    const reservationClient = await harnessPool.connect();
    let reservations: Awaited<ReturnType<typeof commandeRepository.repoReserveCommandeLots>>;
    try {
      await reservationClient.query("BEGIN");
      reservations = await commandeRepository.repoReserveCommandeLots(reservationClient, {
        location_id: ids.location,
        actor_user_id: 7,
        targets,
      });
      await reservationClient.query("COMMIT");
    } catch (error) {
      await reservationClient.query("ROLLBACK");
      throw error;
    } finally {
      reservationClient.release();
    }

    expect(reservations.map((row) => [row.commande_ligne_id, row.source_scope, row.qty_reserved])).toEqual([
      [40, "OLD", 4],
      [41, "OLD", 3],
      [41, "OLD", 2],
      [41, "NEW", 2],
      [42, "OLD", 3],
      [42, "NEW", 5],
    ]);
    expect(reservations.some((row) => row.commande_ligne_id === 43)).toBe(false);

    const persisted = await harnessPool.query<{
      commande_ligne_affaire_allocation_id: number;
      livraison_affaire_id: number;
      lot_code: string;
      source_scope: string;
      qty_reserved: number;
    }>(
      `SELECT r.commande_ligne_affaire_allocation_id::int, r.livraison_affaire_id::int,
              l.lot_code, r.source_scope, r.qty_reserved::float8 AS qty_reserved
       FROM public.stock_reservations r
       JOIN public.lots l ON l.id = r.lot_id
       ORDER BY r.commande_ligne_affaire_allocation_id,
         CASE r.source_scope WHEN 'OLD' THEN 0 ELSE 1 END,
         l.received_at, l.id`
    );
    expect(persisted.rows.map((row) => [
      row.commande_ligne_affaire_allocation_id,
      row.livraison_affaire_id,
      row.lot_code,
      row.source_scope,
      row.qty_reserved,
    ])).toEqual([
      [900, 700, "LOT-OLD-ONLY", "OLD", 4],
      [901, 700, "LOT-OLD-FIRST", "OLD", 3],
      [901, 700, "LOT-OLD-SECOND", "OLD", 2],
      [901, 700, "LOT-NEW-EARLY", "NEW", 2],
      [902, 700, "LOT-PARTIAL-OLD", "OLD", 3],
      [902, 700, "LOT-PARTIAL-NEW", "NEW", 5],
    ]);

    const levels = await harnessPool.query<{ article_id: string; qty_reserved: number }>(
      `SELECT article_id::text, qty_reserved::float8 AS qty_reserved
       FROM public.stock_levels ORDER BY article_id`
    );
    expect(levels.rows).toEqual([
      { article_id: articleOld, qty_reserved: 4 },
      { article_id: articleSplit, qty_reserved: 7 },
      { article_id: articlePartial, qty_reserved: 8 },
    ]);
  });

  it("rejects an explicitly blank physical OF when the reserved lot expects an OF", async () => {
    if (!harnessPool) throw new Error("Harness pool not initialized");
    await seedDeliveryScenario(harnessPool);
    await harnessPool.query(
      `INSERT INTO public.ordres_fabrication (
         id, numero, piece_technique_id, article_id, commande_ligne_id, affaire_id, quantite_bonne
       ) VALUES (101, 'OF-INT-101', $1::uuid, $2::uuid, 43, 700, 10)`,
      [ids.pieceTechnique, ids.article]
    );
    await harnessPool.query(
      `UPDATE public.stock_reservations SET of_id = 101 WHERE id = $1::uuid`,
      [ids.reservation]
    );

    await expect(
      deliveryRepository.repoVerifyPreparationLot(
        {
          reservation_id: ids.reservation,
          qty: 1,
          scanned_lot_code: "LOT-INT-001",
          of_number: null,
          mp_reference: null,
          tr_reference: null,
        },
        7
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "OF_SCAN_MISMATCH",
    });
  });

  it("creates one BL from several lines and commands of the same client and destination", async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await seedDeliveryScenario(harnessPool);
    await seedAdditionalDeliveryReservation(harnessPool);

    const result = await deliveryRepository.repoCreateLivraisonFromReservations({
      body: {
        items: [
          { reservation_id: ids.reservation, qty: 3 },
          { reservation_id: ids.secondReservation, qty: 2 },
        ],
      },
      user_id: 7,
      idempotency_key: "delivery-prepare-multi-command-001",
    });

    const header = await harnessPool.query<{
      client_id: string;
      commande_id: number | null;
      affaire_id: number | null;
      adresse_livraison_id: string | null;
      statut: string;
    }>(
      `SELECT client_id::text, commande_id::bigint::int, affaire_id::bigint::int,
              adresse_livraison_id::text, statut
       FROM public.bon_livraison
       WHERE id = $1::uuid`,
      [result.id]
    );
    const lines = await harnessPool.query<{ commande_ligne_id: number }>(
      `SELECT commande_ligne_id::bigint::int
       FROM public.bon_livraison_ligne
       WHERE bon_livraison_id = $1::uuid
       ORDER BY commande_ligne_id`,
      [result.id]
    );

    expect(header.rows).toEqual([
      {
        client_id: ids.client,
        commande_id: null,
        affaire_id: null,
        adresse_livraison_id: ids.deliveryAddress,
        statut: "READY",
      },
    ]);
    expect(lines.rows).toEqual([{ commande_ligne_id: 43 }, { commande_ligne_id: 45 }]);
  });

  it("rejects carts that mix clients or delivery destinations", async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await seedDeliveryScenario(harnessPool);
    await seedAdditionalDeliveryReservation(harnessPool, { clientId: ids.otherClient, deliveryAddressId: ids.otherDeliveryAddress });

    await expect(
      deliveryRepository.repoCreateLivraisonFromReservations({
        body: {
          items: [
            { reservation_id: ids.reservation, qty: 1 },
            { reservation_id: ids.secondReservation, qty: 1 },
          ],
        },
        user_id: 7,
        idempotency_key: "delivery-prepare-mixed-client-001",
      })
    ).rejects.toMatchObject({ status: 409, code: "MIXED_DELIVERY_CLIENT" });

    await clearScenario(harnessPool);
    await seedDeliveryScenario(harnessPool);
    await seedAdditionalDeliveryReservation(harnessPool, { deliveryAddressId: ids.otherDeliveryAddress });

    await expect(
      deliveryRepository.repoCreateLivraisonFromReservations({
        body: {
          items: [
            { reservation_id: ids.reservation, qty: 1 },
            { reservation_id: ids.secondReservation, qty: 1 },
          ],
        },
        user_id: 7,
        idempotency_key: "delivery-prepare-mixed-address-001",
      })
    ).rejects.toMatchObject({ status: 409, code: "MIXED_DELIVERY_DESTINATION" });
  });

  it("permits only one concurrent preparation and ships its reservation exactly once on idempotent retry", async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await seedDeliveryScenario(harnessPool);
    const preparationBody = { items: [{ reservation_id: ids.reservation, qty: 5 }] };

    const prepared = await Promise.allSettled([
      deliveryRepository.repoCreateLivraisonFromReservations({
        body: preparationBody,
        user_id: 7,
        idempotency_key: "delivery-prepare-concurrent-a",
      }),
      deliveryRepository.repoCreateLivraisonFromReservations({
        body: preparationBody,
        user_id: 7,
        idempotency_key: "delivery-prepare-concurrent-b",
      }),
    ]);
    const successfulPreparation = prepared.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<DeliveryRepository["repoCreateLivraisonFromReservations"]>>> =>
        result.status === "fulfilled"
    );
    const rejectedPreparation = prepared.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (!successfulPreparation || !rejectedPreparation) throw new Error("Expected exactly one prepared delivery and one conflict");

    expect(prepared.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(prepared.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((rejectedPreparation.reason as { code?: string }).code).toBe("RESERVATION_ALREADY_PREPARED");

    const preparedReservation = await harnessPool.query<{ qty_prepared: number; qty_consumed: number }>(
      `SELECT qty_prepared::float8 AS qty_prepared, qty_consumed::float8 AS qty_consumed
       FROM public.stock_reservations WHERE id = $1::uuid`,
      [ids.reservation]
    );
    const preparedBlCount = await harnessPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.bon_livraison WHERE statut = 'READY'`
    );
    expect(preparedReservation.rows).toEqual([{ qty_prepared: 5, qty_consumed: 0 }]);
    expect(countValue(preparedBlCount.rows[0])).toBe(1);

    const preparation = successfulPreparation.value;
    const preview = await deliveryRepository.repoGetLivraisonPreparationPreview(preparation.id);
    if (!preview) throw new Error("Expected a preparation preview");
    await harnessPool.query(
      `INSERT INTO public.bon_livraison_pack_versions (bon_livraison_id, version, status) VALUES ($1::uuid, 1, 'GENERATED')`,
      [preparation.id]
    );

    const shipmentBody = {
      expected_shipping_version: preview.shipping_version,
      preview_hash: preview.preview_hash,
    };
    const [shipped, replay] = await Promise.all([
      deliveryRepository.repoShipLivraison({
        bon_livraison_id: preparation.id,
        body: shipmentBody,
        user_id: 7,
        idempotency_key: "delivery-ship-idempotency-001",
      }),
      deliveryRepository.repoShipLivraison({
        bon_livraison_id: preparation.id,
        body: shipmentBody,
        user_id: 7,
        idempotency_key: "delivery-ship-idempotency-001",
      }),
    ]);

    const shipmentResults = [shipped, replay];
    expect(shipmentResults.filter((result) => !result.idempotent_replay)).toHaveLength(1);
    expect(shipmentResults.filter((result) => result.idempotent_replay)).toHaveLength(1);
    expect(new Set(shipmentResults.flatMap((result) => result.stock_movement_ids))).toHaveLength(1);

    const reservation = await harnessPool.query<{ qty_reserved: number; qty_consumed: number; qty_prepared: number; status: string }>(
      `SELECT qty_reserved::float8 AS qty_reserved, qty_consumed::float8 AS qty_consumed,
              qty_prepared::float8 AS qty_prepared, status
       FROM public.stock_reservations WHERE id = $1::uuid`,
      [ids.reservation]
    );
    const allocation = await harnessPool.query<{ qty_reserved: number; qty_delivered: number; qty_remaining: number; delivery_status: string }>(
      `SELECT qty_reserved::float8 AS qty_reserved, qty_delivered::float8 AS qty_delivered,
              qty_remaining::float8 AS qty_remaining, delivery_status
       FROM public.commande_ligne_affaire_allocation WHERE id = 900`
    );
    const stock = await harnessPool.query<{ total: number; reserved: number }>(
      `SELECT qty_total::float8 AS total, qty_reserved::float8 AS reserved FROM public.stock_levels`
    );
    const movements = await harnessPool.query<{ movement_type: string; status: string; qty: number }>(
      `SELECT movement_type::text AS movement_type, status, qty::float8 AS qty FROM public.stock_movements`
    );
    const allocationConsumption = await harnessPool.query<{ qty_consumed: number }>(
      `SELECT qty_consumed::float8 AS qty_consumed FROM public.bon_livraison_ligne_allocations`
    );
    const header = await harnessPool.query<{ statut: string; shipping_version: number }>(
      `SELECT statut, shipping_version FROM public.bon_livraison WHERE id = $1::uuid`,
      [preparation.id]
    );
    const outbox = await harnessPool.query<{ event_type: string; attempts: number; published_at: string | null }>(
      `SELECT event_type, attempts, published_at::text AS published_at
       FROM public.delivery_outbox WHERE aggregate_id = $1::uuid ORDER BY event_type`,
      [preparation.id]
    );

    expect(reservation.rows).toEqual([{ qty_reserved: 10, qty_consumed: 5, qty_prepared: 0, status: "ACTIVE" }]);
    expect(allocation.rows).toEqual([{ qty_reserved: 5, qty_delivered: 5, qty_remaining: 5, delivery_status: "PARTIELLEMENT_LIVREE" }]);
    expect(stock.rows).toEqual([{ total: 5, reserved: 5 }]);
    expect(movements.rows).toEqual([{ movement_type: "OUT", status: "POSTED", qty: 5 }]);
    expect(allocationConsumption.rows).toEqual([{ qty_consumed: 5 }]);
    expect(header.rows).toEqual([{ statut: "SHIPPED", shipping_version: 2 }]);
    expect(outbox.rows).toEqual([
      { event_type: "DELIVERY.PRINT_REQUESTED", attempts: 0, published_at: null },
      { event_type: "DELIVERY.SHIPPED", attempts: 0, published_at: null },
    ]);
  });
});

afterAll(async () => {
  await applicationPool?.end();
  await harnessPool?.end();
});
