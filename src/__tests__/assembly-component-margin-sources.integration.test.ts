import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { OF_MARGIN_ASSEMBLY_COMPONENT_SOURCES_SQL } from '../module/margin-engine/repository/assembly-component-cost-sources.sql';
import { OF_MARGIN_MATERIAL_SOURCES_SQL } from '../module/margin-engine/repository/of-margin-sources.sql';

// Prepared for final combined acceptance. All fixtures live in pg_temp and
// rollback; no real stock command, receipt, price or OF is changed.
const databaseUrl = process.env.CERP_MARGIN_RECIPE_DATABASE_URL;
describe.skipIf(!databaseUrl)('assembly component applied cost ownership', () => {
  const db = new Pool({ connectionString: databaseUrl, max: 1 });
  const isolate = (sql: string) => sql.replace(/public\.(stock_movements|stock_movement_lines|stock_reservations|of_component_requirements|ordres_fabrication|articles|stock_command_receipts|of_material_consumptions)\b/g, 'pg_temp.$1');
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const read = () => db.query(isolate(OF_MARGIN_ASSEMBLY_COMPONENT_SOURCES_SQL), [42]);
  beforeAll(async () => {
    await db.query('BEGIN');
    await db.query(`
      CREATE TEMP TABLE stock_movements(id uuid,status text,movement_type text,reversal_of_id uuid,source_document_type text,source_document_id text,reason_code text,posted_at timestamptz DEFAULT now());
      CREATE TEMP TABLE stock_movement_lines(id uuid,movement_id uuid,article_id uuid,lot_id uuid,qty numeric,unite text,unit_cost numeric,currency text);
      CREATE TEMP TABLE stock_reservations(id uuid,of_id bigint,article_id uuid,lot_id uuid,qty_consumed numeric,material_need_id uuid,source_type text,source_id text,of_component_requirement_id uuid);
      CREATE TEMP TABLE of_component_requirements(id uuid,consuming_of_id bigint,component_article_id uuid,parent_piece_technique_version_id uuid);
      CREATE TEMP TABLE ordres_fabrication(id bigint,piece_technique_version_id uuid);
      CREATE TEMP TABLE articles(id uuid,unite text);
      CREATE TEMP TABLE stock_command_receipts(actor_user_id integer,idempotency_key text,command_type text,resource_type text,resource_id text,request_payload jsonb,result_payload jsonb);
      CREATE TEMP TABLE of_material_consumptions(of_id bigint,stock_movement_id uuid,stock_movement_line_id uuid,reservation_id uuid,article_id uuid,lot_id uuid,qty numeric,effective_at timestamptz,status text,compensates_id uuid,compensated_by_id uuid);
    `);
    await db.query('INSERT INTO ordres_fabrication VALUES(42,$1)', [id(300)]);
    await db.query("INSERT INTO articles VALUES($1,'u')", [id(60)]);
    await db.query('INSERT INTO of_component_requirements VALUES($1,42,$2,$3)', [id(80), id(60), id(300)]);
    await db.query("INSERT INTO stock_reservations VALUES($1,42,$2,$3,6,NULL,'OF_COMPONENT',$4,$4::uuid)", [id(70), id(60), id(90), id(80)]);
    for (let i = 1; i <= 2; i++) {
      const quantity = i === 1 ? 2 : 4, key = id(100 + i);
      const proof = { requirementId: id(80), sourceOfId: i === 1 ? 42 : 43, reservationId: id(70), stockMovementId: id(i), quantity };
      await db.query("INSERT INTO stock_movements(id,status,movement_type,source_document_type,source_document_id,reason_code) VALUES($1,'POSTED','OUT','OF','42','PRELEVEMENT_COMPOSANT')", [id(i)]);
      await db.query("INSERT INTO stock_movement_lines VALUES($1,$2,$3,$4,$5,'u',5,'EUR')", [id(10 + i), id(i), id(60), id(90), quantity]);
      await db.query("INSERT INTO of_material_consumptions VALUES(42,$1,$2,$3,$4,$5,$6,now(),'POSTED',NULL,NULL)", [id(i), id(10 + i), id(70), id(60), id(90), quantity]);
      await db.query("INSERT INTO stock_command_receipts VALUES(9,$1,'RESERVATION_CONSUME','stock_reservation',$2,$3::jsonb,$4::jsonb)",
        [`${key}:${id(70)}`, id(70), JSON.stringify({ kind: 'COMPONENT', ofId: 42, reservationId: id(70), componentRequirementId: id(80), operationId: id(200), quantity }), JSON.stringify({ stockMovementId: id(i), quantity })]);
      await db.query("INSERT INTO stock_command_receipts VALUES(9,$1,'RESERVATION_CONSUME','ordres_fabrication','42',$2::jsonb,$3::jsonb)",
        [key, JSON.stringify({ kind: 'ASSEMBLY_COMPONENTS', ofId: 42 }), JSON.stringify({ ofId: 42, operationId: id(200), movements: [proof] })]);
    }
  });
  afterAll(async () => { await db.query('ROLLBACK'); await db.end(); });
  async function change(sql: string, values: unknown[], assertion: () => Promise<void>) {
    await db.query('SAVEPOINT component_cost');
    try { await db.query(sql, values); await assertion(); }
    finally { await db.query('ROLLBACK TO SAVEPOINT component_cost'); }
  }
  it('counts each partial stock issue once and keeps it out of raw material', async () => {
    expect((await read()).rows.map(row => row.amount_ht)).toEqual(['10.000000', '20.000000']);
    expect((await read()).rows.every(row => row.category === 'PURCHASE' && row.source_reliability === 'DECLARED')).toBe(true);
    expect((await db.query(isolate(OF_MARGIN_MATERIAL_SOURCES_SQL), [42])).rows).toHaveLength(0);
  });
  it.each([
    ["DELETE FROM stock_command_receipts WHERE resource_type='ordres_fabrication' AND idempotency_key=$1", [id(101)]],
    ["UPDATE stock_command_receipts SET actor_user_id=10 WHERE resource_type='ordres_fabrication' AND idempotency_key=$1", [id(101)]],
    ["INSERT INTO stock_command_receipts SELECT * FROM stock_command_receipts WHERE resource_type='stock_reservation' AND idempotency_key=$1", [`${id(101)}:${id(70)}`]],
    ["DELETE FROM of_material_consumptions WHERE stock_movement_id=$1", [id(1)]],
    ["UPDATE stock_command_receipts SET result_payload=jsonb_set(result_payload,'{quantity}','999') WHERE resource_type='stock_reservation' AND idempotency_key=$1", [`${id(101)}:${id(70)}`]],
  ])('makes missing or inconsistent ownership explicit (%s)', async (sql, values) => {
    await change(sql, values, async () => expect((await read()).rows[0]).toMatchObject({ amount_ht: null, source_reliability: 'UNKNOWN', source_type: 'ASSEMBLY_COMPONENT_COST_PROOF_MISSING' }));
  });
  it.each([null, -1])('never invents a price when the applied stock price is %s', async price => {
    await change('UPDATE stock_movement_lines SET unit_cost=$2 WHERE id=$1', [id(11), price], async () => {
      expect((await read()).rows[0]).toMatchObject({ amount_ht: null, quantity: '2', source_reliability: 'DECLARED' });
    });
  });
  it('removes only the returned output, never charges its inverse', async () => {
    await change("INSERT INTO stock_movements VALUES($1,'POSTED','IN',$2,'STOCK_COMPENSATION',$2::text,'COMPENSATION',now())", [id(3), id(1)], async () => {
      expect((await read()).rows.map(row => row.amount_ht)).toEqual(['20.000000']);
    });
  });
  it('keeps noncanonical component scrap visible with unknown cost', async () => {
    await change("UPDATE stock_movements SET movement_type='SCRAP' WHERE id=$1", [id(1)], async () => {
      expect((await read()).rows[0]).toMatchObject({ amount_ht: null, source_reliability: 'UNKNOWN' });
    });
  });
});
