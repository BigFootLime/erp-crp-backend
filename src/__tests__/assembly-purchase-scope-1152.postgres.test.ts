import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { ASSEMBLY_PURCHASED_REQUIREMENTS_SQL } from '../module/commande-client/domain/assembly-purchased-requirements.sql';

const url = process.env.CERP_ASSEMBLY_SCOPE_PG_URL;
if (url && (process.env.CERP_E2E_ISOLATED !== '1' || new URL(url).pathname !== '/assembly_purchase_scope_1152')) {
  throw new Error('Assembly purchase scope tests require the named disposable database');
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type RequirementRow = { source_line_id: string; piece_technique_id: string; parent_piece_technique_version_id: string | null; quantity_per_parent: number; article_id: string; source_kind: string };

describe.skipIf(!url)('assembly purchase version scope — real isolated PostgreSQL', () => {
  const db = new Pool({ connectionString: url, max: 1 });
  const read = (pieces: string[] = [id(1)], versions: string[] = [id(11)]) => db.query<RequirementRow>(ASSEMBLY_PURCHASED_REQUIREMENTS_SQL, [pieces, versions]);
  const purchase = (row: number, piece: number, version: number | null, quantity: number, article: number | null = 101) =>
    db.query('INSERT INTO public.pieces_techniques_achats VALUES($1,$2,$3,$4,$5,$6)', [id(row), id(piece), version === null ? null : id(version), article === null ? null : id(article), `Purchase ${row}`, quantity]);
  beforeAll(async () => {
    expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('assembly_purchase_scope_1152');
    await db.query('BEGIN');
    await db.query(`
      CREATE TABLE public.articles(id uuid PRIMARY KEY,code text,designation text);
      CREATE TABLE public.pieces_techniques_achats(id uuid PRIMARY KEY,piece_technique_id uuid,piece_technique_version_id uuid,article_id uuid,nom text,quantite numeric);
      CREATE TABLE public.pieces_techniques_nomenclature(id uuid PRIMARY KEY,parent_piece_technique_id uuid,parent_piece_technique_version_id uuid,child_article_id uuid,designation text,quantite numeric);
    `);
    await db.query("INSERT INTO public.articles VALUES($1,'RAW','Raw stock'),($2,'TR','Treatment')", [id(101),id(102)]);
    await db.query('SAVEPOINT empty_requirements');
  });
  beforeEach(async () => { await db.query('ROLLBACK TO SAVEPOINT empty_requirements'); });
  afterAll(async () => { await db.query('ROLLBACK'); await db.end(); });

  it('counts only current-version material and treatment, excluding two obsolete versions and legacy purchases', async () => {
    await purchase(201,1,11,110.5); await purchase(202,1,11,1,102);
    await purchase(203,1,12,110.5); await purchase(204,1,12,1,102);
    await purchase(205,1,13,1,102); await purchase(206,1,null,110);
    const result = (await read()).rows;
    expect(result.map(r => r.source_line_id)).toEqual([id(201),id(202)]);
    expect(result.map(r => r.quantity_per_parent * 4)).toEqual([442,4]);
    expect(result.every(r => r.parent_piece_technique_version_id === id(11))).toBe(true);
  });
  it('keeps the legacy-only material of another piece without importing its old-version purchases', async () => {
    await purchase(201,1,12,999); await purchase(202,1,null,1);
    expect((await read()).rows.map(r => [r.source_line_id,r.quantity_per_parent])).toEqual([[id(202),1]]);
  });
  it('does not use legacy purchases when the exact version has an unresolved purchase without an article', async () => {
    await purchase(201,1,11,1,null); await purchase(202,1,null,110);
    expect((await read()).rows).toHaveLength(0);
  });
  it('separates selected versions of the same piece and preserves real distinct lines of one article', async () => {
    await purchase(201,1,11,2); await purchase(202,1,11,3); await purchase(203,1,12,7); await purchase(204,1,null,99);
    const rows = (await read([id(1),id(1)],[id(11),id(12)])).rows;
    expect(rows.map(r => [r.source_line_id,r.parent_piece_technique_version_id,r.quantity_per_parent])).toEqual([
      [id(201),id(11),2],[id(202),id(11),3],[id(203),id(12),7],
    ]);
  });
  it('keeps independent fallback decisions for several selected parents', async () => {
    await purchase(201,1,11,110.5); await purchase(202,1,null,99); await purchase(203,2,null,1); await purchase(204,2,22,999);
    const rows = (await read([id(1),id(2)],[id(11),id(21)])).rows;
    expect(rows.map(r => [r.source_line_id,r.parent_piece_technique_version_id])).toEqual([[id(201),id(11)],[id(203),id(21)]]);
  });
  it('reads repeated parent/version selections once so the domain can multiply each distinct tree path itself', async () => {
    await purchase(201,1,11,110.5);
    expect((await read([id(1),id(1)],[id(11),id(11)])).rows).toHaveLength(1);
  });
  it('retains separate BOM and purchase requirements for the same article', async () => {
    await purchase(201,1,11,2);
    await db.query('INSERT INTO public.pieces_techniques_nomenclature VALUES($1,$2,$3,$4,$5,$6)',[id(301),id(1),id(11),id(101),'Additional component',3]);
    const rows = (await read()).rows;
    expect(rows.map(r => [r.source_kind,r.quantity_per_parent])).toEqual([['BOM',3],['PURCHASE',2]]);
  });
});
