import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = fs.readFileSync(path.join(root, "db/patches/20260823_authoritative_pdf_archive_612.sql"), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260823_authoritative_pdf_archive_612.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260823_authoritative_pdf_archive_612.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260823_authoritative_pdf_archive_612.rollback.sql"), "utf8");

describe("#612 authoritative PDF archive migration guards", () => {
  it("requires an absent GED class so the migration owns what rollback removes", () => {
    expect(patch).toContain("AUTHORITATIVE_PDF_GED_CLASS_ALREADY_EXISTS");
    expect(preflight).toContain("AUTHORITATIVE_PDF_PREFLIGHT_GED_CLASS_ALREADY_EXISTS");
    expect(preflight).toContain("generated_pdf_class_absent");
    expect(patch).toContain("'PDF sortant autoritatif'");
    expect(patch).not.toContain("ON CONFLICT (class_key) DO NOTHING");
    expect(patch).toContain("AUTHORITATIVE_PDF_TARGET_NAMESPACE_ALREADY_EXISTS");
    expect(patch).not.toContain("CREATE TABLE IF NOT EXISTS public.authoritative_pdf_archives");
    expect(patch).toContain("{0,180}\\.pdf$");
    expect(patch).not.toContain("{0,180}\\\\.pdf$");
  });

  it("keeps human document version separate from renderer revision and permits same-source reissues", () => {
    expect(patch).toContain("authoritative_pdf_archive_document_version_uq");
    expect(patch).toContain("authoritative_pdf_archive_snapshot_lookup_idx");
    expect(patch).not.toContain("authoritative_pdf_archive_identity_uq");
  });

  it("ships read-only preflight and verification gates for runtime invariants", () => {
    for (const script of [preflight, verify]) {
      expect(script).toContain("BEGIN TRANSACTION READ ONLY");
      expect(script).toContain("CERP_AUTHORITATIVE_PDF");
      expect(script).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
    }
    expect(preflight).toContain("generated_pdf_class_absent");
    expect(verify).toContain("52428800");
    expect(preflight).toContain("AUTHORITATIVE_PDF_PREFLIGHT_GED_CLASS_ALREADY_EXISTS");
    expect(verify).toContain("AUTHORITATIVE_PDF_VERIFY_OUTBOX_STATUS_CONSTRAINT_MISSING");
    expect(verify).toContain("authoritative_pdf_archive_pdf_size_ck");
    expect(verify).toContain("authoritative_pdf_archive_outbox_lifecycle_ck");
    expect(verify).toContain("AUTHORITATIVE_PDF_VERIFY_GED_PREREQUISITE_MISSING");
    expect(verify).toContain("AUTHORITATIVE_PDF_VERIFY_APP_ROLE_MISSING");
    expect(verify).toContain("AUTHORITATIVE_PDF_VERIFY_LEASE_TOKEN_MISSING");
    expect(verify).toContain("tgrelid = 'public.authoritative_pdf_archives'::regclass");
    expect(verify).toContain("tgfoid = to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()')");
    expect(verify).toContain("pg_get_constraintdef(oid)");
    expect(verify).toContain("authoritative_pdf_archive_outbox_complete_612");
    expect(patch).toContain("pdf_size_bytes <= 52428800");
    expect(patch).toContain("(status = 'ARCHIVED') = (archived_at IS NOT NULL)");
    expect(patch).toContain("status = 'PROCESSING' AND locked_at IS NOT NULL AND locked_by IS NOT NULL");
    expect(patch).toContain("claim_token IS NOT NULL");
    expect(patch).toContain("AUTHORITATIVE_PDF_OUTBOX_ARCHIVED_WITHOUT_COMPLETE_ARCHIVE");
    expect(verify).toContain("trg_authoritative_pdf_archive_immutable_612");
    expect(verify).toContain("authoritative_pdf_archive_outbox_stale_idx");
  });

  it("makes rollback ledger-owned, empty-install safe, and removes every owned function", () => {
    expect(rollback).toContain("to_regclass('public.authoritative_pdf_archives') IS NOT NULL");
    expect(rollback).toContain("EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.authoritative_pdf_archives)' INTO has_rows");
    expect(rollback).toContain("EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.ged_documents WHERE class_key = ''CERP_AUTHORITATIVE_PDF'')' INTO has_rows");
    expect(rollback).toContain("Rollback refused: #612 artifacts exist without canonical migration-ledger ownership.");
    expect(rollback).toContain("Rollback refused: #612 GED class is missing or its policy changed.");
    expect(rollback).toContain("20260823_authoritative_pdf_archive_612.sql");
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.fn_authoritative_pdf_archive_immutable_612()");
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.fn_authoritative_pdf_archive_outbox_stamp_612()");
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.fn_authoritative_pdf_archive_outbox_complete_612()");
    expect(rollback).toContain("authoritative PDF GED documents exist");
    expect(rollback).toContain("target_exists := to_regclass('public.authoritative_pdf_archives') IS NOT NULL");
    expect(rollback).toContain("DELETE FROM public.ged_document_classes WHERE class_key = ''CERP_AUTHORITATIVE_PDF''");
  });
});
