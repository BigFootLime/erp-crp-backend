import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.DELIVERY_PROMISE_1109_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let db: Pool;
let appPool: Pool;
let capture: typeof import('../module/affaire/repository/delivery-promises.repository').captureShipmentPromises;
let coverage: typeof import('../module/client/repository/client-contract-coverage.repository').readContractCoverageDemands;
const root = '11090000-0000-4000-8000-000000000001';
const part = '11090000-0000-4000-8000-000000000002';
const delivery = '11090000-0000-4000-8000-000000000003';
const allocation = '11090000-0000-4000-8000-000000000004';
const article = '11090000-0000-4000-8000-000000000005';
const movement = '11090000-0000-4000-8000-000000000006';
const movementLine = '11090000-0000-4000-8000-000000000007';
const coverageArticle = {article_id:article,root_article_id:article,code:'RF-1109',designation:'Fixture',piece_technique_id:root,piece_technique_version_id:part,indice:'A',unit_id:movement,unit:'U'};
const periods = [{month:'2026-12',target_date:'2026-11-30',end_date:'2026-12-31'}];
const repair = fs.readFileSync(path.resolve('db/patches/20261010_reservation_shipments_promises_1109.sql'),'utf8');

async function transaction(action: (tx: PoolClient)=>Promise<unknown>) {
  const tx=await db.connect();
  try { await tx.query('BEGIN'); const result=await action(tx); await tx.query('COMMIT'); return result; }
  catch(error) {await tx.query('ROLLBACK');throw error;} finally {tx.release();}
}
suite('delivery promise shipment #1109 — disposable PostgreSQL',()=>{
  beforeAll(async()=>{
    if(!url || process.env.DATABASE_URL!==url)throw Error('Isolated test URL must match DATABASE_URL');
    const parsed=new URL(url);
    if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/cerp_delivery_promises_1109_test')throw Error('Refusing ERP or non-loopback database');
    db=new Pool({connectionString:url});
    const database=await import('../config/database');appPool=database.default;
    capture=(await import('../module/affaire/repository/delivery-promises.repository')).captureShipmentPromises;
    coverage=(await import('../module/client/repository/client-contract-coverage.repository')).readContractCoverageDemands;
  });
  beforeEach(async()=>{
    await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE public.articles(id uuid,unite text);
      CREATE TABLE public.commande_client(id bigint,order_type text);
      CREATE TABLE public.commande_ligne(id bigint,commande_id bigint,article_id uuid,unite text,quantite numeric,delai_client date);
      CREATE TABLE public.commande_historique(id bigint,commande_id bigint,nouveau_statut text,date_action timestamptz);
      CREATE TABLE public.commande_ligne_affaire_allocation(id bigint,commande_ligne_id bigint,qty_ordered numeric,qty_delivered numeric);
      CREATE TABLE public.client_contract_call_lines(commande_ligne_id bigint,contract_id uuid,contract_line_id uuid);
      CREATE TABLE public.client_contract_legacy_lines(commande_ligne_id bigint,contract_id uuid,contract_line_id uuid);
      CREATE TABLE public.commande_cadre_release(id bigint,statut text);
      CREATE TABLE public.commande_cadre_release_ligne(release_id bigint,commande_ligne_id bigint,quantite numeric);
      CREATE TABLE public.client_contracts(id uuid,client_id text,status text);
      CREATE TABLE public.client_contract_lines(id uuid,active boolean);
      CREATE TABLE public.client_contract_forecasts(id uuid,contract_id uuid,contract_line_id uuid,root_article_id uuid,unit_id uuid,quantity numeric,month date,delivery_due date,status text);
      CREATE VIEW public.v_client_contract_forecast_coverage AS SELECT id AS forecast_id,quantity AS remaining_quantity FROM public.client_contract_forecasts;
      CREATE TABLE public.stock_reservations(id uuid,commande_ligne_id bigint);
      CREATE TABLE public.bon_livraison(id uuid PRIMARY KEY,statut text,shipped_at timestamptz);
      CREATE TABLE public.bon_livraison_ligne(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bon_livraison_id uuid,commande_ligne_id bigint);
      CREATE TABLE public.bon_livraison_ligne_allocations(id uuid PRIMARY KEY,bon_livraison_ligne_id uuid,commande_ligne_affaire_allocation_id bigint,quantite numeric,qty_consumed numeric,reservation_id uuid,stock_movement_line_id uuid);
      CREATE TABLE public.bon_livraison_ship_receipts(id uuid DEFAULT gen_random_uuid(),bon_livraison_id uuid,result_payload jsonb);
      CREATE TABLE public.stock_movements(id uuid PRIMARY KEY,status text,movement_type text,source_document_type text,source_document_id text);
      CREATE TABLE public.stock_movement_lines(id uuid PRIMARY KEY,movement_id uuid,qty numeric);
      CREATE TABLE public.delivery_promise_roots(id uuid PRIMARY KEY,allocation_id bigint,initial_quantity numeric,created_at timestamptz);
      CREATE TABLE public.delivery_promise_parts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),root_id uuid,quantity numeric,due_date date,revision_event_id uuid,retired_at timestamptz,created_at timestamptz);
      CREATE TABLE public.delivery_promise_shipments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),part_id uuid,bl_allocation_id uuid,quantity numeric,due_date_at_shipment date,created_at timestamptz DEFAULT now(),UNIQUE(part_id,bl_allocation_id));
      CREATE FUNCTION public.guard_delivery_promise_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Delivery promise evidence is immutable'; END $$;`);
    await db.query(`INSERT INTO public.articles VALUES($1,'u')`,[article]);
    await db.query(`INSERT INTO public.commande_client VALUES(42,'FERME'); INSERT INTO public.commande_ligne_affaire_allocation VALUES(95,209,2,2)`);
    await db.query(`INSERT INTO public.commande_ligne VALUES(209,42,$1,'u',2,'2026-10-16')`,[article]);
    await db.query(`INSERT INTO public.delivery_promise_roots VALUES($1,95,2,'2026-10-10 12:00Z')`,[root]);
    await db.query(`INSERT INTO public.delivery_promise_parts(id,root_id,quantity,due_date,created_at) VALUES($1,$2,2,'2026-10-16','2026-10-10 12:00Z')`,[part,root]);
    await db.query(`INSERT INTO public.bon_livraison VALUES($1,'SHIPPED','2026-10-10 16:00Z')`,[delivery]);
    await db.query(`WITH line AS (INSERT INTO public.bon_livraison_ligne(bon_livraison_id,commande_ligne_id) VALUES($1,209) RETURNING id)
      INSERT INTO public.bon_livraison_ligne_allocations SELECT $2,id,95,2,2,NULL,$3 FROM line`,[delivery,allocation,movementLine]);
    await db.query(`INSERT INTO public.bon_livraison_ship_receipts(bon_livraison_id,result_payload) VALUES($1,'{"statut":"SHIPPED"}')`,[delivery]);
    await db.query(`INSERT INTO public.stock_movements VALUES($1,'POSTED','OUT','BON_LIVRAISON',$2)`,[movement,delivery]);
    await db.query(`INSERT INTO public.stock_movement_lines VALUES($1,$2,2)`,[movementLine,movement]);
  });
  it('captures once on retry and removes fully shipped firm demand',async()=>{
    await transaction(async tx=>{await capture(tx,delivery);await capture(tx,delivery);});
    expect((await db.query('SELECT quantity::text,due_date_at_shipment::text AS due_date FROM public.delivery_promise_shipments')).rows).toEqual([{quantity:'2',due_date:'2026-10-16'}]);
    const demands=await coverage(db,[coverageArticle],periods);
    expect(demands.demands).toEqual([]);
  });
  it('reproduces the coverage refusal before capture',async()=>{
    await expect(coverage(db,[coverageArticle],periods)).rejects.toMatchObject({code:'CONTRACT_COVERAGE_DELIVERY_REVIEW_REQUIRED'});
  });
  it('uses revised due dates of partial parts and preserves original part',async()=>{
    await db.query(`UPDATE public.delivery_promise_parts SET retired_at='2026-10-10 14:00Z' WHERE id=$1`,[part]);
    await db.query(`INSERT INTO public.delivery_promise_parts(root_id,quantity,due_date,revision_event_id,created_at) VALUES($1,1,'2026-10-11',$2,'2026-10-10 14:00Z'),($1,1,'2026-10-20',$2,'2026-10-10 14:00Z')`,[root,movement]);
    await transaction(tx=>capture(tx,delivery));
    expect((await db.query('SELECT quantity::text,due_date_at_shipment::text AS due_date FROM public.delivery_promise_shipments ORDER BY due_date_at_shipment')).rows).toEqual([{quantity:'1',due_date:'2026-10-11'},{quantity:'1',due_date:'2026-10-20'}]);
    expect((await db.query('SELECT quantity::text,due_date::text AS due_date FROM public.delivery_promise_parts WHERE id=$1',[part])).rows).toEqual([{quantity:'2',due_date:'2026-10-16'}]);
  });
  it('rolls back an insufficient promise instead of partially recording it',async()=>{
    await db.query('UPDATE public.delivery_promise_parts SET quantity=1');
    await expect(transaction(tx=>capture(tx,delivery))).rejects.toMatchObject({code:'PROMISE_SHIPMENT_EXCEEDS_ORDER'});
    expect((await db.query('SELECT count(*)::int AS count FROM public.delivery_promise_shipments')).rows[0].count).toBe(0);
  });
  it('appends proven historical capture without another stock movement',async()=>{
    await db.query(repair);
    expect((await db.query('SELECT status,reason FROM public.delivery_promise_shipment_reconciliations')).rows).toEqual([{status:'CAPTURED',reason:'PROVEN_UNCHANGED_INITIAL_PROMISE'}]);
    await transaction(tx=>capture(tx,delivery));
    expect((await db.query('SELECT count(*)::int AS count FROM public.delivery_promise_shipments')).rows[0].count).toBe(1);
    expect((await db.query('SELECT count(*)::int AS count FROM public.stock_movements')).rows[0].count).toBe(1);
  });
  it.each([
    ["DELETE FROM public.bon_livraison_ship_receipts",'CANONICAL_SHIPMENT_RECEIPT_REQUIRED'],
    ["UPDATE public.stock_movements SET status='DRAFT'",'POSTED_RESERVATION_CONSUMPTION_REQUIRED'],
    ["UPDATE public.delivery_promise_roots SET created_at='2026-10-10 17:00Z'",'PROMISE_NOT_PROVEN_AT_SHIPMENT'],
    ["UPDATE public.delivery_promise_parts SET revision_event_id='11090000-0000-4000-8000-000000000006'",'UNCHANGED_INITIAL_PART_REQUIRED'],
    ["UPDATE public.delivery_promise_parts SET quantity=1",'UNCHANGED_INITIAL_PART_REQUIRED'],
  ])('records an explicit review without guessing for %s',async(sql,reason)=>{
    await db.query(sql);await db.query(repair);
    expect((await db.query('SELECT status,reason FROM public.delivery_promise_shipment_reconciliations')).rows).toEqual([{status:'REVIEW_REQUIRED',reason}]);
    expect((await db.query('SELECT count(*)::int AS count FROM public.delivery_promise_shipments')).rows[0].count).toBe(0);
  });
  it('retains partial evidence as an explicit review',async()=>{
    await db.query(`INSERT INTO public.delivery_promise_shipments(part_id,bl_allocation_id,quantity,due_date_at_shipment) VALUES($1,$2,1,'2026-10-16')`,[part,allocation]);
    await db.query(repair);
    expect((await db.query('SELECT reason FROM public.delivery_promise_shipment_reconciliations')).rows[0].reason).toBe('PARTIAL_CAPTURE_REQUIRES_REVIEW');
    expect((await db.query('SELECT sum(quantity)::text AS quantity FROM public.delivery_promise_shipments')).rows[0].quantity).toBe('1');
  });
  it('keeps the reconciliation journal immutable',async()=>{
    await db.query(repair);
    await expect(db.query("UPDATE public.delivery_promise_shipment_reconciliations SET status='REVIEW_REQUIRED'")).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM public.delivery_promise_shipment_reconciliations')).rejects.toThrow('immutable');
  });
});
afterAll(async()=>{await appPool?.end();await db?.end();});
