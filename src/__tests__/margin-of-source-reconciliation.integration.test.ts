import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateMargin, type MarginCalculationInput, type MarginEvidence } from "../module/margin-engine/domain/margin-engine";
import { ofMarginOperationSourcesSql, OF_MARGIN_MATERIAL_SOURCES_SQL, OF_MARGIN_MEASUREMENTS_SQL } from "../module/margin-engine/repository/of-margin-sources.sql";

const proof: MarginEvidence = {
  definition: "Fixture for final combined acceptance", unit: "EUR_HT", period_start: "2026-10-08", period_end: "2026-10-08",
  freshness_at: "2026-10-08T00:00:00Z", source_reliability: "VERIFIED", source_type: "FIXTURE", source_ref: "42",
  observed_at: "2026-10-08T00:00:00Z", assumption: null, assumption_date: null, rate_version_id: null,
  rate_id: null, rate_effective_at: null, rate_scope_type: null, rate_scope_ref: null, source_document_type: "OF", source_document_ref: "42",
};

describe("margin currency boundary", () => {
  const input: MarginCalculationInput = {
    scope_type: "OF", scope_ref: "42", label: "OF fixture", basis: "ACTUAL", as_of: "2026-10-08", required_categories: ["MATERIAL"],
    revenue: { availability: "PROVIDED", amount_ht: "100", currency: "EUR", evidence: proof },
    costs: [{ key: "issue", category: "MATERIAL", availability: "PROVIDED", amount_ht: "10", quantity: null, rate: null, rate_unit: null, currency: "USD", evidence: proof }],
  };
  it("does not sum an unconverted foreign cost into EUR", () => {
    const result = calculateMargin(input);
    expect(result.gross_margin_ht).toBeNull();
    expect(result.partial_cost_total_ht).toBe("0.00");
    expect(result.missing_inputs).toContainEqual(expect.objectContaining({ code: "COST_CURRENCY_UNSUPPORTED" }));
  });
  it("does not publish a foreign revenue as EUR", () => {
    const result = calculateMargin({ ...input, costs: [{ ...input.costs[0]!, currency: "EUR" }], revenue: { ...input.revenue!, currency: "USD" } });
    expect(result.revenue_ht).toBeNull();
    expect(result.currency).toBe("EUR");
  });
});

