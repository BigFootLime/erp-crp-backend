import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoCreateHistoricalImportTx } from "../../../stock/repository/stock.repository";

const integrationUrl = process.env.CERP_CUTOVER_INTEGRATION_URL;
const describePg = integrationUrl ? describe : describe.skip;
const ids = {
  article: "11111111-1111-4111-8111-111111111111",
  unit: "22222222-2222-4222-8222-222222222222",
  warehouse: "33333333-3333-4333-8333-333333333333",
};
let db: Pool;

function requireDedicatedDb() {
  if (!integrationUrl || process.env.DATABASE_URL !== integrationUrl) throw new Error("La base dédiée est requise");
  const url = new URL(integrationUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "55471" || url.pathname !== "/cerp_cutover_1710") throw new Error("Base locale dédiée invalide");
}

async function installStockFixture(pool: Pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY, username text NOT NULL);
    INSERT INTO public.users(id,username) VALUES(1,'CUTOVER_TEST') ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS public.issued_code_counters(code_key text PRIMARY KEY,value bigint NOT NULL);
    CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_key text) RETURNS bigint LANGUAGE plpgsql AS $$
      DECLARE next_value bigint; BEGIN
        INSERT INTO public.issued_code_counters(code_key,value) VALUES(p_key,1)
        ON CONFLICT(code_key) DO UPDATE SET value=public.issued_code_counters.value+1
        RETURNING value INTO next_value; RETURN next_value;
      END $$;
    CREATE SEQUENCE IF NOT EXISTS public.stock_trace_code_446_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS public.stock_movement_no_seq START 1;
    CREATE TABLE IF NOT EXISTS public.stock_nuances(id uuid PRIMARY KEY,code text);
    CREATE TABLE IF NOT EXISTS public.articles_matiere(article_id uuid PRIMARY KEY,nuance_id uuid);
    CREATE TABLE IF NOT EXISTS public.articles(id uuid PRIMARY KEY,code text,designation text);
    ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS article_category text;
    ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS stock_managed boolean NOT NULL DEFAULT true;
    ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS lot_tracking boolean NOT NULL DEFAULT true;
    ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS unite text;
    ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS piece_technique_id uuid NULL;
    CREATE TABLE IF NOT EXISTS public.units(code text PRIMARY KEY,label text);
    ALTER TABLE public.units ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
    UPDATE public.units SET id=gen_random_uuid() WHERE id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS cutover_test_units_id_uq ON public.units(id);
    CREATE TABLE IF NOT EXISTS public.warehouses(id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.magasins(id uuid PRIMARY KEY,code text UNIQUE,code_magasin text,warehouse_id uuid,is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE IF NOT EXISTS public.locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),warehouse_id uuid NOT NULL,code text NOT NULL,description text,UNIQUE(warehouse_id,code));
    CREATE TABLE IF NOT EXISTS public.emplacements(
      id bigserial PRIMARY KEY,magasin_id uuid NOT NULL,location_id uuid NULL,code text NOT NULL,name text,
      is_scrap boolean NOT NULL DEFAULT false,is_active boolean NOT NULL DEFAULT true,location_type text NOT NULL DEFAULT 'STORAGE',
      allow_inbound boolean NOT NULL DEFAULT true,allow_outbound boolean NOT NULL DEFAULT true,restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by integer,updated_by integer,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(magasin_id,code)
    );
    CREATE TABLE IF NOT EXISTS public.lots(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),article_id uuid NOT NULL,lot_code text NOT NULL,supplier_lot_code text,
      notes text,stock_trace_code text,qr_payload text,origin_stock_scope text,source_scope text,stock_scope text,lot_status text,
      piece_technique_version_id uuid,client_proprietaire_id varchar,created_by integer,updated_by integer,UNIQUE(article_id,lot_code)
    );
    ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS material_properties jsonb;
    CREATE TABLE IF NOT EXISTS public.stock_lot_trace_references(
      lot_id uuid NOT NULL,reference_type text NOT NULL CHECK(reference_type IN ('OF','MP_LOT','TRAITEMENT_LOT','HISTORICAL_LOT')),
      reference_value text NOT NULL,created_by integer,UNIQUE(lot_id,reference_type,reference_value)
    );
    CREATE TABLE IF NOT EXISTS public.stock_levels(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),article_id uuid NOT NULL,unit_id uuid NOT NULL,warehouse_id uuid NOT NULL,location_id uuid NOT NULL,
      managed_in_stock boolean NOT NULL DEFAULT true,created_by integer,updated_by integer,UNIQUE(article_id,location_id)
    );
    CREATE TABLE IF NOT EXISTS public.stock_batches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),stock_level_id uuid NOT NULL,batch_code text NOT NULL,lot_id uuid,UNIQUE(stock_level_id,batch_code)
    );
    CREATE TABLE IF NOT EXISTS public.stock_movements(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),movement_no text NOT NULL,movement_type text NOT NULL,status text NOT NULL,article_id uuid NOT NULL,
      stock_level_id uuid NOT NULL,stock_batch_id uuid,qty numeric NOT NULL,currency text,effective_at timestamptz,posted_at timestamptz,
      posted_by integer,source_document_type text,reason_code text,notes text,correlation_id uuid,user_id integer,created_by integer,updated_by integer
    );
    CREATE TABLE IF NOT EXISTS public.stock_movement_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),movement_id uuid NOT NULL,line_no integer NOT NULL,article_id uuid NOT NULL,lot_id uuid,qty numeric NOT NULL,
      unite text,dst_magasin_id uuid,dst_emplacement_id bigint,created_by integer,updated_by integer,UNIQUE(movement_id,line_no)
    );
    CREATE TABLE IF NOT EXISTS public.stock_movement_event_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),stock_movement_id uuid,event_type text,old_values jsonb,new_values jsonb,user_id integer,created_by integer,updated_by integer);
    CREATE TABLE IF NOT EXISTS public.stock_command_receipts(actor_user_id integer NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,command_type text NOT NULL,resource_type text NOT NULL,resource_id text NOT NULL,request_payload jsonb,result_payload jsonb,correlation_id uuid NOT NULL,UNIQUE(actor_user_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS public.erp_audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id integer,event_type text,action text,page_key text,entity_type text,entity_id text,path text,client_session_id text,ip text,user_agent text,device_type text,os text,browser text,details jsonb,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS public.realtime_stream_enqueue_state(stream_id text PRIMARY KEY,next_ordinal bigint NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS public.erp_outbox_events(event_key text PRIMARY KEY,aggregate_type text,aggregate_id text,event_type text,payload jsonb,correlation_id uuid,status text,available_at timestamptz,realtime_stream_id text,realtime_stream_ordinal bigint);
  `);
}

const audit={user_id:1,ip:null,user_agent:null,device_type:null,os:null,browser:null,path:"/test",page_key:"cutover",client_session_id:null};
describePg("native OLD opening PostgreSQL", () => {
  beforeAll(async()=>{ requireDedicatedDb(); db=new Pool({connectionString:integrationUrl}); if ((await db.query("SELECT current_database() AS name")).rows[0]?.name !== "cerp_cutover_1710") throw new Error("Unexpected fixture identity"); await installStockFixture(db); });
  beforeEach(async()=>{
    // Audit evidence stays append-only, including in this disposable fixture.
    await db.query(`TRUNCATE public.stock_movement_lines,public.stock_movement_event_log,public.stock_movements,public.stock_batches,public.stock_levels,public.stock_lot_trace_references,public.lots,public.stock_command_receipts,public.erp_outbox_events,public.realtime_stream_enqueue_state,public.emplacements,public.locations,public.magasins,public.warehouses,public.articles_matiere,public.articles,public.units RESTART IDENTITY CASCADE`);
    await db.query("INSERT INTO public.units(id,code,label) VALUES($1,'kg','Kilogramme')",[ids.unit]);
    await db.query("INSERT INTO public.articles(id,article_category,stock_managed,lot_tracking,unite) VALUES($1,'matiere',true,true,'kg')",[ids.article]);
    await db.query("INSERT INTO public.warehouses(id) VALUES($1)",[ids.warehouse]);
    await db.query("INSERT INTO public.magasins(id,code,warehouse_id) VALUES('44444444-4444-4444-8444-444444444444','OLD-MP',$1)",[ids.warehouse]);
  });
  afterAll(async()=>{ await db?.end(); });
  it("posts one OLD native lot with quality, owner and provenance; replay is idempotent",async()=>{
    const body={kind:"MP" as const,article_id:ids.article,quantity:12.5,unite:"kg",lot_number:"FOU-LOT-7",historical_lot_reference:"CLIPPER-LOT-7",historical_shelf:"RACK-A",historical_lot_status:"LIBERE" as const,owner_client_id:"001",notes:"preuve synthétique"};
    const client=await db.connect(); let first;
    try { await client.query("BEGIN"); first=await repoCreateHistoricalImportTx(client,body,audit,"cutover-old-native-1"); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const replayClient=await db.connect(); let replay;
    try { await replayClient.query("BEGIN"); replay=await repoCreateHistoricalImportTx(replayClient,body,audit,"cutover-old-native-1"); await replayClient.query("COMMIT"); } catch (error) { await replayClient.query("ROLLBACK"); throw error; } finally { replayClient.release(); }
    expect(replay.replayed).toBe(true); expect(replay.lot_id).toBe(first!.lot_id);
    expect((await db.query("SELECT stock_scope,lot_status,client_proprietaire_id FROM public.lots")).rows).toEqual([{stock_scope:"OLD",lot_status:"LIBERE",client_proprietaire_id:"001"}]);
    expect((await db.query("SELECT reference_type,reference_value FROM public.stock_lot_trace_references ORDER BY reference_type")).rows).toEqual([{reference_type:"HISTORICAL_LOT",reference_value:"CLIPPER-LOT-7"},{reference_type:"MP_LOT",reference_value:"FOU-LOT-7"}]);
    expect(Number((await db.query("SELECT count(*)::int AS count FROM public.stock_movements")).rows[0].count)).toBe(1);
  });
  it("rolls back the native lot, movement and command receipt together",async()=>{
    const body={kind:"MP" as const,article_id:ids.article,quantity:1,unite:"kg",lot_number:"ROLLBACK-LOT",historical_lot_reference:"ROLLBACK-SOURCE",historical_shelf:"RACK-B",historical_lot_status:"QUARANTAINE" as const,owner_client_id:"001"};
    const client=await db.connect();
    try {
      await client.query("BEGIN");
      await repoCreateHistoricalImportTx(client,body,audit,"cutover-old-rollback-1");
      await client.query("ROLLBACK");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    for (const table of ["lots","stock_movements","stock_command_receipts"]) {
      expect(Number((await db.query(`SELECT count(*)::int AS count FROM public.${table}`)).rows[0].count)).toBe(0);
    }
  });
});
