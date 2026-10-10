import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareContractReplenishmentSnapshot } from '../module/client/domain/client-contract-replenishment-preparation';
import { appendReplenishmentEvent, insertReplenishmentPlan, readReplenishmentPlan, readReplenishmentReplay } from '../module/client/repository/client-contract-replenishment.repository';
import type { ContractCoverageResult } from '../module/client/types/client-contract-coverage.types';
import type { PreparedContractReplenishmentProposal } from '../module/client/types/client-contract-replenishment.types';

// A deliberately empty disposable database: never cerp_test, cerp_prod or an existing application schema.
const url = process.env.CLIENT_REPLENISHMENT_1032_TEST_DATABASE_URL;
describe.skipIf(!url)('replenishment preparation PostgreSQL 17 evidence', () => {
  const db = new Pool({ connectionString: url, max: 4 });
  const article = { article_id: randomUUID(), root_article_id: randomUUID(), code: 'TEST-PF-A', designation: 'Axe fictif',
    piece_technique_id: randomUUID(), piece_technique_version_id: randomUUID(), indice: 'A', unit_id: randomUUID(), unit: 'U' };
  const filename = '20261010_client_replenishment_preparations_1032';
  const sql = (suffix: string) => readFile(`db/patches/${suffix ? 'support/' : ''}${filename}${suffix}.sql`, 'utf8');
  beforeAll(async () => {
    const info = (await db.query(`SELECT current_database() AS name,current_setting('server_version_num')::integer AS version,
      to_regclass('public.client_contracts') AS application_schema`)).rows[0];
    if (info.name !== 'cerp_replenishment_1032_test' || info.version < 170000 || info.application_schema)
      throw new Error('Use an empty disposable PostgreSQL 17 cerp_replenishment_1032_test database; real ERP databases are forbidden.');
    await db.query(`CREATE ROLE cerp_app NOLOGIN;
      CREATE TABLE public.users(id integer PRIMARY KEY,username text NOT NULL);
      CREATE TABLE public.units(id uuid PRIMARY KEY);
      CREATE TABLE public.articles(id uuid PRIMARY KEY);
      CREATE TABLE public.client_contracts(id uuid PRIMARY KEY);
      CREATE TABLE public.client_contract_lines(id uuid NOT NULL,contract_id uuid NOT NULL REFERENCES public.client_contracts(id),
        root_article_id uuid NOT NULL REFERENCES public.articles(id),unit_id uuid NOT NULL REFERENCES public.units(id),PRIMARY KEY(id,contract_id));
      CREATE TABLE public.client_contract_forecasts(id uuid PRIMARY KEY);
      CREATE TABLE public.client_forecast_call_allocations(id uuid PRIMARY KEY);
      CREATE FUNCTION public.fn_protect_stock_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
      INSERT INTO public.users VALUES(1,'Test Author');`);
    await db.query('INSERT INTO public.units(id) VALUES($1)', [article.unit_id]);
    await db.query('INSERT INTO public.articles(id) VALUES($1),($2)', [article.article_id, article.root_article_id]);
    await db.query(await sql('.preflight')); await db.query(await sql('')); await db.query(await sql('.verify'));
    await db.query(await sql('.rollback')); // Proven reversible only while unused.
    await db.query(await sql(''));
  }, 30000);
  afterAll(async () => { await db.end(); });

  async function fixture() {
    const contractId = randomUUID(), lineId = randomUUID(), id = randomUUID();
    await db.query('INSERT INTO public.client_contracts VALUES($1)', [contractId]);
    await db.query('INSERT INTO public.client_contract_lines VALUES($1,$2,$3,$4)', [lineId, contractId, article.root_article_id, article.unit_id]);
    const report: ContractCoverageResult = { contract_id: contractId, contract_version: 1, generated_at: '2026-10-10T08:00:00Z',
      planning_revision: null, start_month: '2026-10', months: 3, readonly: true, snapshot_hash: 'a'.repeat(64),
      lines: [{ contract_line_id: lineId, replenishment_qty: '20', article, months: [], replenishment_projection: [{
        month: '2026-10', target_date: '2026-09-30', uncovered_quantity: '17', carried_quantity: '0', lot_count: '1',
        lot_quantity: '20', proposed_quantity: '20', surplus_quantity: '3', target_overdue: true,
      }] }], demands: [], sources: [], allocations: [], issues: [] };
    const preparation = prepareContractReplenishmentSnapshot(report, '2026-10-10');
    const proposals = preparation.proposals.map(proposal => ({ ...proposal, id: randomUUID(), plan_id: id }));
    return { id, actor: 1, previousId: null, preparation, proposals };
  }
  const insertProposal = (proposal: PreparedContractReplenishmentProposal, contractId: string) => db.query(`INSERT INTO
    public.client_contract_replenishment_proposals(id,plan_id,contract_id,contract_line_id,article_id,root_article_id,unit_id,
      article_snapshot,month,target_date,target_overdue,lot_quantity,lot_count,proposed_quantity,surplus_quantity)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::date,$10::date,$11,$12,$13,$14,$15)`,
  [proposal.id, proposal.plan_id, contractId, proposal.contract_line_id, proposal.article.article_id, proposal.article.root_article_id,
    proposal.article.unit_id, JSON.stringify(proposal.article), proposal.month + '-01', proposal.target_date, proposal.target_overdue,
    proposal.lot_quantity, proposal.lot_count, proposal.proposed_quantity, proposal.surplus_quantity]);

  it('stores exact numeric quantities and retained technical identity through the real repository SQL', async () => {
    const input = await fixture(); await insertReplenishmentPlan(db, input);
    const plan = await readReplenishmentPlan(db, input.preparation.report.contract_id);
    expect(plan).toMatchObject({ id: input.id, purpose: 'PREPARATION_ONLY', status: 'CURRENT', actor_label: 'Test Author' });
    expect(plan!.proposals[0]).toMatchObject({ article, lot_count: '1', lot_quantity: '20.000', proposed_quantity: '20.000',
      surplus_quantity: '3.000', target_date: '2026-09-30', target_overdue: true });
    await db.query(await sql('.verify'));
  });
  it('rejects changing or deleting evidence and only permits one-way plan supersession', async () => {
    const input = await fixture(); await insertReplenishmentPlan(db, input);
    const planId = input.id, proposalId = input.proposals[0].id;
    await expect(db.query('UPDATE public.client_contract_replenishment_proposals SET proposed_quantity=40,lot_count=2 WHERE id=$1', [proposalId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM public.client_contract_replenishment_plans WHERE id=$1', [planId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('UPDATE public.client_contract_replenishment_plans SET fingerprint=$2 WHERE id=$1', [planId, 'b'.repeat(64)]))
      .rejects.toMatchObject({ code: '55000' });
    await db.query("UPDATE public.client_contract_replenishment_plans SET status='SUPERSEDED' WHERE id=$1", [planId]);
    await expect(db.query("UPDATE public.client_contract_replenishment_plans SET status='CURRENT' WHERE id=$1", [planId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('UPDATE public.client_contract_lines SET root_article_id=$2 WHERE id=$1', [input.proposals[0].contract_line_id, article.article_id]))
      .rejects.toMatchObject({ code: '55000' });
  });
  it('rejects mismatched quantity, original target, horizon and snapshot unit', async () => {
    const input = await fixture(); await insertReplenishmentPlan(db, input);
    const base = { ...input.proposals[0], month: '2026-11', target_date: '2026-10-31', target_overdue: false }, contractId = input.preparation.report.contract_id;
    for (const variation of [ { lot_count: '2', proposed_quantity: '39' }, { month: '2027-01', target_date: '2026-12-31', target_overdue: false },
      { target_date: '2026-10-01' }, { target_overdue: true }, { article: { ...article, unit_id: randomUUID() } } ])
      await expect(insertProposal({ ...base, ...variation, id: randomUUID() }, contractId)).rejects.toMatchObject({ code: '23514' });
    expect((await db.query('SELECT count(*)::int AS n FROM public.client_contract_replenishment_proposals WHERE plan_id=$1', [input.id])).rows[0].n).toBe(1);
  });
  it('keeps exactly one current preparation during concurrent submissions', async () => {
    const input = await fixture(), otherId = randomUUID();
    const other = { ...input, id: otherId, proposals: input.proposals.map(proposal => ({ ...proposal, id: randomUUID(), plan_id: otherId })) };
    const outcomes = await Promise.allSettled([insertReplenishmentPlan(db, input), insertReplenishmentPlan(db, other)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { code: '23505', constraint: 'client_replenishment_current_plan_idx' } });
    expect((await db.query("SELECT count(*)::int AS n FROM public.client_contract_replenishment_plans WHERE contract_id=$1 AND status='CURRENT'",
      [input.preparation.report.contract_id])).rows[0].n).toBe(1);
  });
  it('keeps the original retry result immutable and refuses rollback after preparation evidence exists', async () => {
    const input = await fixture(); await insertReplenishmentPlan(db, input);
    const contractId = input.preparation.report.contract_id, plan = (await readReplenishmentPlan(db, contractId))!;
    const event = { eventId: randomUUID(), contractId, actor: 1, key: randomUUID(), hash: 'c'.repeat(64), previousId: null,
      result: { event_id: randomUUID(), unchanged: false, plan } };
    await appendReplenishmentEvent(db, event);
    expect(await readReplenishmentReplay(db, 1, event.key)).toEqual({ request_hash: event.hash, result_payload: event.result });
    await expect(appendReplenishmentEvent(db, { ...event, eventId: randomUUID() })).rejects.toMatchObject({ code: '23505' });
    await expect(db.query('DELETE FROM public.client_contract_replenishment_events WHERE id=$1', [event.eventId])).rejects.toMatchObject({ code: '55000' });
    // Keep this failed rollback on one connection, then explicitly close its aborted transaction.
    const tx = await db.connect();
    try { await expect(tx.query(await sql('.rollback'))).rejects.toMatchObject({ code: 'P0001' }); }
    finally { await tx.query('ROLLBACK'); tx.release(); }
    await db.query(await sql('.verify'));
  });
});
