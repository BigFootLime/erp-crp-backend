import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { OF_MARGIN_CONSUMABLE_SOURCES_SQL } from "../module/margin-engine/repository/consumable-cost-sources.sql";
import { OF_MARGIN_MATERIAL_SOURCES_SQL } from "../module/margin-engine/repository/of-margin-sources.sql";

// Prepared for the final combined recipe only; all records are temporary.
const databaseUrl = process.env.CERP_MARGIN_RECIPE_DATABASE_URL;
describe.skipIf(!databaseUrl)("consumable margin physical source ownership", () => {
  const db = new Pool({ connectionString: databaseUrl, max: 1 });
  const isolated = (sql: string) => sql.replace(/public\.(stock_movements|stock_movement_lines|stock_reservations|of_material_needs|of_material_consumptions|consumable_commands)\b/g, "pg_temp.$1");
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const read = () => db.query(isolated(OF_MARGIN_CONSUMABLE_SOURCES_SQL), [42]);
  beforeAll(async () => {
    await db.query("BEGIN");
    await db.query(`
      CREATE TEMP TABLE stock_movements(id uuid,status text,movement_type text,reversal_of_id uuid,source_document_type text,
        source_document_id text,reason_code text,posted_at timestamptz DEFAULT now());
      CREATE TEMP TABLE stock_movement_lines(id uuid,movement_id uuid,article_id uuid,lot_id uuid,qty numeric,unite text,unit_cost numeric,currency text);
      CREATE TEMP TABLE stock_reservations(id uuid,of_id bigint,article_id uuid,lot_id uuid,material_need_id uuid,qty_consumed numeric);
      CREATE TEMP TABLE of_material_needs(id uuid,need_kind text,consumption_mode text,unit text);
      CREATE TEMP TABLE consumable_commands(of_id bigint,command_type text,response jsonb);
      CREATE TEMP TABLE of_material_consumptions(of_id bigint,stock_movement_id uuid,stock_movement_line_id uuid,article_id uuid,lot_id uuid,
        qty numeric,effective_at timestamptz,status text,compensates_id uuid,compensated_by_id uuid);
    `);
    await db.query("INSERT INTO of_material_needs VALUES($1,'CONSOMMABLE','UNIT','u')", [id(80)]);
    await db.query("INSERT INTO stock_reservations VALUES($1,42,$2,NULL,$3,5),($4,42,$2,$5,$3,4)", [id(70),id(60),id(80),id(71),id(90)]);
    for (let i=1;i<=3;i++) {
      const qty=i===1?2:i===2?3:4,lot=i===3?id(90):null,reservation=i===3?id(71):id(70);
      await db.query("INSERT INTO stock_movements(id,status,movement_type,source_document_type,source_document_id,reason_code) VALUES($1,'POSTED','OUT','OF','42','PRELEVEMENT_CONSOMMABLE')", [id(i)]);
      await db.query("INSERT INTO stock_movement_lines VALUES($1,$2,$3,$4,$5,'u',5,'EUR')", [id(10+i),id(i),id(60),lot,qty]);
      await db.query("INSERT INTO consumable_commands VALUES(42,'WITHDRAW',$1::jsonb)", [JSON.stringify({reservationId:reservation,stockMovementId:id(i),quantity:qty})]);
      if (lot) await db.query("INSERT INTO of_material_consumptions VALUES(42,$1,$2,$3,$4,$5,now(),'POSTED',NULL,NULL)", [id(i),id(10+i),id(60),lot,qty]);
    }
  });
  afterAll(async () => { await db.query("ROLLBACK"); await db.end(); });
  async function withChange(sql: string, values: unknown[], assertion: () => Promise<void>) {
    await db.query("SAVEPOINT changed_source");
    try { await db.query(sql,values); await assertion(); }
    finally { await db.query("ROLLBACK TO SAVEPOINT changed_source"); }
  }
  it("uses every partial command and both lot and unbatched stock exactly once", async () => {
    expect((await read()).rows.map(row=>row.amount_ht)).toEqual(["10.000000","15.000000","20.000000"]);
    expect((await read()).rows.every(row=>row.category==="PURCHASE")).toBe(true);
    expect((await db.query(isolated(OF_MARGIN_MATERIAL_SOURCES_SQL),[42])).rows).toHaveLength(0);
  });
  it.each([
    ["UPDATE consumable_commands SET response=jsonb_set(response,'{quantity}','\"invalid\"'::jsonb) WHERE response->>'stockMovementId'=$1",[id(1)]],
    ["UPDATE stock_reservations SET article_id=$2::uuid WHERE id=$1::uuid",[id(70),id(61)]],
    ["UPDATE of_material_needs SET unit='kg' WHERE id=$1::uuid",[id(80)]],
    ["UPDATE of_material_needs SET consumption_mode='GLOBAL_PACK' WHERE id=$1::uuid",[id(80)]],
    ["INSERT INTO consumable_commands SELECT * FROM consumable_commands WHERE response->>'stockMovementId'=$1",[id(1)]],
  ])("keeps incoherent ownership explicit without guessing a cost (%s)", async (sql,values) => {
    await withChange(sql,values,async () => {
      expect((await read()).rows[0]).toMatchObject({amount_ht:null,source_type:"CONSUMABLE_WITHDRAWAL_PROOF_MISSING"});
    });
  });
  it("does not invent a price for a physically proven issue", async () => {
    await withChange("UPDATE stock_movement_lines SET unit_cost=NULL WHERE id=$1::uuid",[id(11)],async () => {
      expect((await read()).rows[0]).toMatchObject({amount_ht:null,quantity:"2",source_reliability:"DECLARED"});
    });
  });
  it("excludes a reversed output without charging the compensating input", async () => {
    await withChange("INSERT INTO stock_movements VALUES($1,'POSTED','IN',$2,'OF','42',NULL,now())",[id(4),id(1)],async () => {
      expect((await read()).rows.map(row=>row.amount_ht)).toEqual(["15.000000","20.000000"]);
    });
  });
  it("does not allocate global pack exhaustion to an OF", async () => {
    await withChange("UPDATE stock_movements SET source_document_type='MANUAL',reason_code='PALETTE_TERMINEE'",[],async () => {
      expect((await read()).rows).toHaveLength(0);
    });
  });
});
