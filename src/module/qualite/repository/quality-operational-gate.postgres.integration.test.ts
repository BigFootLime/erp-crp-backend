import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertOperationalLotQualityEligibility,
  recordDirectLotQualityConsumption,
} from "./quality-operational-gate.repository";

// This is intentionally opt-in: it talks to a real PostgreSQL instance and
// refuses every database except the fresh, explicitly named #616 rehearsal DB.
const DATABASE_URL = process.env.CERP_QUALITY_GATE_PG_URL;
const TEST_DATABASE = "quality_gate_616_concurrency";
const describePostgres = DATABASE_URL?.endsWith(`/${TEST_DATABASE}`) ? describe : describe.skip;

const ARTICLE_ID = "00000000-0000-4000-8000-000000000616";
const LOT_ID = "00000000-0000-4000-8000-000000000617";
const CONTROL_ID = "00000000-0000-4000-8000-000000000618";

async function client(): Promise<Client> {
  if (!DATABASE_URL) throw new Error("CERP_QUALITY_GATE_PG_URL is required for this integration test");
  const connection = new Client({ connectionString: DATABASE_URL });
  await connection.connect();
  return connection;
}

async function resetFixture(): Promise<void> {
  const db = await client();
  try {
    await db.query(`
      TRUNCATE public.stock_reservations, public.quality_release_decision,
        public.quality_derogation, public.non_conformity_dispositions,
        public.non_conformity, public.quality_control, public.lots,
        public.articles RESTART IDENTITY CASCADE
    `);
    await db.query(`INSERT INTO public.articles (id, unite) VALUES ($1::uuid, 'PCS')`, [ARTICLE_ID]);
    await db.query(`INSERT INTO public.lots (id, article_id, lot_code, lot_status) VALUES ($1::uuid, $2::uuid, 'LOT-616', 'LIBERE')`, [LOT_ID, ARTICLE_ID]);
    await db.query(`
      INSERT INTO public.quality_control (
        id, lot_id, source_type, source_id, control_date, qty_released,
        qty_held, qty_consumed, unite, validation_date, verdict
      ) VALUES ($1::uuid, $2::uuid, 'LOT', $2::text, now(), 10, 0, 0, 'PCS', now(), 'CONFORME')
    `, [CONTROL_ID, LOT_ID]);
  } finally {
    await db.end();
  }
}

async function reserve(qty: number, locked?: () => void): Promise<void> {
  const db = await client();
  try {
    await db.query("BEGIN");
    await assertOperationalLotQualityEligibility({ client: db, lotId: LOT_ID, qty, unit: "PCS", purpose: "RESERVE" });
    locked?.();
    // Keep the first transaction open so the second contender must exercise
    // PostgreSQL row-lock waiting rather than merely run after it.
    await db.query("SELECT pg_sleep(0.15)");
    await db.query(`INSERT INTO public.stock_reservations (lot_id, qty_reserved, status) VALUES ($1::uuid, $2, 'ACTIVE')`, [LOT_ID, qty]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function directOut(qty: number, locked?: () => void): Promise<void> {
  const db = await client();
  try {
    await db.query("BEGIN");
    const decision = await assertOperationalLotQualityEligibility({ client: db, lotId: LOT_ID, qty, unit: "PCS", purpose: "RESERVE" });
    locked?.();
    await db.query("SELECT pg_sleep(0.15)");
    await recordDirectLotQualityConsumption({ client: db, decision, qty });
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function shipmentConsume(locked: () => void): Promise<void> {
  const db = await client();
  try {
    await db.query("BEGIN");
    // The shipment path has an existing ACTIVE reservation, so it verifies
    // current Quality state with zero additional entitlement.
    await assertOperationalLotQualityEligibility({ client: db, lotId: LOT_ID, qty: 0, unit: "PCS", purpose: "RESERVE" });
    locked();
    await db.query("SELECT pg_sleep(0.15)");
    await db.query(`UPDATE public.stock_reservations SET status = 'CONSUMED' WHERE lot_id = $1::uuid`, [LOT_ID]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

describePostgres("Quality 360 operational gate — real PostgreSQL concurrency (#616)", () => {
  beforeAll(async () => {
    if (!DATABASE_URL?.endsWith(`/${TEST_DATABASE}`)) throw new Error("Refusing non-#616 database");
    const db = await client();
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.articles (id uuid PRIMARY KEY, unite text);
        CREATE TABLE IF NOT EXISTS public.lots (id uuid PRIMARY KEY, article_id uuid NOT NULL, lot_code text NOT NULL, lot_status text NOT NULL);
        CREATE TABLE IF NOT EXISTS public.quality_control (
          id uuid PRIMARY KEY, lot_id uuid, source_type text, source_id text,
          control_date timestamptz NOT NULL, qty_released numeric NOT NULL DEFAULT 0,
          qty_held numeric NOT NULL DEFAULT 0, qty_consumed numeric NOT NULL DEFAULT 0,
          unite text, validation_date timestamptz, verdict text, updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS public.stock_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, qty_reserved numeric NOT NULL, status text NOT NULL);
        CREATE TABLE IF NOT EXISTS public.non_conformity (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, status text NOT NULL);
        CREATE TABLE IF NOT EXISTS public.non_conformity_dispositions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), non_conformity_id uuid NOT NULL);
        CREATE TABLE IF NOT EXISTS public.quality_derogation (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL, valid_to timestamptz);
        CREATE TABLE IF NOT EXISTS public.quality_release_decision (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), quality_control_id uuid NOT NULL, derogation_id uuid NOT NULL, decided_at timestamptz NOT NULL DEFAULT now());
      `);
    } finally {
      await db.end();
    }
  });

  afterAll(async () => {
    // Leave the named database in place but erase only this test's tables.
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.stock_reservations, public.quality_release_decision, public.quality_derogation, public.non_conformity_dispositions, public.non_conformity, public.quality_control, public.lots, public.articles CASCADE`);
    } finally {
      await db.end();
    }
  });

  it("serializes concurrent reservation writers: one 7-unit claim wins and the second cannot over-spend 10 released", async () => {
    await resetFixture();
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = reserve(7, releaseFirst);
    await firstLocked;
    const second = reserve(7);
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "QUALITY_NOT_ELIGIBLE" } });
  }, 5_000);

  it("serializes concurrent direct OUT writers and persists the winning debit", async () => {
    await resetFixture();
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = directOut(7, releaseFirst);
    await firstLocked;
    const second = directOut(7);
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const db = await client();
    try {
      expect((await db.query<{ qty_consumed: string }>(`SELECT qty_consumed::text FROM public.quality_control WHERE id = $1::uuid`, [CONTROL_ID])).rows[0]?.qty_consumed).toBe("7");
    } finally {
      await db.end();
    }
  }, 5_000);

  it("keeps a concurrent shipment-style consumed reservation committed, blocking direct OUT without a deadlock or double-spend", async () => {
    await resetFixture();
    const setup = await client();
    try {
      await setup.query(`INSERT INTO public.stock_reservations (lot_id, qty_reserved, status) VALUES ($1::uuid, 7, 'ACTIVE')`, [LOT_ID]);
    } finally {
      await setup.end();
    }
    let releaseShipment!: () => void;
    const shipmentLocked = new Promise<void>((resolve) => { releaseShipment = resolve; });
    const shipment = shipmentConsume(releaseShipment);
    await shipmentLocked;
    const direct = directOut(4);
    const results = await Promise.allSettled([shipment, direct]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "QUALITY_NOT_ELIGIBLE" } });
  }, 5_000);
});
