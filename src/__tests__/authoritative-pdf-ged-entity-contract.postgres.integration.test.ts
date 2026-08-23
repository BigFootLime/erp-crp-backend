import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationUrl = process.env.AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_TEST_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;
const root = process.cwd();
const base = "20260823_authoritative_pdf_ged_entity_contract";
const requiredTypes = ["BON_LIVRAISON", "DEVIS", "COMMANDE_FOURNISSEUR", "FACTURE", "AVOIR"];

suite("authoritative PDF/GED entity contract: PostgreSQL migration", () => {
  let client: import("pg").Client;
  let patch: string;
  let preflight: string;
  let verify: string;
  let rollback: string;

  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.Client({ connectionString: integrationUrl });
    await client.connect();
    const database = await client.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) {
      throw new Error("AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_TEST_DATABASE_URL must target a test/local/sandbox database");
    }
    [patch, preflight, verify, rollback] = await Promise.all([
      fs.readFile(path.join(root, "db/patches", `${base}.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${base}.preflight.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${base}.verify.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${base}.rollback.sql`), "utf8"),
    ]);
  });

  afterAll(async () => { await client?.end(); });

  it("registers all canonical parents, enforces the trigger, verifies exact state, and rolls back only while unused", async () => {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(`
      CREATE TABLE public.ged_entity_types (
        entity_type text PRIMARY KEY CHECK (entity_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
        label text NOT NULL, module_key text NOT NULL, target_table text NOT NULL,
        target_pk_column text NOT NULL, sort_order integer NOT NULL DEFAULT 100,
        is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.ged_entity_class_bindings (entity_type text NOT NULL REFERENCES public.ged_entity_types(entity_type));
      CREATE TABLE public.ged_document_links (id uuid PRIMARY KEY, document_id uuid NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL);
      CREATE TABLE public.bon_livraison (id uuid PRIMARY KEY);
      CREATE TABLE public.devis (id bigint PRIMARY KEY);
      CREATE TABLE public.commande_fournisseur (id uuid PRIMARY KEY);
      CREATE TABLE public.facture (id bigint PRIMARY KEY);
      CREATE TABLE public.avoir (id bigint PRIMARY KEY);
      CREATE TABLE public.cerp_schema_migrations (filename text PRIMARY KEY);
      CREATE FUNCTION public.fn_ged_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.ged_entity_types WHERE entity_type = NEW.entity_type AND is_active) THEN
          RAISE EXCEPTION 'GED_ENTITY_TYPE_UNKNOWN' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_ged_link_guard BEFORE INSERT OR UPDATE ON public.ged_document_links
        FOR EACH ROW EXECUTE FUNCTION public.fn_ged_link_guard();
    `);

    await expect(client.query(preflight)).resolves.toBeDefined();
    await client.query(patch);
    await expect(client.query(verify)).resolves.toBeDefined();
    expect((await client.query("SELECT entity_type FROM public.ged_entity_types ORDER BY entity_type")).rows.map((row) => row.entity_type)).toEqual([...requiredTypes].sort());

    for (const [index, entityType] of requiredTypes.entries()) {
      await expect(client.query(
        "INSERT INTO public.ged_document_links(id, document_id, entity_type, entity_id) VALUES ($1::uuid, $2::uuid, $3, $4)",
        [`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, entityType, String(index + 1)]
      )).resolves.toMatchObject({ rowCount: 1 });
    }
    await expect(client.query(
      "INSERT INTO public.ged_document_links(id, document_id, entity_type, entity_id) VALUES ('90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'client', '1')"
    )).rejects.toMatchObject({ code: "23514" });

    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${base}.sql`]);
    await expect(client.query(rollback)).rejects.toMatchObject({ message: expect.stringContaining("authoritative PDF GED entity links exist") });
    await client.query("ROLLBACK");
    await client.query("DELETE FROM public.ged_document_links");
    await client.query(rollback);
    expect((await client.query("SELECT COUNT(*)::int AS count FROM public.ged_entity_types")).rows[0]?.count).toBe(0);
  }, 60_000);
});