// Opt-in only during the final recipe. No public tables or business records are
// mutated: the actual source SQL is compiled against isolated temporary tables.
const databaseUrl = process.env.CERP_MARGIN_RECIPE_DATABASE_URL;
describe.skipIf(!databaseUrl)("OF margin SQL source semantics", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const isolated = (sql: string) => sql.replace(/public\.(of_revisions|of_operations|production_quantity_declarations|of_material_consumptions|stock_movement_lines|stock_movements)\b/g, "pg_temp.$1");
  beforeAll(async () => {
    await pool.query("BEGIN");
    await pool.query(`
      CREATE TEMP TABLE of_revisions(id uuid, of_id bigint, statut text);
      CREATE TEMP TABLE of_operations(id uuid, of_id bigint, revision_id uuid, phase int, designation text, status text,
        temps_total_planned numeric, temps_total_real numeric, hourly_rate_applied numeric, updated_at timestamptz);
      CREATE TEMP TABLE production_quantity_declarations(of_id bigint, operation_id uuid, qty_good numeric, qty_pending_control numeric,
        qty_scrap numeric, qty_rework numeric, declared_at timestamptz);
      CREATE TEMP TABLE stock_movements(id uuid, status text, movement_type text, reversal_of_id uuid,
        source_document_type text DEFAULT 'OF', source_document_id text DEFAULT '42', reason_code text DEFAULT 'DEBIT_MATIERE', posted_at timestamptz DEFAULT now());
      CREATE TEMP TABLE stock_movement_lines(id uuid, movement_id uuid, article_id uuid, lot_id uuid, unit_cost numeric, currency text);
      CREATE TEMP TABLE of_material_consumptions(of_id bigint, stock_movement_id uuid, stock_movement_line_id uuid, article_id uuid,
        lot_id uuid, qty numeric, effective_at timestamptz, status text, compensates_id uuid, compensated_by_id uuid);
      INSERT INTO of_revisions VALUES
        ('00000000-0000-4000-8000-000000000001',42,'SUPERSEDED'),('00000000-0000-4000-8000-000000000002',42,'ACTIVE');
      INSERT INTO of_operations VALUES
        ('00000000-0000-4000-8000-000000000011',42,'00000000-0000-4000-8000-000000000001',10,'Turning','DONE',10,2,50,now()),
        ('00000000-0000-4000-8000-000000000012',42,'00000000-0000-4000-8000-000000000002',10,'Turning','TODO',4,0,50,now()),
        ('00000000-0000-4000-8000-000000000013',42,'00000000-0000-4000-8000-000000000002',20,'Unpriced','TODO',1,0,0,now());
      INSERT INTO stock_movements(id,status,movement_type,reversal_of_id) VALUES
        ('00000000-0000-4000-8000-000000000101','POSTED','OUT',NULL),
        ('00000000-0000-4000-8000-000000000102','POSTED','OUT',NULL),
        ('00000000-0000-4000-8000-000000000103','POSTED','OUT',NULL),
        ('00000000-0000-4000-8000-000000000104','POSTED','IN','00000000-0000-4000-8000-000000000103');
      INSERT INTO stock_movement_lines
      SELECT ('00000000-0000-4000-8000-' || lpad((201+i)::text,12,'0'))::uuid,
        ('00000000-0000-4000-8000-' || lpad((101+i)::text,12,'0'))::uuid,
        '00000000-0000-4000-8000-000000000301'::uuid,'00000000-0000-4000-8000-000000000401'::uuid,2,'EUR'
      FROM generate_series(0,3) i;
      INSERT INTO of_material_consumptions
      SELECT 42,movement_id,id,article_id,lot_id,CASE WHEN id::text LIKE '%202' THEN 20 ELSE 10 END,now(),
        CASE WHEN id::text LIKE '%203' THEN 'COMPENSATED' ELSE 'POSTED' END,
        CASE WHEN id::text LIKE '%204' THEN '00000000-0000-4000-8000-000000000501'::uuid ELSE NULL END,NULL
      FROM stock_movement_lines;
    `);
  });
  afterAll(async () => { await pool.query("ROLLBACK"); await pool.end(); });
  it("keeps both partial issues and excludes original plus inverse of a correction", async () => {
    const result = await pool.query(isolated(OF_MARGIN_MATERIAL_SOURCES_SQL), [42]);
    expect(result.rows.map(row => row.amount_ht)).toEqual(["20.000000", "40.000000"]);
  });
  it("keeps an explicit missing input when an OF issue lacks its consumption proof", async () => {
    await pool.query("SAVEPOINT missing_proof");
    try {
      await pool.query("DELETE FROM pg_temp.of_material_consumptions WHERE stock_movement_line_id='00000000-0000-4000-8000-000000000201'");
      const result = await pool.query(isolated(OF_MARGIN_MATERIAL_SOURCES_SQL), [42]);
      expect(result.rows).toContainEqual(expect.objectContaining({ source_type: "STOCK_CONSUMPTION_PROOF_MISSING", amount_ht: null }));
    } finally { await pool.query("ROLLBACK TO SAVEPOINT missing_proof"); }
  });
  it("uses active planned time but retains time already spent on an old revision", async () => {
    const standard = await pool.query(isolated(ofMarginOperationSourcesSql("STANDARD")), [42]);
    const actual = await pool.query(isolated(ofMarginOperationSourcesSql("ACTUAL")), [42]);
    const updated = await pool.query(isolated(ofMarginOperationSourcesSql("UPDATED")), [42]);
    expect(standard.rows.map(row => row.amount_ht)).toEqual(["200.000000", null]);
    expect(actual.rows.map(row => row.amount_ht)).toEqual(["100.000000", "0.000000", null]);
    expect(updated.rows.map(row => row.amount_ht)).toEqual(["100.000000", "200.000000", null]);
    const measures = await pool.query(isolated(OF_MARGIN_MEASUREMENTS_SQL), [42]);
    expect(measures.rows[0]).toMatchObject({ planned_hours: "5", actual_hours: "2" });
  });
});
