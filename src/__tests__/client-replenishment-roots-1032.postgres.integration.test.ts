import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertReplenishmentPlan } from '../module/client/repository/client-contract-replenishment.repository';
import { prepareContractReplenishmentSnapshot } from '../module/client/domain/client-contract-replenishment-preparation';
import type { ContractCoverageResult } from '../module/client/types/client-contract-coverage.types';
import { readReplenishmentProducerIntents } from '../module/client/repository/client-contract-replenishment-intents.repository';

const url = process.env.CLIENT_REPLENISHMENT_ROOTS_1032_TEST_DATABASE_URL;
describe.skipIf(!url)('anticipated root evidence PostgreSQL 17', () => {
  const db = new Pool({ connectionString: url, max: 4 });
  const patch = '20261010_client_replenishment_roots_1032';
  const sql = (suffix = '') => readFile(`db/patches/${suffix ? 'support/' : ''}${patch}${suffix}.sql`, 'utf8');
  const article = { article_id: randomUUID(), root_article_id: randomUUID(), piece_technique_id: randomUUID(),
    piece_technique_version_id: randomUUID(), unit_id: randomUUID(), unit: 'U', code: 'TEST-PF', designation: 'Axe fictif', indice: 'A' };
  beforeAll(async () => {
    const info = (await db.query(`SELECT current_database() AS name,current_setting('server_version_num')::integer AS version,
      to_regclass('public.client_contracts') AS application_schema`)).rows[0];
    if (info.name !== 'cerp_replenishment_roots_1032_test' || info.version < 170000 || info.application_schema)
      throw Error('Use an empty disposable PostgreSQL17 cerp_replenishment_roots_1032_test database; ERP schemas are forbidden.');
    await db.query(`CREATE ROLE cerp_app NOLOGIN;
      CREATE TABLE public.users(id integer PRIMARY KEY,username text NOT NULL);
      CREATE TABLE public.units(id uuid PRIMARY KEY,code text NOT NULL DEFAULT 'U');
      CREATE TABLE public.articles(id uuid PRIMARY KEY,unite text NOT NULL DEFAULT 'U');
      CREATE TABLE public.pieces_techniques(id uuid PRIMARY KEY);
      CREATE TABLE public.piece_technique_versions(id uuid PRIMARY KEY);
      CREATE TABLE public.client_contracts(id uuid PRIMARY KEY,client_id text NOT NULL);
      CREATE TABLE public.client_contract_lines(id uuid NOT NULL,contract_id uuid NOT NULL REFERENCES public.client_contracts(id),
        root_article_id uuid NOT NULL REFERENCES public.articles(id),unit_id uuid NOT NULL REFERENCES public.units(id),PRIMARY KEY(id,contract_id));
      CREATE TABLE public.ordres_fabrication(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,root_of_id bigint,parent_of_id bigint,
        statut text NOT NULL,commande_id bigint,commande_ligne_id bigint,affaire_id bigint,article_id uuid,piece_technique_id uuid,
        piece_technique_version_id uuid,quantite_lancee numeric,quantite_bonne numeric DEFAULT 0,quantite_rebut numeric DEFAULT 0,
        client_id text,created_by integer,technical_preparation jsonb);
      CREATE TABLE public.of_output_lots(of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),qty_ok numeric(18,3) NOT NULL DEFAULT 0);
      CREATE TABLE public.of_receipts(id uuid PRIMARY KEY,of_id bigint REFERENCES public.ordres_fabrication(id),qty_ok numeric(18,3) NOT NULL);
      CREATE TABLE public.production_receipt_lane_assignments(receipt_id uuid REFERENCES public.of_receipts(id),quantity numeric(18,3) NOT NULL);
      CREATE TABLE public.production_consolidations(id uuid PRIMARY KEY,producer_of_id bigint REFERENCES public.ordres_fabrication(id),state text NOT NULL);
      CREATE TABLE public.production_consolidation_allocations(id uuid PRIMARY KEY,consolidation_id uuid REFERENCES public.production_consolidations(id),
        source_of_id bigint REFERENCES public.ordres_fabrication(id),quantity numeric(18,3) NOT NULL,received_quantity numeric(18,3) NOT NULL DEFAULT 0,state text NOT NULL);
      CREATE FUNCTION public.fn_protect_stock_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
      INSERT INTO public.users VALUES(1,'Test Author');
      GRANT SELECT ON public.users,public.units,public.articles,public.pieces_techniques,public.piece_technique_versions,public.of_output_lots TO cerp_app;
      GRANT SELECT ON public.of_receipts,public.production_receipt_lane_assignments,public.production_consolidations,public.production_consolidation_allocations TO cerp_app;
      GRANT SELECT,INSERT,UPDATE ON public.client_contracts,public.client_contract_lines,public.ordres_fabrication TO cerp_app;`);
    await db.query('INSERT INTO public.units(id) VALUES($1)', [article.unit_id]);
    await db.query('INSERT INTO public.articles(id) VALUES($1),($2)', [article.article_id, article.root_article_id]);
    await db.query('INSERT INTO public.pieces_techniques VALUES($1)', [article.piece_technique_id]);
    await db.query('INSERT INTO public.piece_technique_versions VALUES($1)', [article.piece_technique_version_id]);
    await db.query(await readFile('db/patches/20261010_client_replenishment_preparations_1032.sql', 'utf8'));
    await db.query(await sql('.preflight')); await db.query(await sql()); await db.query(await sql('.verify'));
    await db.query(await sql('.rollback')); await db.query(await sql());
  }, 30000);
  afterAll(async () => { await db.end(); });
  async function fixture() {
    const contractId = randomUUID(), lineId = randomUUID(), planId = randomUUID(), launchId = randomUUID(), key = randomUUID();
    await db.query('INSERT INTO public.client_contracts VALUES($1,$2)', [contractId, '195']);
    await db.query('INSERT INTO public.client_contract_lines VALUES($1,$2,$3,$4)', [lineId, contractId, article.root_article_id, article.unit_id]);
    const report: ContractCoverageResult = { contract_id: contractId, contract_version: 1, generated_at: '2026-10-10T08:00:00Z',
      planning_revision: null, start_month: '2026-10', months: 3, readonly: true, snapshot_hash: 'a'.repeat(64),
      lines: [{ contract_line_id: lineId, article, replenishment_qty: '20', months: [], replenishment_projection: [{
        month: '2026-10', target_date: '2026-09-30', target_overdue: true, uncovered_quantity: '17', carried_quantity: '0',
        lot_quantity: '20', lot_count: '1', proposed_quantity: '20', surplus_quantity: '3' }] }],
      demands: [], sources: [], allocations: [], issues: [] };
    const preparation = prepareContractReplenishmentSnapshot(report, '2026-10-10');
    const proposals = preparation.proposals.map(p => ({ ...p, id: randomUUID(), plan_id: planId }));
    await insertReplenishmentPlan(db, { id: planId, actor: 1, previousId: null, preparation, proposals });
    await db.query(`INSERT INTO public.client_contract_replenishment_launches(id,plan_id,contract_id,actor_user_id,idempotency_key,
      request_hash,intent_snapshot_hash,result_payload) VALUES($1,$2,$3,1,$4,$5,$6,'{}')`, [launchId, planId, contractId, key, 'b'.repeat(64), 'c'.repeat(64)]);
    const ofId = (await db.query(`INSERT INTO public.ordres_fabrication(statut,article_id,piece_technique_id,quantite_lancee,client_id,
      created_by,technical_preparation) VALUES('BROUILLON',$1,$2,20,'195',1,jsonb_build_object('selected_version_id',$3::text)) RETURNING id::text`,
      [article.article_id, article.piece_technique_id, article.piece_technique_version_id])).rows[0].id;
    await db.query('UPDATE public.ordres_fabrication SET root_of_id=id WHERE id=$1', [ofId]);
    return { launchId, planId, contractId, proposalId: proposals[0].id, ofId, key };
  }
  const insert = (f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}, queryer: Pick<PoolClient, 'query'> = db) => {
    const values = { id: randomUUID(), launch: f.launchId, plan: f.planId, contract: f.contractId, proposal: f.proposalId,
      of: f.ofId, article: article.article_id, piece: article.piece_technique_id, version: article.piece_technique_version_id,
      unit: article.unit_id, quantity: '20', target: '2026-09-30', ...overrides };
    return queryer.query(`INSERT INTO public.client_contract_replenishment_roots(id,launch_id,plan_id,contract_id,proposal_id,root_of_id,
      article_id,piece_technique_id,piece_technique_version_id,unit_id,quantity,target_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, Object.values(values));
  };
  it('links the exact original target, applicable version and draft root without changing stock', async () => {
    const f = await fixture(); await insert(f);
    expect((await db.query('SELECT quantity::text,target_date::text,root_of_id::text FROM public.client_contract_replenishment_roots WHERE proposal_id=$1', [f.proposalId])).rows[0])
      .toEqual({ quantity: '20.000', target_date: '2026-09-30', root_of_id: f.ofId });
    await db.query(await sql('.verify'));
  });
  it('rejects another quantity, date, technical version, client or bound commercial order', async () => {
    const f = await fixture();
    for (const change of [{ quantity: '40' }, { target: '2026-10-10' }, { version: randomUUID() }])
      await expect(insert(f, change)).rejects.toMatchObject({ code: '23514' });
    await db.query("UPDATE public.ordres_fabrication SET client_id='other' WHERE id=$1", [f.ofId]);
    await expect(insert(f)).rejects.toMatchObject({ code: '23514' });
    await db.query("UPDATE public.ordres_fabrication SET client_id='195',commande_id=1 WHERE id=$1", [f.ofId]);
    await expect(insert(f)).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects already started/output roots and superseded proposals', async () => {
    const f = await fixture();
    await db.query("UPDATE public.ordres_fabrication SET statut='EN_COURS' WHERE id=$1", [f.ofId]);
    await expect(insert(f)).rejects.toMatchObject({ code: '23514' });
    await db.query("UPDATE public.ordres_fabrication SET statut='BROUILLON' WHERE id=$1", [f.ofId]);
    await db.query("UPDATE public.client_contract_replenishment_plans SET status='SUPERSEDED' WHERE id=$1", [f.planId]);
    await expect(insert(f)).rejects.toMatchObject({ code: '23514' });
    const output = await fixture(); await db.query('INSERT INTO public.of_output_lots(of_id) VALUES($1)', [output.ofId]);
    await expect(insert(output)).rejects.toMatchObject({ code: '23514' });
  });
  it('allows one record only for a proposal during concurrent retries', async () => {
    const f = await fixture(); const outcomes = await Promise.allSettled([insert(f), insert(f)]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(x => x.status === 'rejected')).toMatchObject({ reason: { code: '23505' } });
    expect((await db.query('SELECT count(*)::int AS n FROM public.client_contract_replenishment_roots WHERE proposal_id=$1', [f.proposalId])).rows[0].n).toBe(1);
  });
  it('works under canonical application privileges without granting UPDATE on immutable proposals', async () => {
    const f = await fixture(), tx = await db.connect();
    try {
      await tx.query('BEGIN'); await tx.query('SET LOCAL ROLE cerp_app');
      await insert(f, {}, tx); await tx.query('COMMIT');
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    await expect(db.query('UPDATE public.client_contract_replenishment_roots SET quantity=40 WHERE proposal_id=$1', [f.proposalId]))
      .rejects.toMatchObject({ code: '55000' });
    const permissions = (await db.query("SELECT has_table_privilege('cerp_app','public.client_contract_replenishment_proposals','UPDATE') AS update_proposal")).rows[0];
    expect(permissions.update_proposal).toBe(false);
  });
  it('keeps launch acknowledgements immutable and forbids rollback after launch evidence', async () => {
    const f = await fixture(); await insert(f);
    await expect(db.query('DELETE FROM public.client_contract_replenishment_launches WHERE id=$1', [f.launchId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query(`INSERT INTO public.client_contract_replenishment_launches(plan_id,contract_id,actor_user_id,idempotency_key,
      request_hash,intent_snapshot_hash,result_payload) VALUES($1,$2,1,$3,$4,$5,'{}')`, [f.planId, f.contractId, f.key, 'b'.repeat(64), 'c'.repeat(64)]))
      .rejects.toMatchObject({ code: '23505' });
    const tx = await db.connect();
    try { await expect(tx.query(await sql('.rollback'))).rejects.toMatchObject({ code: 'P0001' }); }
    finally { await tx.query('ROLLBACK'); tx.release(); }
    await db.query(await sql('.verify'));
  });
  it('detects a missing INSERT privilege instead of accepting SELECT alone', async () => {
    await db.query('REVOKE INSERT ON public.client_contract_replenishment_roots FROM cerp_app');
    try { await expect(db.query(await sql('.verify'))).rejects.toMatchObject({ code: 'P0001' }); }
    finally { await db.query('GRANT INSERT ON public.client_contract_replenishment_roots TO cerp_app'); }
    await db.query(await sql('.verify'));
  });

  async function receive(ofId: string, quantity: string, assigned: string) {
    const receiptId = randomUUID();
    await db.query('INSERT INTO public.of_receipts VALUES($1,$2,$3)', [receiptId,ofId,quantity]);
    await db.query('INSERT INTO public.of_output_lots VALUES($1,$2)', [ofId,quantity]);
    if (assigned !== '0') await db.query('INSERT INTO public.production_receipt_lane_assignments VALUES($1,$2)', [receiptId,assigned]);
  }
  it('reads canonical unbound draft identities under application privileges in the caller transaction', async () => {
    const f = await fixture(); await insert(f); const tx = await db.connect();
    const evidenceId = (await db.query('SELECT id::text FROM public.client_contract_replenishment_roots WHERE root_of_id=$1',[f.ofId])).rows[0].id;
    try {
      await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); await tx.query('SET LOCAL ROLE cerp_app');
      const rows = await readReplenishmentProducerIntents(tx,[article.article_id],[]);
      expect(rows.find(row=>row.id===evidenceId)).toMatchObject({quantity:'20',target_date:'2026-09-30',status:'OPEN'});
      expect(rows.find(row=>row.coverage_source_ids.length)).toBeUndefined();
    } finally { await tx.query('ROLLBACK');tx.release(); }
  });
  it('keeps pending quality receipts under review and retires fully attributed closed production', async () => {
    const pending = await fixture(); await insert(pending);
    const pendingId = (await db.query('SELECT id::text FROM public.client_contract_replenishment_roots WHERE root_of_id=$1',[pending.ofId])).rows[0].id;
    await receive(pending.ofId,'10','5');
    expect((await readReplenishmentProducerIntents(db,[article.article_id],[])).find(row=>row.id===pendingId)?.status).toBe('REVIEW_REQUIRED');
    const finished = await fixture(); await insert(finished);
    const finishedId = (await db.query('SELECT id::text FROM public.client_contract_replenishment_roots WHERE root_of_id=$1',[finished.ofId])).rows[0].id;
    await receive(finished.ofId,'20','20');
    await db.query("UPDATE public.ordres_fabrication SET statut='CLOTURE' WHERE id=$1",[finished.ofId]);
    expect((await readReplenishmentProducerIntents(db,[article.article_id],[])).some(row=>row.id===finishedId)).toBe(false);
  });
  it('maps two anticipated roots to distinct active producer shares and preserves only each share receipt', async () => {
    const one = await fixture(),two = await fixture(); await insert(one);await insert(two);
    const ids = (await db.query('SELECT id::text,root_of_id::text FROM public.client_contract_replenishment_roots WHERE root_of_id=ANY($1::bigint[])',[[one.ofId,two.ofId]])).rows;
    const producer = (await db.query(`INSERT INTO public.ordres_fabrication(statut,article_id,piece_technique_id,piece_technique_version_id,
      quantite_lancee,client_id,created_by) VALUES('EN_COURS',$1,$2,$3,40,'195',1) RETURNING id::text`,
      [article.article_id,article.piece_technique_id,article.piece_technique_version_id])).rows[0].id;
    const groupId = randomUUID(),shareOne=randomUUID(),shareTwo=randomUUID();
    await db.query("INSERT INTO public.production_consolidations VALUES($1,$2,'ACTIVE')",[groupId,producer]);
    await db.query("INSERT INTO public.production_consolidation_allocations VALUES($1,$2,$3,20,20,'ACTIVE'),($4,$2,$5,20,10,'ACTIVE')",[shareOne,groupId,one.ofId,shareTwo,two.ofId]);
    await receive(producer,'30','30');
    const source = { id:`production:${producer}:share:${shareTwo}`,kind:'PRODUCTION' as const,article_id:article.article_id,unit:'U',
      quantity:'10',available_date:'2026-10-20',order_line_id:null,allocation_id:null,reference_id:producer,label:'Grouped fixture' };
    const rows = await readReplenishmentProducerIntents(db,[article.article_id],[source]);
    expect(rows.find(row=>row.id===ids.find(i=>i.root_of_id===one.ofId).id)).toMatchObject({ received_quantity:'20.000',received_reconciled:true,coverage_source_ids:[] });
    expect(rows.find(row=>row.id===ids.find(i=>i.root_of_id===two.ofId).id)).toMatchObject({ received_quantity:'10.000',received_reconciled:true,coverage_source_ids:[source.id] });
  });
});
