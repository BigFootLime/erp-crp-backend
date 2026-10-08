import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OF_MARGIN_MEASUREMENTS_SQL } from "../module/margin-engine/repository/of-margin-sources.sql";

// Prepared for final combined acceptance. Only temporary fixtures are queried.
const url = process.env.CERP_MARGIN_RECIPE_DATABASE_URL;
describe.skipIf(!url)("OF margin output — terminal declared pieces", () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const sql = OF_MARGIN_MEASUREMENTS_SQL.replace(
    /public\.(of_operations|of_revisions|production_quantity_declarations)\b/g, "pg_temp.$1",
  );
  const measure = async (ofId: number) => (await pool.query(sql, [ofId])).rows[0];
  beforeAll(async () => {
    await pool.query("BEGIN");
    await pool.query(`
      CREATE TEMP TABLE of_revisions(id text,of_id bigint,statut text);
      CREATE TEMP TABLE of_operations(id text,of_id bigint,revision_id text,phase int,status text,temps_total_planned numeric,temps_total_real numeric);
      CREATE TEMP TABLE production_quantity_declarations(of_id bigint,operation_id text,qty_good numeric,qty_pending_control numeric,qty_scrap numeric,qty_rework numeric,declared_at timestamptz);
      INSERT INTO of_revisions VALUES('active',91,'ACTIVE'),('old',91,'SUPERSEDED');
      INSERT INTO of_operations VALUES
        ('cut',91,'active',10,'DONE',1,1),('machine',91,'active',20,'DONE',2,2),
        ('pack',91,'active',30,'IN_PROGRESS',3,3),('cancelled',91,'active',99,'CANCELLED',50,0),
        ('old-output',91,'old',40,'DONE',70,5),
        ('waiting-cut',92,NULL,10,'DONE',1,1),('waiting-final',92,NULL,20,'TODO',1,0),
        ('zero-final',93,NULL,10,'TODO',1,0),('legacy-final',94,NULL,10,'DONE',1,1);
      INSERT INTO production_quantity_declarations VALUES
        (91,'cut',100,0,0,3,'2026-10-01'),(91,'machine',90,0,10,3,'2026-10-02'),
        (91,'pack',80,10,0,0,'2026-10-03'),(91,'cancelled',500,0,0,0,'2026-10-04'),
        (91,'old-output',200,0,0,0,'2026-09-01'),
        (92,'waiting-cut',100,0,0,0,'2026-10-01'),
        (93,'zero-final',0,5,0,0,'2026-10-01'),(94,'legacy-final',5,0,0,0,'2026-10-01');
    `);
  });
  afterAll(async () => { await pool.query("ROLLBACK"); await pool.end(); });
  it("counts only terminal output and keeps historical real work and loss activity", async () => {
    const result = await measure(91);
    expect(result.good_quantity).toBe("80");
    expect(result.pending_control_quantity).toBe("10");
    expect(result.good_operation_id).toBe("pack");
    expect(result.good_declaration_count).toBe(1);
    expect(result.planned_hours).toBe("6");
    expect(result.actual_hours).toBe("11");
    expect(result.scrap_quantity).toBe("10");
    expect(result.rework_quantity).toBe("6");
    expect(result.good_quantity_scope).toBe("FINAL_ACTIVE_OPERATION_DECLARED");
    await pool.query(`INSERT INTO pg_temp.production_quantity_declarations VALUES(91,'pack',-20,0,0,0,'2026-10-05')`);
    expect((await measure(91)).good_quantity).toBe("60");
  });
  it("distinguishes missing output, explicit zero and legacy unversioned routing", async () => {
    expect((await measure(92)).good_quantity).toBeNull();
    expect((await measure(92)).good_declaration_count).toBe(0);
    expect((await measure(93)).good_quantity).toBe("0");
    expect((await measure(93)).pending_control_quantity).toBe("5");
    expect((await measure(94)).good_quantity).toBe("5");
    expect((await measure(95)).good_operation_id).toBeNull();
  });
});
