import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import db from '../config/database';
import { STOCK_MOVEMENT_EVIDENCE_SQL } from '../module/stock-intelligence/repository/stock-movement-evidence.sql';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sql = STOCK_MOVEMENT_EVIDENCE_SQL.replace(/public\.(stock_movements|stock_levels|articles|units|stock_movement_lines|emplacements|magasins)\b/g, 'pg_temp.$1');
describe.skipIf(!process.env.DATABASE_URL)('stock movement value evidence — final acceptance fixture', () => {
  let client: PoolClient;
  beforeEach(async () => {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE stock_movements(id uuid PRIMARY KEY,article_id uuid,stock_level_id uuid,
      movement_type text,effective_at timestamptz,updated_at timestamptz,doc_type text,qty numeric,status text) ON COMMIT DROP;
      CREATE TEMP TABLE stock_movement_lines(id uuid,movement_id uuid,article_id uuid,qty numeric,unit_cost numeric,unite text,currency text) ON COMMIT DROP;
      CREATE TEMP TABLE stock_levels(id uuid,unit_id uuid,location_id uuid) ON COMMIT DROP;
      CREATE TEMP TABLE units(id uuid,code text) ON COMMIT DROP;
      CREATE TEMP TABLE articles(id uuid,unite text) ON COMMIT DROP;
      CREATE TEMP TABLE emplacements(location_id uuid,magasin_id uuid) ON COMMIT DROP;
      CREATE TEMP TABLE magasins(id uuid) ON COMMIT DROP;`);
    await client.query('INSERT INTO pg_temp.articles VALUES($1,\'kg\');', [id(1)]);
    await client.query('INSERT INTO pg_temp.units VALUES($1,\'kg\');', [id(2)]);
    await client.query('INSERT INTO pg_temp.stock_levels VALUES($1,$2,$3);', [id(3), id(2), id(4)]);
  });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } });
  async function movement(n: number, cost: number | null, currency = 'EUR', unit: string | null = 'kg') {
    await client.query(`INSERT INTO pg_temp.stock_movements VALUES($1,$2,$3,'OUT',$4,$4,NULL,2,'POSTED')`,
      [id(n), id(1), id(3), `2026-10-${String(n).padStart(2, '0')}T08:00:00Z`]);
    await client.query('INSERT INTO pg_temp.stock_movement_lines VALUES($1,$1,$2,2,$3,$4,$5)',
      [id(n), id(1), cost, unit, currency]);
  }
  const evidence = async () => (await client.query(sql, ['2026-10-31', 365, 91, id(1), null])).rows[0];
  it('retains the latest unpriced movement instead of borrowing a previous price/currency', async () => {
    await movement(5, 10); await movement(6, null, 'USD');
    expect(await evidence()).toMatchObject({ latest_applied_unit_cost: null, cost_currency: 'USD', latest_movement_id: id(6) });
  });
  it.each([-1, null])('leaves outgoing value unknown for invalid/missing price %s', async cost => {
    await movement(5, cost);
    expect(await evidence()).toMatchObject({ latest_applied_unit_cost: null, outbound_value_abc: null, unpriced_movement_count: 1 });
  });
  it('does not ignore a line with an unknown unit alongside a valid line', async () => {
    await movement(5, 10);
    await client.query('UPDATE pg_temp.stock_movements SET qty=4');
    await client.query('INSERT INTO pg_temp.stock_movement_lines VALUES($1,$2,$3,2,10,NULL,\'EUR\')', [id(7), id(5), id(1)]);
    expect(await evidence()).toMatchObject({ latest_applied_unit_cost: null, latest_unit_compatible: false, outbound_value_abc: null });
  });
  it('pairs the latest cost and currency and rejects incompatible units and mixed currencies', async () => {
    await movement(5, 10); await movement(6, 20, 'USD', 'mm');
    expect(await evidence()).toMatchObject({ latest_applied_unit_cost: null, cost_currency: 'USD', latest_unit_compatible: false, currency_count: 2 });
  });
  it('values coherent recorded outgoing evidence without claiming CUMP', async () => {
    await movement(5, 10); await movement(6, 20);
    expect(await evidence()).toMatchObject({ latest_applied_unit_cost: 20, cost_currency: 'EUR',
      latest_unit_compatible: true, outbound_value_abc: 60, unpriced_movement_count: 0 });
  });
  it('reports ambiguous latest chronology instead of interpreting UUID order as posting order', async () => {
    await movement(5, 10); await movement(6, 20);
    await client.query("UPDATE pg_temp.stock_movements SET effective_at='2026-10-06T08:00:00Z'");
    expect(await evidence()).toMatchObject({ latest_order_ambiguous: true });
  });
});
