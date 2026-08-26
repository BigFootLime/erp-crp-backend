import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Opt-in PostgreSQL integration coverage for the AR migration and the series
 * allocator. It refuses every database other than the local, disposable
 * `cerp_commande_ar_integration` database and requires the application pool
 * to point at the exact same URL.
 *
 * The normal suite remains database-free: without
 * CERP_AR_INTEGRATION_DATABASE_URL, this file is skipped before any database
 * module is imported.
 */

type CommandeArRepository = typeof import("../module/commande-client/repository/commande-ar.repository");

const integrationDatabaseUrl = process.env.CERP_AR_INTEGRATION_DATABASE_URL;
const describePg = integrationDatabaseUrl ? describe : describe.skip;
const patchPath = path.resolve(__dirname, "../../db/patches/20260826_commande_ar_versioning_and_send_guard.sql");
const arPatch = fs.readFileSync(patchPath, "utf8");

let harnessPool: Pool | null = null;
let applicationPool: Pool | null = null;
let arRepository: CommandeArRepository;

function requireSafeIntegrationDatabase() {
  if (!integrationDatabaseUrl) throw new Error("CERP_AR_INTEGRATION_DATABASE_URL is required for this suite");
  if (process.env.DATABASE_URL !== integrationDatabaseUrl) {
    throw new Error("DATABASE_URL must exactly match CERP_AR_INTEGRATION_DATABASE_URL for this isolated suite");
  }

  const url = new URL(integrationDatabaseUrl);
  if (!(["127.0.0.1", "localhost"] as string[]).includes(url.hostname)) {
    throw new Error("The AR integration suite only accepts a loopback PostgreSQL host");
  }
  if (url.pathname !== "/cerp_commande_ar_integration") {
    throw new Error("The AR integration suite only accepts database cerp_commande_ar_integration");
  }
}

async function installPrePatchSchema(db: Pool) {
  // This is intentionally the smallest pre-patch shape required by the
  // migration. The real patch is then applied verbatim below.
  await db.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;

    CREATE TABLE public.commande_client (
      id BIGINT PRIMARY KEY
    );

    CREATE TABLE public.commande_ar_log (
      id UUID PRIMARY KEY,
      commande_id BIGINT NOT NULL,
      document_id UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'GENERATED',
      subject TEXT NULL,
      body_text TEXT NULL,
      recipient_emails TEXT[] NOT NULL DEFAULT '{}'::text[],
      recipient_contact_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      generated_by INTEGER NULL,
      sent_at TIMESTAMPTZ NULL,
      sent_by INTEGER NULL,
      email_provider_id TEXT NULL,
      error_message TEXT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
}

async function applyArPatch(db: Pool) {
  await db.query(arPatch);
}

async function insertCommandes(db: Pool, ids: number[]) {
  for (const id of ids) {
    await db.query(`INSERT INTO public.commande_client (id) VALUES ($1::bigint)`, [id]);
  }
}

async function insertLegacyLog(db: Pool, args: { id: string; commandeId: number; generatedAt: string }) {
  await db.query(
    `
      INSERT INTO public.commande_ar_log (id, commande_id, document_id, status, generated_at)
      VALUES ($1::uuid, $2::bigint, $3::uuid, 'GENERATED', $4::timestamptz)
    `,
    [args.id, args.commandeId, args.id, args.generatedAt]
  );
}

async function seedLegacyHistory(db: Pool) {
  await insertCommandes(db, [10, 20, 30, 40, 50]);
  // Commande 10 deliberately has tied timestamps: UUID is the deterministic
  // tie-breaker required by the patch for immutable version ordering.
  await insertLegacyLog(db, {
    id: "00000000-0000-4000-8000-000000000010",
    commandeId: 10,
    generatedAt: "2026-01-02T10:00:00.000Z",
  });
  await insertLegacyLog(db, {
    id: "00000000-0000-4000-8000-000000000011",
    commandeId: 10,
    generatedAt: "2026-01-02T10:00:00.000Z",
  });
  await insertLegacyLog(db, {
    id: "00000000-0000-4000-8000-000000000020",
    commandeId: 20,
    generatedAt: "2026-01-01T09:00:00.000Z",
  });
  await insertLegacyLog(db, {
    id: "00000000-0000-4000-8000-000000000030",
    commandeId: 30,
    generatedAt: "2026-01-03T09:00:00.000Z",
  });
}

type SeriesRow = { commande_id: number; series_number: number; next_version_number: number };
type LogRow = { id: string; commande_id: number; series_number: number; version_number: number; ar_reference: string };

async function loadSeries(db: Pool): Promise<SeriesRow[]> {
  const result = await db.query<SeriesRow>(`
    SELECT commande_id::int AS commande_id, series_number::int AS series_number, next_version_number
    FROM public.commande_ar_series
    ORDER BY commande_id ASC
  `);
  return result.rows;
}

async function loadLogs(db: Pool): Promise<LogRow[]> {
  const result = await db.query<LogRow>(`
    SELECT id::text AS id, commande_id::int AS commande_id, ar_series_number::int AS series_number,
           version_number, ar_reference
    FROM public.commande_ar_log
    ORDER BY commande_id ASC, version_number ASC, id ASC
  `);
  return result.rows;
}

async function rollbackQuietly(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original error is the relevant assertion failure.
  }
}

