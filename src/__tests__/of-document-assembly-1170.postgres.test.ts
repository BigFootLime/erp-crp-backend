import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCommercialContext, readDocumentMaterialExemption, type OfHeaderRow } from '../module/production/repository/of-versioning.repository';
import { buildOfDocumentPayload } from '../module/production/domain/of-document';
import { buildFixtureInput } from '../../test-support/production/of-document.fixture';

const url = process.env.CERP_OF_DOCUMENT_PG_URL;
if (url && (process.env.CERP_E2E_ISOLATED !== '1' || new URL(url).pathname !== '/of_document_assembly_1170')) {
  throw new Error('OF document tests require their named disposable database');
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!url)('OF document assembly coverage — real isolated PostgreSQL', () => {
  const db = new Pool({connectionString: url, max: 1});
  const header = (id = 101, piece = 1, qty = 4): OfHeaderRow => ({
    of_id: id, of_uuid: String(id), numero: `OF-${id}`, statut: 'BROUILLON', quantite_lancee: qty,
    affaire_id: null, commande_id: null, commande_ligne_id: 118, client_id: 'TEST-CLIENT', client_nom: 'Client recette',
    piece_technique_id: uuid(piece), piece_reference: `PT-${piece}`, piece_designation: 'Pièce recette', piece_indice: 'A',
    gamme_id: null, gamme_code: null, gamme_version: null, commande_numero: null, production_group_id: null, date_fin_prevue: null,
  });
  async function order(id: number, piece = 1, qty = 4, parent: number | null = null, version = piece + 10, status = 'BROUILLON', bom: number | null = null, client = 'TEST-CLIENT') {
    await db.query(`INSERT INTO public.ordres_fabrication(id,numero,commande_ligne_id,client_id,piece_technique_id,piece_technique_version_id,parent_of_id,source_bom_line_id,quantite_lancee,statut)
      VALUES($1,$2,118,$3,$4,$5,$6,$7,$8,$9)`, [id, `OF-${id}`, client, uuid(piece), uuid(version), parent, bom === null ? null : uuid(bom), qty, status]);
  }
  async function coverage(h = header()) { return (await readCommercialContext(h, db)).quantites; }
  beforeAll(async () => {
    expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('of_document_assembly_1170');
    await db.query('BEGIN');
    await db.query(`
      CREATE TABLE public.ordres_fabrication(id bigint PRIMARY KEY,numero text,commande_ligne_id bigint,client_id text,piece_technique_id uuid,piece_technique_version_id uuid,parent_of_id bigint,source_bom_line_id uuid,quantite_lancee numeric,quantite_bonne numeric DEFAULT 0,statut text,date_fin_reelle timestamptz,date_fin_prevue timestamptz,technical_snapshot_sha256 text,technical_snapshot jsonb);
      CREATE TABLE public.commande_ligne_affaire_allocation(commande_ligne_id bigint,livraison_affaire_id bigint,qty_ordered numeric,qty_from_stock numeric,qty_reserved numeric,qty_to_produce numeric);
      CREATE TABLE public.affaire(id bigint PRIMARY KEY,reference text);
      CREATE TABLE public.commande_ligne(id bigint PRIMARY KEY,delai_client date);
      INSERT INTO public.commande_ligne_affaire_allocation VALUES(118,NULL,4,0,0,4);
    `);
    await db.query('SAVEPOINT empty_orders');
  });
  beforeEach(async () => { await db.query('ROLLBACK TO SAVEPOINT empty_orders'); });
  afterAll(async () => { await db.query('ROLLBACK'); await db.end(); });

  it('does not count four axes and four plates as eight deliverable assemblies', async () => {
    await order(101); await order(102, 2, 4, 101, 12, 'BROUILLON', 32); await order(103, 3, 4, 101, 13, 'BROUILLON', 33);
    const quantities = await coverage();
    expect(quantities).toMatchObject({quantiteDemandee: 4, couvertAutresOf: 0, quantiteAffecteeCetOf: 4});
    const payload = buildOfDocumentPayload({...buildFixtureInput(), quantites: quantities});
    expect(payload.quantites.totalCouvert).toBe(4);
    expect(payload.quantites.surCouverture).toBe(false);
  });
  it('keeps matching active root coverage and excludes other pieces, indices, clients and finished orders', async () => {
    await order(101); await order(104, 1, 2); await order(105, 2, 90); await order(106, 1, 80, null, 21);
    await order(107, 1, 70, null, 11, 'ANNULE'); await order(108, 1, 60, null, 11, 'TERMINE');
    await order(109, 1, 50, null, 11, 'CLOTURE'); await order(110, 1, 40, null, 11, 'BROUILLON', null, 'OTHER-CLIENT');
    expect((await coverage()).couvertAutresOf).toBe(2);
  });
  it('does not reuse assembly demand or reserved assemblies for a child requiring two parts per assembly', async () => {
    await order(101); await order(102, 2, 8, 101, 12, 'BROUILLON', 32); await order(103, 3, 4, 101, 13, 'BROUILLON', 33);
    await db.query('UPDATE public.commande_ligne_affaire_allocation SET qty_from_stock=1,qty_reserved=2');
    expect(await coverage(header(102, 2, 8))).toMatchObject({quantiteDemandee: 8, stockReserve: 0, couvertAutresOf: 0, quantiteAffecteeCetOf: 8});
  });
  it('does not mix separate BOM occurrences or another assembly branch of the same component', async () => {
    await order(101); await order(102, 2, 8, 101, 12, 'BROUILLON', 32);
    await order(103, 2, 90, 101, 12, 'BROUILLON', 33); await order(104, 2, 80, 200, 12, 'BROUILLON', 32);
    await order(105, 2, 2, 101, 12, 'BROUILLON', 32);
    expect((await coverage(header(102, 2, 8))).couvertAutresOf).toBe(2);
  });
  it('retains root stock coverage and has no side effect on orders or allocations', async () => {
    await order(101); await db.query('UPDATE public.commande_ligne_affaire_allocation SET qty_from_stock=1,qty_reserved=2');
    const before = (await db.query('SELECT row_to_json(o) AS row FROM public.ordres_fabrication o ORDER BY id')).rows;
    expect(await coverage()).toMatchObject({stockReserve: 3, couvertAutresOf: 0});
    expect((await db.query('SELECT row_to_json(o) AS row FROM public.ordres_fabrication o ORDER BY id')).rows).toEqual(before);
  });
  it('accepts only a justified frozen assembly material exemption and rejects missing or malformed evidence', async () => {
    await order(101);
    const snapshot = {preparation_evidence: {version: {manufacturing_mode: 'ASSEMBLY'}, purchases: []}, preparation_decisions: {material: {mode: 'NOT_REQUIRED', reason: 'Montage de sous-pièces'}}};
    const set = async (data: unknown, frozen: string | null = 'frozen-proof') => {
      await db.query('UPDATE public.ordres_fabrication SET technical_snapshot=$1::jsonb,technical_snapshot_sha256=$2 WHERE id=101', [JSON.stringify(data), frozen]);
      return readDocumentMaterialExemption(101, db);
    };
    expect(await set(snapshot)).toBe(true);
    expect(await set(snapshot, null)).toBe(false);
    expect(await set({...snapshot, preparation_evidence: {...snapshot.preparation_evidence, version: {manufacturing_mode: 'MACHINING'}}})).toBe(false);
    expect(await set({...snapshot, preparation_evidence: {...snapshot.preparation_evidence, purchases: [{type_achat: 'MATIERE'}]}})).toBe(false);
    expect(await set({...snapshot, preparation_evidence: {...snapshot.preparation_evidence, purchases: null}})).toBe(false);
    expect(await set({...snapshot, preparation_decisions: {material: {mode: 'NOT_REQUIRED', reason: ' '}}})).toBe(false);
    expect(await set({})).toBe(false);
    expect(await set(null)).toBe(false);
  });
});
