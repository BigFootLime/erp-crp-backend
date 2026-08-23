import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationUrl = process.env.AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_TEST_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;
const root = process.cwd();
const base = "20260823_authoritative_pdf_ged_entity_contract";
const bridgeBase = "20260823_authoritative_pdf_ged_compatibility_bridge";
const cleanupBase = "20260823_authoritative_pdf_ged_legacy_profile_cleanup";
const requiredTypes = ["BON_LIVRAISON", "DEVIS", "COMMANDE_FOURNISSEUR", "FACTURE", "AVOIR"];

suite("authoritative PDF/GED entity contract: PostgreSQL migration", () => {
  let client: import("pg").Client;
  let patch: string;
  let preflight: string;
  let verify: string;
  let rollback: string;
  let bridge: string;
  let bridgePreflight: string;
  let bridgeVerify: string;
  let cleanup: string;
  let cleanupPreflight: string;
  let cleanupVerify: string;

  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.Client({ connectionString: integrationUrl });
    await client.connect();
    const database = await client.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) {
      throw new Error("AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_TEST_DATABASE_URL must target a test/local/sandbox database");
    }
    [patch, preflight, verify, rollback, bridge, bridgePreflight, bridgeVerify, cleanup, cleanupPreflight, cleanupVerify] = await Promise.all([
      fs.readFile(path.join(root, "db/patches", `${base}.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${base}.preflight.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${base}.verify.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${base}.rollback.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches", `${bridgeBase}.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${bridgeBase}.preflight.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${bridgeBase}.verify.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches", `${cleanupBase}.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${cleanupBase}.preflight.sql`), "utf8"),
      fs.readFile(path.join(root, "db/patches/support", `${cleanupBase}.verify.sql`), "utf8"),
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

  it("temporarily bridges the empty legacy production profile and restores it exactly", async () => {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(`
      CREATE TABLE public.ged_document_links (
        id uuid PRIMARY KEY, document_id uuid NOT NULL, entity_type text NOT NULL,
        entity_id text NOT NULL, link_role text NULL
      );
      CREATE TABLE public.bon_livraison (id uuid PRIMARY KEY);
      CREATE TABLE public.devis (id bigint PRIMARY KEY);
      CREATE TABLE public.commande_fournisseur (id uuid PRIMARY KEY);
      CREATE TABLE public.facture (id bigint PRIMARY KEY);
      CREATE TABLE public.avoir (id bigint PRIMARY KEY);
      CREATE TABLE public.cerp_schema_migrations (filename text PRIMARY KEY);
      CREATE FUNCTION public.fn_ged_validate_canonical_entity_link_20()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER trg_ged_validate_canonical_entity_link_20
        BEFORE INSERT OR UPDATE OF entity_type, entity_id ON public.ged_document_links
        FOR EACH ROW EXECUTE FUNCTION public.fn_ged_validate_canonical_entity_link_20();
    `);

    await expect(client.query(bridgePreflight)).resolves.toBeDefined();
    await client.query(bridge);
    await expect(client.query(bridgeVerify)).resolves.toBeDefined();
    expect((await client.query("SELECT COUNT(*)::int AS count FROM public.ged_entity_types")).rows[0]?.count).toBe(12);
    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${bridgeBase}.sql`]);

    await expect(client.query(preflight)).resolves.toBeDefined();
    await client.query(patch);
    await expect(client.query(verify)).resolves.toBeDefined();
    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${base}.sql`]);

    await expect(client.query(cleanupPreflight)).resolves.toBeDefined();
    await client.query(cleanup);
    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${cleanupBase}.sql`]);
    await expect(client.query(cleanupVerify)).resolves.toBeDefined();

    expect((await client.query("SELECT to_regclass('public.ged_entity_types') AS registry")).rows[0]?.registry).toBeNull();
    expect((await client.query("SELECT to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') AS marker")).rows[0]?.marker).toBeNull();
    expect((await client.query("SELECT to_regprocedure('public.fn_ged_link_guard()') AS strict_guard")).rows[0]?.strict_guard).toBeNull();
    expect((await client.query("SELECT to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NOT NULL AS legacy_guard")).rows[0]?.legacy_guard).toBe(true);
    await expect(client.query(
      "INSERT INTO public.ged_document_links(id, document_id, entity_type, entity_id) VALUES ('90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'client', '1')"
    )).resolves.toMatchObject({ rowCount: 1 });
  }, 60_000);

  it("leaves an existing closed-registry profile unchanged", async () => {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(`
      CREATE TABLE public.ged_entity_types (
        entity_type text PRIMARY KEY, label text NOT NULL, module_key text NOT NULL,
        target_table text NOT NULL, target_pk_column text NOT NULL,
        sort_order integer NOT NULL, is_active boolean NOT NULL
      );
      CREATE TABLE public.ged_document_links (
        id uuid PRIMARY KEY, document_id uuid NOT NULL, entity_type text NOT NULL,
        entity_id text NOT NULL, link_role text NULL
      );
      CREATE TABLE public.bon_livraison (id uuid PRIMARY KEY);
      CREATE TABLE public.devis (id bigint PRIMARY KEY);
      CREATE TABLE public.commande_fournisseur (id uuid PRIMARY KEY);
      CREATE TABLE public.facture (id bigint PRIMARY KEY);
      CREATE TABLE public.avoir (id bigint PRIMARY KEY);
      CREATE TABLE public.cerp_schema_migrations (filename text PRIMARY KEY);
      CREATE FUNCTION public.fn_ged_link_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER trg_ged_link_guard BEFORE INSERT OR UPDATE ON public.ged_document_links
        FOR EACH ROW EXECUTE FUNCTION public.fn_ged_link_guard();
    `);
    await client.query(patch);
    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${base}.sql`]);

    await expect(client.query(bridgePreflight)).resolves.toBeDefined();
    await client.query(bridge);
    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${bridgeBase}.sql`]);
    await expect(client.query(cleanupPreflight)).resolves.toBeDefined();
    await client.query(cleanup);
    await client.query("INSERT INTO public.cerp_schema_migrations(filename) VALUES ($1)", [`${cleanupBase}.sql`]);
    await expect(client.query(cleanupVerify)).resolves.toBeDefined();

    expect((await client.query("SELECT entity_type FROM public.ged_entity_types ORDER BY entity_type")).rows.map((row) => row.entity_type)).toEqual([...requiredTypes].sort());
    expect((await client.query("SELECT to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') AS marker")).rows[0]?.marker).toBeNull();
  }, 60_000);
});