describePg("commande AR versioning — isolated PostgreSQL migration", () => {
  beforeAll(async () => {
    requireSafeIntegrationDatabase();
    harnessPool = new Pool({ connectionString: integrationDatabaseUrl });
    await installPrePatchSchema(harnessPool);

    // The singleton is imported only after URL validation, keeping the
    // repository under test on the disposable integration database.
    const databaseModule = await import("../config/database");
    applicationPool = databaseModule.default;
    arRepository = await import("../module/commande-client/repository/commande-ar.repository");
  });

  beforeEach(async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await installPrePatchSchema(harnessPool);
  });

  it("backfills deterministic immutable versions and safely appends a newly discovered historical order on rerun", async () => {
    if (!harnessPool) throw new Error("Integration pool was not initialized");
    await seedLegacyHistory(harnessPool);

    await applyArPatch(harnessPool);

    expect(await loadSeries(harnessPool)).toEqual([
      { commande_id: 10, series_number: 2, next_version_number: 3 },
      { commande_id: 20, series_number: 1, next_version_number: 2 },
      { commande_id: 30, series_number: 3, next_version_number: 2 },
    ]);
    expect(await loadLogs(harnessPool)).toEqual([
      { id: "00000000-0000-4000-8000-000000000010", commande_id: 10, series_number: 2, version_number: 1, ar_reference: "AR-00000002-v1" },
      { id: "00000000-0000-4000-8000-000000000011", commande_id: 10, series_number: 2, version_number: 2, ar_reference: "AR-00000002-v2" },
      { id: "00000000-0000-4000-8000-000000000020", commande_id: 20, series_number: 1, version_number: 1, ar_reference: "AR-00000001-v1" },
      { id: "00000000-0000-4000-8000-000000000030", commande_id: 30, series_number: 3, version_number: 1, ar_reference: "AR-00000003-v1" },
    ]);

    // Insert a legacy order dated strictly between the existing historical
    // dates, then rerun the exact migration. Existing references must not be
    // renumbered; the missing series is appended after the current maximum.
    // A production deployment cannot normally insert this incomplete legacy
    // row after the first successful patch because the patch intentionally
    // makes these columns NOT NULL.  The harness temporarily recreates the
    // pre-patch input condition; the second application below must restore
    // the constraints and backfill it without changing prior references.
    await harnessPool.query(`
      ALTER TABLE public.commande_ar_log ALTER COLUMN ar_series_number DROP NOT NULL;
      ALTER TABLE public.commande_ar_log ALTER COLUMN version_number DROP NOT NULL;
      ALTER TABLE public.commande_ar_log ALTER COLUMN ar_reference DROP NOT NULL;
    `);
    await insertLegacyLog(harnessPool, {
      id: "00000000-0000-4000-8000-000000000040",
      commandeId: 40,
      generatedAt: "2026-01-02T12:00:00.000Z",
    });
    await applyArPatch(harnessPool);

    const expectedSeriesAfterRerun = [
      { commande_id: 10, series_number: 2, next_version_number: 3 },
      { commande_id: 20, series_number: 1, next_version_number: 2 },
      { commande_id: 30, series_number: 3, next_version_number: 2 },
      { commande_id: 40, series_number: 4, next_version_number: 2 },
    ];
    const expectedLogsAfterRerun = [
      { id: "00000000-0000-4000-8000-000000000010", commande_id: 10, series_number: 2, version_number: 1, ar_reference: "AR-00000002-v1" },
      { id: "00000000-0000-4000-8000-000000000011", commande_id: 10, series_number: 2, version_number: 2, ar_reference: "AR-00000002-v2" },
      { id: "00000000-0000-4000-8000-000000000020", commande_id: 20, series_number: 1, version_number: 1, ar_reference: "AR-00000001-v1" },
      { id: "00000000-0000-4000-8000-000000000030", commande_id: 30, series_number: 3, version_number: 1, ar_reference: "AR-00000003-v1" },
      { id: "00000000-0000-4000-8000-000000000040", commande_id: 40, series_number: 4, version_number: 1, ar_reference: "AR-00000004-v1" },
    ];
    expect(await loadSeries(harnessPool)).toEqual(expectedSeriesAfterRerun);
    expect(await loadLogs(harnessPool)).toEqual(expectedLogsAfterRerun);

    // A third run changes neither numbering nor references, even though its
    // bookkeeping timestamps are intentionally refreshed by the patch.
    await applyArPatch(harnessPool);
    expect(await loadSeries(harnessPool)).toEqual(expectedSeriesAfterRerun);
    expect(await loadLogs(harnessPool)).toEqual(expectedLogsAfterRerun);

    const nextSeries = await harnessPool.query<{ value: number }>(
      `SELECT nextval('public.commande_ar_series_no_seq')::int AS value`
    );
    expect(nextSeries.rows).toEqual([{ value: 5 }]);

    await expect(
      harnessPool.query(
        `INSERT INTO public.commande_ar_log (id, commande_id, document_id, status, ar_series_number, version_number, ar_reference)
         VALUES ('00000000-0000-4000-8000-000000000041', 40, '00000000-0000-4000-8000-000000000041', 'GENERATED', 4, 1, 'AR-OTHER')`
      )
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      harnessPool.query(`UPDATE public.commande_ar_log SET version_number = 0 WHERE id = '00000000-0000-4000-8000-000000000040'`)
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      harnessPool.query(`UPDATE public.commande_ar_log SET status = 'UNKNOWN' WHERE id = '00000000-0000-4000-8000-000000000040'`)
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      harnessPool.query(
        `INSERT INTO public.commande_ar_log (id, commande_id, document_id, status, ar_series_number, version_number, ar_reference)
         VALUES ('00000000-0000-4000-8000-000000000042', 40, '00000000-0000-4000-8000-000000000042', 'GENERATED', NULL, 2, 'AR-00000004-v2')`
      )
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("allocates a missing AR series once under a forced two-transaction race", async () => {
    if (!harnessPool || !applicationPool) throw new Error("Integration pools were not initialized");
    await insertCommandes(harnessPool, [50]);
    await applyArPatch(harnessPool);

    const firstClient = await applicationPool.connect();
    const secondClient = await applicationPool.connect();
    let releaseSecondInsert: () => void = () => {
      throw new Error("The second transaction barrier was not initialized");
    };
    const secondInsertMayProceed = new Promise<void>((resolve) => {
      releaseSecondInsert = resolve;
    });
    let secondReadComplete: () => void = () => {
      throw new Error("The second read barrier was not initialized");
    };
    const secondReadObserved = new Promise<void>((resolve) => {
      secondReadComplete = resolve;
    });
    let interceptInitialRead = true;
    const secondTx = {
      query: async (sql: string, values?: unknown[]) => {
        const isInitialSeriesRead = interceptInitialRead && sql.includes("FROM public.commande_ar_series") && sql.includes("FOR UPDATE");
        if (!isInitialSeriesRead) return secondClient.query(sql, values);
        interceptInitialRead = false;
        const result = await secondClient.query(sql, values);
        secondReadComplete();
        await secondInsertMayProceed;
        return result;
      },
    } as unknown as Pick<PoolClient, "query">;

    try {
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");

      const first = await arRepository.repoReserveCommandeArVersion({ tx: firstClient, commande_id: 50 });
      const secondPromise = arRepository.repoReserveCommandeArVersion({ tx: secondTx, commande_id: 50 });
      await secondReadObserved;
      await firstClient.query("COMMIT");
      releaseSecondInsert();
      const second = await secondPromise;
      await secondClient.query("COMMIT");

      expect(first.series_number).toBe(second.series_number);
      expect([first.version_number, second.version_number].sort((left, right) => left - right)).toEqual([1, 2]);
      expect(new Set([first.reference, second.reference])).toHaveLength(2);
      expect(await loadSeries(harnessPool)).toEqual([
        { commande_id: 50, series_number: first.series_number, next_version_number: 3 },
      ]);
    } catch (error) {
      await rollbackQuietly(firstClient);
      await rollbackQuietly(secondClient);
      throw error;
    } finally {
      firstClient.release();
      secondClient.release();
    }
  });
});

afterAll(async () => {
  await applicationPool?.end();
  await harnessPool?.end();
});
