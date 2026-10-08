import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureQuoteMarginsTx } from "../module/margin-engine/repository/margin-engine.repository";
import { readQuoteMarginSnapshot } from "../module/margin-engine/repository/quote-margin-snapshot.repository";
import { QUOTE_MARGIN_SOURCES_SQL } from "../module/margin-engine/repository/quote-margin-sources.sql";

// Prepared for final combined acceptance. Every business table is replaced by
// a temporary fixture; the actual capture and source-query functions are used.
const url = process.env.CERP_MARGIN_RECIPE_DATABASE_URL;
describe.skipIf(!url)("quote cost capture — isolated temporary fixtures", () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const isolate = (sql: string) => sql.replace(/public\.(devis_ligne|devis|articles|piece_technique_versions|gammes|pieces_techniques_achats|pieces_techniques_operations|margin_input_versions|margin_rates|margin_rate_versions|quote_margin_source_snapshots)\b/g, "pg_temp.$1");
  const tx = { query: (sql: string, args?: unknown[]) => pool.query(isolate(sql), args) } as unknown as PoolClient;
  beforeAll(async () => {
    await pool.query("BEGIN");
    await pool.query(`
      CREATE TEMP TABLE devis(id bigint PRIMARY KEY,numero text,statut text,total_ht numeric,remise_globale numeric,version_number int,updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE devis_ligne(id bigint PRIMARY KEY,devis_id bigint,description text,article_id uuid,piece_technique_id uuid,quantite numeric,total_ht numeric);
      CREATE TEMP TABLE articles(id uuid,piece_technique_id uuid);
      CREATE TEMP TABLE piece_technique_versions(id uuid,piece_technique_id uuid,statut text,version_interne int,created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE gammes(id uuid,piece_technique_version_id uuid,statut text,is_current boolean,updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE pieces_techniques_achats(id uuid,piece_technique_id uuid,piece_technique_version_id uuid,type_achat text,total_achat_ht numeric,updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE pieces_techniques_operations(id uuid,piece_technique_id uuid,gamme_id uuid,type_operation text,tp numeric,tf_unit numeric,coef numeric,taux_horaire numeric,updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE margin_input_versions (LIKE public.margin_input_versions);
      CREATE TEMP TABLE margin_rates (LIKE public.margin_rates);
      CREATE TEMP TABLE margin_rate_versions (LIKE public.margin_rate_versions);
      CREATE TEMP TABLE quote_margin_source_snapshots (LIKE public.quote_margin_source_snapshots INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
      INSERT INTO devis(id,numero,statut,total_ht,remise_globale,version_number) VALUES(41,'DEV-FIXTURE','ENVOYE',3000,0,1),(42,'DEV-RECORDED','ENVOYE',1000,0,1);
      INSERT INTO devis_ligne VALUES(410,41,'Ten',NULL,'00000000-0000-4000-8000-000000000001',10,1000),(411,41,'Twenty',NULL,'00000000-0000-4000-8000-000000000001',20,2000);
      INSERT INTO piece_technique_versions(id,piece_technique_id,statut,version_interne) VALUES
        ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','APPLICABLE',2),
        ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','OBSOLETE',1);
      INSERT INTO gammes(id,piece_technique_version_id,statut,is_current) VALUES('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','APPLICABLE',true);
      INSERT INTO pieces_techniques_achats(id,piece_technique_id,piece_technique_version_id,type_achat,total_achat_ht) VALUES
        ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','MATIERE',2),
        ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','MATIERE',900);
      INSERT INTO pieces_techniques_operations(id,piece_technique_id,gamme_id,type_operation,tp,tf_unit,coef,taux_horaire) VALUES
        ('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','TOURNAGE',1,.1,1,50),
        ('00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','CONTROLE',0,.1,1,0);
    `);
  });
  afterAll(async () => { await pool.query("ROLLBACK"); await pool.end(); });
  it("freezes the observed dossier and line quantities without summing obsolete purchases", async () => {
    await captureQuoteMarginsTx(tx, 41, "ISSUED", null);
    const first = (await readQuoteMarginSnapshot(tx, "DEVIS_LINE", "410"))!.input_snapshot;
    const second = (await readQuoteMarginSnapshot(tx, "DEVIS_LINE", "411"))!.input_snapshot;
    expect(first.costs.filter(c => c.category === "MATERIAL").map(c => Number(c.amount_ht))).toEqual([20]);
    expect(second.costs.filter(c => c.category === "MATERIAL").map(c => Number(c.amount_ht))).toEqual([40]);
    expect(first.costs.find(c => c.category === "OPERATOR")?.amount_ht).toBe("100.000000");
    expect(second.costs.find(c => c.category === "OPERATOR")?.amount_ht).toBe("150.000000");
    expect(first.costs.find(c => c.category === "CONTROL")?.amount_ht).toBeNull();
    await pool.query("UPDATE pg_temp.pieces_techniques_achats SET total_achat_ht=50");
    await captureQuoteMarginsTx(tx, 41, "ISSUED", null);
    expect((await readQuoteMarginSnapshot(tx, "DEVIS_LINE", "410"))!.input_snapshot).toEqual(first);
    const current = (await tx.query(QUOTE_MARGIN_SOURCES_SQL, ["410", "DEVIS_LINE"])).rows;
    expect(Number(current.find(c => c.category === "MATERIAL").amount_ht)).toBe(500);
    expect((await tx.query('SELECT count(*)::int AS n FROM public.quote_margin_source_snapshots WHERE devis_id=41')).rows[0].n).toBe(3);
  });
  it("does not invent quoted costs for an offer entered after it was sent", async () => {
    await captureQuoteMarginsTx(tx, 42, "RECORDED_SENT", null);
    const captured = (await readQuoteMarginSnapshot(tx, "DEVIS", "42"))!;
    expect(captured.capture_kind).toBe("RECORDED_SENT");
    expect(captured.input_snapshot.costs).toEqual([]);
    expect(captured.input_snapshot.revenue?.amount_ht).toBe("1000");
  });
});
