import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const integrationUrl = process.env.CERP_CONSOLIDATION_GOOD_OUTPUT_TEST_DATABASE_URL;
const describePg = integrationUrl ? describe : describe.skip;
let pool: Pool;
let tx: PoolClient;

function requireIsolatedDatabase() {
  if (!integrationUrl || process.env.DATABASE_URL !== integrationUrl)
    throw new Error("CERP_CONSOLIDATION_GOOD_OUTPUT_TEST_DATABASE_URL must exactly match DATABASE_URL");
  const url = new URL(integrationUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '56145' || url.pathname !== '/cerp_test')
    throw new Error("Consolidation good-output integration test only runs on loopback:56145/cerp_test");
}

describePg("consolidation good-output invariants — isolated PostgreSQL", () => {
  beforeAll(async () => {
    requireIsolatedDatabase();
    pool = new Pool({ connectionString: integrationUrl });
  });
  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query("BEGIN");
  });
  afterEach(async () => {
    await tx.query("ROLLBACK").catch(() => undefined);
    tx.release();
  });
  afterAll(async () => pool.end());

  it("accepts 224 physical pieces for two 112-brut / 100-good sources and rejects violations", async () => {
    const fixture = randomUUID().slice(0, 8);
    const ids = await tx.query<{ piece_id: string; user_id: number }>(`
      SELECT (SELECT id::text FROM public.pieces_techniques ORDER BY id LIMIT 1) AS piece_id,
             (SELECT id::int FROM public.users ORDER BY id LIMIT 1) AS user_id`);
    const seed = ids.rows[0];
    if (!seed?.piece_id || !seed.user_id) throw new Error("Fixture requires a technical piece and a user");
    const source = async (suffix: string, launched: number) => (await tx.query<{ id: number }>(
      `INSERT INTO public.ordres_fabrication(numero,piece_technique_id,quantite_lancee)
       VALUES($1,$2::uuid,$3) RETURNING id::bigint::int AS id`,
      [`OF-GOOD-${fixture}-${suffix}`, seed.piece_id, launched],
    )).rows[0]!.id;
    const first = await source("A", 112);
    const second = await source("B", 112);
    const producer = await source("P", 224);
    const groupId = randomUUID();
    await tx.query(`INSERT INTO public.production_consolidations(id,producer_of_id,idempotency_key,request_hash,surplus_quantity,reason,created_by,quantity_semantics)
      VALUES($1::uuid,$2,$3::uuid,'fixture',0,'preuve invariant bonnes',$4,'GOOD_OUTPUT_V1')`, [groupId, producer, randomUUID(), seed.user_id]);
    for (const sourceId of [first, second]) {
      await tx.query(`INSERT INTO public.production_consolidation_allocations(consolidation_id,source_of_id,quantity,due_date,source_updated_at)
        VALUES($1::uuid,$2,100,CURRENT_DATE,clock_timestamp())`, [groupId, sourceId]);
    }
    await expect(tx.query("SET CONSTRAINTS ALL IMMEDIATE")).resolves.toBeDefined();

    await tx.query("SAVEPOINT too_many_good");
    await expect(tx.query("UPDATE public.production_consolidation_allocations SET quantity=113 WHERE consolidation_id=$1::uuid AND source_of_id=$2", [groupId, first]))
      .rejects.toMatchObject({ code: "23514" });
    await tx.query("ROLLBACK TO SAVEPOINT too_many_good");

    await tx.query("SAVEPOINT wrong_physical_launch");
    await expect(tx.query("UPDATE public.ordres_fabrication SET quantite_lancee=225 WHERE id=$1", [producer]))
      .rejects.toMatchObject({ code: "23514" });
    await tx.query("ROLLBACK TO SAVEPOINT wrong_physical_launch");

    const standalone = await source("STANDALONE", 1);
    await expect(tx.query("UPDATE public.ordres_fabrication SET quantite_lancee=2 WHERE id=$1", [standalone])).resolves.toBeDefined();
    await expect(tx.query("SET CONSTRAINTS ALL IMMEDIATE")).resolves.toBeDefined();
  });
});
