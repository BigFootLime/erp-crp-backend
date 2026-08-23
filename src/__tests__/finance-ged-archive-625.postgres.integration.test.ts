import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const integrationUrl = process.env.FINANCE_GED_ARCHIVE_TEST_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;
const root = process.cwd();
const pdf = Buffer.from("%PDF-1.7\\nfinance-issued-exact-bytes\\n%%EOF");
const pdfSha = crypto.createHash("sha256").update(pdf).digest("hex");

suite("#625 finance GED archive PostgreSQL integrity", () => {
  let pg: typeof import("pg");
  let pool: import("pg").Pool;

  const archiveInsert = (key: string, source = pdf, sha = pdfSha) => `
    INSERT INTO public.authoritative_pdf_archives
      (entity_type, entity_id, document_kind, document_version, render_version, idempotency_key,
       title, original_name, source_snapshot, source_revision, snapshot_sha256,
       exact_pdf_bytes, exact_pdf_sha256, exact_pdf_size_bytes, created_by)
    VALUES ('facture','11111111-1111-4111-8111-111111111111','FINANCE_INVOICE_LEGAL_PDF',1,
            'finance-legal-issued-v1',$1,'Facture légale F-1','Facture_F-1_v1.pdf',
            '{"legal_number":"F-1"}'::jsonb,'F-1:${pdfSha}',repeat('a',64),$2,$3,$4,1)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id::text`;

  beforeAll(async () => {
    const pgModule = await import("pg"); pg = pgModule;
    const bootstrap = new pg.Client({ connectionString: integrationUrl });
    await bootstrap.connect();
    const target = await bootstrap.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(target.rows[0]?.current_database ?? "")) {
      throw new Error("FINANCE_GED_ARCHIVE_TEST_DATABASE_URL must target an explicitly named test/local/sandbox database");
    }
    await bootstrap.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await bootstrap.query(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN CREATE ROLE cerp_app; END IF; END $$;
      CREATE TABLE public.users (id integer PRIMARY KEY);
      INSERT INTO public.users (id) VALUES (1);
      CREATE TABLE public.ged_document_classes (class_key text PRIMARY KEY, domain text, label text, nature text, allowed_mime_types text[], allowed_extensions text[], max_size_bytes bigint, approvals_required smallint, retention_months integer, hold_on_publish boolean, is_active boolean);
      CREATE TABLE public.ged_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.ged_document_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.ged_document_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    for (const file of ["20260823_authoritative_pdf_archive_612.sql", "20260823_finance_ged_archive_625.sql"]) {
      await bootstrap.query(await fs.readFile(path.join(root, "db/patches", file), "utf8"));
    }
    await bootstrap.end();
    pool = new pg.Pool({ connectionString: integrationUrl });
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE public.authoritative_pdf_archive_outbox, public.authoritative_pdf_archives CASCADE");
  });

  afterAll(async () => { await pool?.end(); });

  it("rejects a byte/checksum mismatch in PostgreSQL, before any worker can consume it", async () => {
    await expect(pool.query(archiveInsert("finance:bad", pdf, "b".repeat(64)), ["finance:bad", pdf, "b".repeat(64), pdf.byteLength]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("keeps the exact legal bytes immutable after insertion", async () => {
    const inserted = await pool.query(archiveInsert("finance:immutable"), ["finance:immutable", pdf, pdfSha, pdf.byteLength]);
    await expect(pool.query("UPDATE public.authoritative_pdf_archives SET exact_pdf_bytes = $2 WHERE id = $1::uuid", [inserted.rows[0].id, Buffer.from("%PDF-1.7\\nchanged\\n%%EOF")]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("is idempotent under concurrent legal archive enqueue attempts", async () => {
    const first = pool.connect(); const second = pool.connect();
    const [one, two] = await Promise.all([first, second]);
    try {
      const [a, b] = await Promise.all([
        one.query(archiveInsert("finance:concurrent"), ["finance:concurrent", pdf, pdfSha, pdf.byteLength]),
        two.query(archiveInsert("finance:concurrent"), ["finance:concurrent", pdf, pdfSha, pdf.byteLength]),
      ]);
      expect(a.rowCount! + b.rowCount!).toBe(1);
      const row = await pool.query("SELECT encode(exact_pdf_bytes, 'hex') AS bytes, exact_pdf_sha256, exact_pdf_size_bytes::int AS size FROM public.authoritative_pdf_archives WHERE idempotency_key = $1", ["finance:concurrent"]);
      expect(row.rows[0]).toMatchObject({ bytes: pdf.toString("hex"), exact_pdf_sha256: pdfSha, size: pdf.byteLength });
    } finally { one.release(); two.release(); }
  });
});
