import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_PIECE_PLANS_SQL } from "../module/pieces-techniques/repository/canonical-piece-plans.sql";

const url = process.env.CERP_PIECE_PLANS_PG_URL;
if (url && (process.env.CERP_E2E_ISOLATED !== "1" || new URL(url).pathname !== "/canonical_piece_plans_1155")) {
  throw new Error("Canonical plan tests require the named disposable database");
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe.skipIf(!url)("published revision plans — real isolated PostgreSQL", () => {
  const db = new Pool({ connectionString: url, max: 1 });
  const read = () => db.query(CANONICAL_PIECE_PLANS_SQL, [id(1)]);
  beforeAll(async () => {
    expect((await db.query("SELECT current_database() AS name")).rows[0].name).toBe("canonical_piece_plans_1155");
    await db.query("BEGIN");
    await db.query(`
      CREATE TABLE public.piece_technique_versions(id uuid PRIMARY KEY,piece_technique_id uuid);
      CREATE TABLE public.ged_documents(id uuid PRIMARY KEY,current_version_id uuid,class_key text,archived_at timestamptz);
      CREATE TABLE public.ged_document_versions(id uuid PRIMARY KEY,original_name text,blob_id uuid,upload_session_id uuid,status text,created_at timestamptz);
      CREATE TABLE public.ged_blobs(id uuid PRIMARY KEY,mime_type text,size_bytes bigint);
      CREATE TABLE public.ged_upload_sessions(id uuid PRIMARY KEY,scan_status text,quarantine_status text);
      CREATE TABLE public.ged_document_links(id uuid PRIMARY KEY,document_id uuid,entity_type text,entity_id text,link_role text);
      CREATE TABLE public.pieces_techniques_documents(id uuid PRIMARY KEY,piece_technique_id uuid,document_type_code text);
    `);
    await db.query("INSERT INTO public.piece_technique_versions VALUES($1,$2),($3,$2),($4,$5)",[id(11),id(1),id(12),id(13),id(2)]);
    await db.query("INSERT INTO public.ged_documents VALUES($1,$2,'PLAN_CLIENT',NULL)",[id(101),id(201)]);
    await db.query("INSERT INTO public.ged_document_versions VALUES($1,'plan.pdf',$2,$3,'APPLICABLE','2026-10-11T00:00:00Z')",[id(201),id(301),id(401)]);
    await db.query("INSERT INTO public.ged_blobs VALUES($1,'application/pdf',2396)",[id(301)]);
    await db.query("INSERT INTO public.ged_upload_sessions VALUES($1,'clean','released')",[id(401)]);
    await db.query("INSERT INTO public.ged_document_links VALUES($1,$2,'PIECE_TECHNIQUE_VERSION',$3,'PLAN_CLIENT')",[id(501),id(101),id(11)]);
    await db.query("SAVEPOINT clean_plan");
  });
  beforeEach(async () => { await db.query("ROLLBACK TO SAVEPOINT clean_plan"); });
  afterAll(async () => { await db.query("ROLLBACK"); await db.end(); });
  it("returns the exact published version and GED content descriptor", async () => {
    expect((await read()).rows).toEqual([expect.objectContaining({id:id(101),ged_version_id:id(201),content_source:"GED",document_type_code:"PLAN",piece_technique_version_id:id(11),size_bytes:"2396"})]);
  });
  it.each(["BROUILLON","EN_REVUE","APPROUVE","OBSOLETE"])("does not treat %s as a production plan",async status => {
    await db.query("UPDATE public.ged_document_versions SET status=$1",[status]); expect((await read()).rows).toHaveLength(0);
  });
  it.each([["pending","quarantined"],["infected","quarantined"],["scan_failed","quarantined"],["clean","quarantined"]])("rejects scan %s / quarantine %s",async(scan,quarantine)=>{
    await db.query("UPDATE public.ged_upload_sessions SET scan_status=$1,quarantine_status=$2",[scan,quarantine]);expect((await read()).rows).toHaveLength(0);
  });
  it("keeps archives out of readiness and ignores whole-piece / wrong-role links",async()=>{
    await db.query("INSERT INTO public.pieces_techniques_documents VALUES($1,$2,'PLAN')",[id(601),id(1)]);
    await db.query("UPDATE public.ged_document_links SET entity_type='PIECE_TECHNIQUE',entity_id=$1",[id(1)]);expect((await read()).rows).toHaveLength(0);
    await db.query("UPDATE public.ged_document_links SET entity_type='PIECE_TECHNIQUE_VERSION',entity_id=$1,link_role='DOCUMENT'",[id(11)]);expect((await read()).rows).toHaveLength(0);
  });
  it("excludes archived / foreign-piece documents and preserves multiple valid revision links once each",async()=>{
    await db.query("UPDATE public.ged_documents SET archived_at=now()");expect((await read()).rows).toHaveLength(0);
    await db.query("UPDATE public.ged_documents SET archived_at=NULL");
    await db.query("UPDATE public.ged_document_links SET entity_id=$1",[id(13)]);expect((await read()).rows).toHaveLength(0);
    await db.query("UPDATE public.ged_document_links SET entity_id=$1",[id(11)]);
    await db.query("INSERT INTO public.ged_document_links VALUES($1,$2,'PIECE_TECHNIQUE_VERSION',$3,'PLAN')",[id(502),id(101),id(11)]);
    await db.query("INSERT INTO public.ged_document_links VALUES($1,$2,'PIECE_TECHNIQUE_VERSION',$3,'TECHNICAL_DRAWING')",[id(503),id(101),id(12)]);
    expect((await read()).rows.map(row=>row.piece_technique_version_id).sort()).toEqual([id(11),id(12)]);
  });
});
