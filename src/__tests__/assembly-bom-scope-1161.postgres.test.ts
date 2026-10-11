import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applicableBomScopeSql } from '../module/pieces-techniques/repository/bom-version-scope.sql';
import { synchronizeDraftChildrenTx } from '../module/production/repository/preparation-children.repository';
import { loadFabricationGenerationTree } from '../module/production/domain/of-generation';
import { ASSEMBLY_PURCHASED_REQUIREMENTS_SQL } from '../module/commande-client/domain/assembly-purchased-requirements.sql';

const url = process.env.CERP_BOM_SCOPE_PG_URL;
if (url && (process.env.CERP_E2E_ISOLATED !== '1' || new URL(url).pathname !== '/assembly_bom_scope_1161')) {
  throw new Error('BOM scope tests require the named disposable database');
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!url)('assembly BOM scope — real isolated PostgreSQL', () => {
  const db = new Pool({ connectionString: url, max: 1 });
  const read = (piece = 1, version = 11) => db.query(
    `SELECT b.id::text,b.quantite::float8 AS qty FROM public.pieces_techniques_nomenclature b
     WHERE ${applicableBomScopeSql('b', '$1::uuid', '$2::uuid')} ORDER BY b.rang,b.id`, [id(piece), id(version)],
  );
  async function line(row: number, version: number | null, child = 2, quantity = 1, piece = 1, article: number | null = null) {
    await db.query(`INSERT INTO public.pieces_techniques_nomenclature
      (id,parent_piece_technique_id,parent_piece_technique_version_id,child_piece_technique_id,child_piece_technique_version_id,child_article_id,quantite,rang)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id(row), id(piece), version === null ? null : id(version), article === null ? id(child) : null,
      article === null ? id(child + 10) : null, article === null ? null : id(article), quantity, row * 10]);
  }
  async function originalAssembly() {
    await line(31, null, 2); await line(32, null, 3);
    await db.query(`INSERT INTO public.ordres_fabrication
      (id,piece_technique_id,piece_technique_version_id,parent_of_id,source_bom_line_id,quantite_lancee,root_of_id,generation_level,quantity_cumulative)
      VALUES(1,$1,$2,NULL,NULL,4,1,0,1),(2,$3,$4,1,$5,4,1,1,1),(3,$6,$7,1,$8,4,1,1,1)`,
    [id(1),id(11),id(2),id(12),id(31),id(3),id(13),id(32)]);
    await db.query(`INSERT INTO public.of_component_requirements
      (id,consuming_of_id,component_of_id,structure_path,required_qty,shortage_qty)
      VALUES($1,1,2,$2,4,4),($3,1,3,$4,4,4)`,
    [id(41),`workbench/1/${id(31)}`,id(42),`workbench/1/${id(32)}`]);
  }
  const states = async () => ({
    children: (await db.query('SELECT id::int,statut,quantite_lancee::float8 AS qty FROM public.ordres_fabrication WHERE parent_of_id=1 ORDER BY id')).rows,
    requirements: (await db.query('SELECT id::text,status,required_qty::float8 AS qty FROM public.of_component_requirements WHERE consuming_of_id=1 ORDER BY id')).rows,
  });
  beforeAll(async () => {
    expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('assembly_bom_scope_1161');
    await db.query('BEGIN');
    await db.query(`
      CREATE TABLE public.articles(id uuid PRIMARY KEY,code text,designation text);
      CREATE TABLE public.pieces_techniques(id uuid PRIMARY KEY,article_id uuid,code_piece text,designation text,version_number int DEFAULT 1,deleted_at timestamptz);
      CREATE TABLE public.piece_technique_versions(id uuid PRIMARY KEY,piece_technique_id uuid,statut text DEFAULT 'APPLICABLE',date_effet date,version_interne int DEFAULT 1,is_current boolean DEFAULT true,created_at timestamptz DEFAULT now(),assembly_supply_strategy text DEFAULT 'MAKE_TO_ORDER');
      CREATE TABLE public.pieces_techniques_nomenclature(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),parent_piece_technique_id uuid,parent_piece_technique_version_id uuid,child_piece_technique_id uuid,child_piece_technique_version_id uuid,child_article_id uuid,quantite numeric,rang int,repere text,designation text,UNIQUE(parent_piece_technique_id,rang));
      CREATE TABLE public.pieces_techniques_achats(id uuid,piece_technique_id uuid,piece_technique_version_id uuid,article_id uuid,nom text,quantite numeric);
      CREATE TABLE public.ordres_fabrication(id bigint PRIMARY KEY,piece_technique_id uuid,piece_technique_version_id uuid,technical_preparation jsonb DEFAULT '{}',client_id text,commande_id bigint,commande_ligne_id bigint,affaire_id bigint,root_of_id bigint,generation_level int,quantity_cumulative numeric,quantite_lancee numeric,statut text DEFAULT 'BROUILLON',technical_snapshot_sha256 text,parent_of_id bigint,source_bom_line_id uuid,updated_at timestamptz DEFAULT now(),updated_by int,technical_readiness text,technical_submitted_at timestamptz,technical_submitted_by int);
      CREATE TABLE public.of_component_requirements(id uuid PRIMARY KEY,consuming_of_id bigint,component_of_id bigint,status text DEFAULT 'OPEN',structure_path text,required_qty numeric,shortage_qty numeric,old_reserved_qty numeric DEFAULT 0,new_reserved_qty numeric DEFAULT 0,updated_at timestamptz DEFAULT now());
      CREATE TABLE public.stock_reservations(id uuid,of_id bigint,of_component_requirement_id uuid,status text,qty_reserved numeric,lot_id uuid);
      CREATE TABLE public.of_receipts(of_id bigint,lot_id uuid);
    `);
    for (const n of [1, 2, 3, 4]) {
      await db.query('INSERT INTO public.articles VALUES($1,$2,$2)', [id(n + 100), `ARTICLE-${n}`]);
      await db.query('INSERT INTO public.pieces_techniques(id,article_id,code_piece,designation) VALUES($1,$2,$3,$3)', [id(n), id(n + 100), `PT-${n}`]);
      await db.query('INSERT INTO public.piece_technique_versions(id,piece_technique_id) VALUES($1,$2)', [id(n + 10),id(n)]);
    }
    await db.query('SAVEPOINT empty_bom');
  });
  beforeEach(async () => { await db.query('ROLLBACK TO SAVEPOINT empty_bom'); });
  afterAll(async () => { await db.query('ROLLBACK'); await db.end(); });

  it('preserves both legacy sub-OFs and their requirements across repeated synchronization', async () => {
    await originalAssembly(); const before = await states();
    expect((await loadFabricationGenerationTree(db,id(1))).map(n=>n.piece_technique_id)).toEqual([id(1),id(2),id(3)]);
    expect(await synchronizeDraftChildrenTx(db,1,42)).toEqual([]);
    expect(await synchronizeDraftChildrenTx(db,1,42)).toEqual([]);
    expect(await states()).toEqual(before);
  });
  it('retains an unchanged prepared child and its frozen evidence', async () => {
    await originalAssembly();
    await db.query("UPDATE public.ordres_fabrication SET technical_snapshot_sha256='frozen-child' WHERE id=2");
    const before = await states();
    await synchronizeDraftChildrenTx(db,1,42);
    expect(await states()).toEqual(before);
    expect((await db.query('SELECT technical_snapshot_sha256 FROM public.ordres_fabrication WHERE id=2')).rows[0].technical_snapshot_sha256).toBe('frozen-child');
  });
  it('selects only the explicit current index and excludes legacy and obsolete occurrences', async () => {
    await line(31,null,2,99); await line(32,11,3,2); await line(33,21,2,88);
    expect((await read()).rows).toEqual([{id:id(32),qty:2}]);
    expect((await loadFabricationGenerationTree(db,id(1))).map(n=>[n.piece_technique_id,n.quantite_cumulee])).toEqual([[id(1),1],[id(3),2]]);
  });
  it('does not resurrect a legacy BOM for an empty revision once the piece has scoped definitions', async () => {
    await line(31,null,2); await line(32,21,3);
    expect((await read()).rows).toEqual([]);
    expect((await loadFabricationGenerationTree(db,id(1)))).toHaveLength(1);
  });
  it('keeps legacy occurrences of another piece when only the first piece has version-scoped data', async () => {
    await line(31,11); await line(32,null,3,2,4);
    expect((await read(4,14)).rows).toEqual([{id:id(32),qty:2}]);
  });
  it('keeps separate occurrences of the same child with their independent quantities', async () => {
    await line(31,null,2,2); await line(32,null,2,3);
    expect((await read()).rows).toEqual([{id:id(31),qty:2},{id:id(32),qty:3}]);
  });
  it('preserves the engagement guard if an explicit edit removes a frozen child', async () => {
    await originalAssembly();
    await db.query("UPDATE public.ordres_fabrication SET technical_snapshot_sha256='frozen-child' WHERE id=2");
    await db.query('UPDATE public.pieces_techniques_nomenclature SET parent_piece_technique_version_id=$1 WHERE id=$2',[id(11),id(32)]);
    const before = await states();
    await expect(synchronizeDraftChildrenTx(db,1,42)).rejects.toMatchObject({code:'CHILD_OF_ENGAGED'});
    expect(await states()).toEqual(before);
  });
  it('preserves the stock guard if an explicit edit removes a reserved child', async () => {
    await originalAssembly();
    await db.query('UPDATE public.pieces_techniques_nomenclature SET parent_piece_technique_version_id=$1 WHERE id=$2',[id(11),id(32)]);
    await db.query("INSERT INTO public.stock_reservations(id,of_id,status,qty_reserved) VALUES($1,2,'ACTIVE',4)",[id(51)]);
    const before = await states();
    await expect(synchronizeDraftChildrenTx(db,1,42)).rejects.toMatchObject({code:'COMPONENT_STOCK_RESERVED'});
    expect(await states()).toEqual(before);
  });
  it('refuses a legacy quantity change on a reserved child without cancelling its sibling', async () => {
    await originalAssembly(); await db.query('UPDATE public.pieces_techniques_nomenclature SET quantite=2 WHERE id=$1',[id(31)]);
    await db.query("INSERT INTO public.stock_reservations(id,of_id,status,qty_reserved) VALUES($1,2,'ACTIVE',4)",[id(51)]);
    const before = await states();
    await expect(synchronizeDraftChildrenTx(db,1,42)).rejects.toMatchObject({code:'CHILD_STOCK_RESERVED'});
    expect(await states()).toEqual(before);
  });
  it('applies the same scope to purchased BOM components in the commercial preview', async () => {
    await line(31,null,2,99,1,102); await line(32,11,3,2,1,103); await line(33,21,2,88,1,102);
    const rows = (await db.query(ASSEMBLY_PURCHASED_REQUIREMENTS_SQL,[[id(1),id(1)],[id(11),id(11)]])).rows;
    expect(rows.map(r=>[r.source_line_id,r.parent_piece_technique_version_id,r.quantity_per_parent])).toEqual([[id(32),id(11),2]]);
  });
  it('maps a legacy purchased component to the selected parent revision only once', async () => {
    await line(31,null,2,2,1,102);
    const rows = (await db.query(ASSEMBLY_PURCHASED_REQUIREMENTS_SQL,[[id(1),id(1)],[id(11),id(11)]])).rows;
    expect(rows.map(r=>[r.source_line_id,r.parent_piece_technique_version_id,r.quantity_per_parent])).toEqual([[id(31),id(11),2]]);
  });
});
