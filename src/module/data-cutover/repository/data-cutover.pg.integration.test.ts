import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoPath } from "../../../__tests__/helpers/repo-paths";
import { createCutoverBatchSchema, patchCutoverRowSchema } from "../validators/data-cutover.validators";
import type { CutoverAccess } from "../types/data-cutover.types";

// This suite can only touch the explicitly named, disposable loopback database.
const url = process.env.CERP_CUTOVER_INTEGRATION_URL;
const describePg = url ? describe : describe.skip;
const admin: CutoverAccess = { userId: 1, isSuperadmin: true };
const contributor: CutoverAccess = { userId: 2, isSuperadmin: false };
const stranger: CutoverAccess = { userId: 3, isSuperadmin: false };
const internal = { affairNumber: "INTERNAL-1", articleReference: "00042", quantityOrdered: "0.3", quantityCompleted: "0.1", quantityRemaining: "0.2", unit: "pièces", orderDate: "2026-10-20", plannedDueDate: "2026-10-20" };
const stock = { stockScope: "OLD", stockKind: "PF", articleReference: "00042", quantityCounted: "0", unit: "u", warehouse: "W", location: "L", qualityStatus: "QUARANTAINE", owner: "CRP", countEvidence: "Comptage du 20 octobre" };
const base = { name: "Disposable preparation fixture", source_system: "CLIPPER_EXCEL", sources: [{ id: "source-1", name: "example.xlsx", sha256: "a".repeat(64), snapshot_at: "2026-10-20T08:00:00Z" }], rows: [
  { domain: "INTERNAL_DEMAND", legacy_key: "INTERNAL:1", source_id: "source-1", sheet: "Orders", row_number: 6, values: internal },
  { domain: "OPENING_STOCK", legacy_key: "STOCK:1", source_id: "source-1", sheet: "Stock", row_number: 2, values: stock },
  { domain: "OPENING_RECEIVABLE", legacy_key: "INVOICE:1", source_id: "source-1", sheet: "Finance", row_number: 2, values: { documentNumber: "FV-PRIVATE", originalAmount: "120.00" } },
] };

let db: Pool;
let repo: typeof import("./data-cutover.repository");
let appPool: Pool;
const create = async (name = base.name, sourceHash = "a".repeat(64)) => repo.repoCreateCutoverBatch(createCutoverBatchSchema.parse({ ...base, name, sources: [{ ...base.sources[0], sha256: sourceHash }] }), 1, `create-${name}`);
const listRows = (batchId: string, access = admin) => repo.repoGetCutoverRows(batchId, { page: 1, page_size: 100 }, access);
const edit = (batchId: string, row: Awaited<ReturnType<typeof listRows>>["items"][number], values = row.values, access = admin, key = `patch-${row.id}-${row.version}`) => repo.repoPatchCutoverRow(batchId, row.id, patchCutoverRowSchema.parse({ expected_version: row.version, values, decision: "INCLUDE", review_note: null }), access, key);

describePg("cutover preparation PostgreSQL boundaries", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Cutover integration URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/cerp_cutover_1710" || parsed.port !== "55471") throw new Error("Refusing non-disposable cutover test database");
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_1710") throw new Error("Unexpected database identity");
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY,username text NOT NULL);
      ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Active';
      INSERT INTO public.users(id,username,status) VALUES(1,'fixture-admin','Active'),(2,'fixture-contributor','Active'),(3,'fixture-stranger','Active'),(4,'fixture-disabled','Inactive') ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS public.units(code text PRIMARY KEY,label text NOT NULL);
      INSERT INTO public.units VALUES('u','Pièce'),('kg','Kilogramme'),('m','Mètre') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS public.clients(client_id text PRIMARY KEY,client_code text,company_name text);
      INSERT INTO public.clients VALUES('001','CLI-001','Fixture customer') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS public.fournisseurs(id uuid PRIMARY KEY,code text,code_fournisseur text,nom text,raison_sociale text);
      CREATE TABLE IF NOT EXISTS public.articles(id uuid PRIMARY KEY,code text,designation text);
      CREATE TABLE IF NOT EXISTS public.pieces_techniques(id uuid PRIMARY KEY,code_piece text,name_piece text,designation text,deleted_at timestamptz);
      ALTER TABLE IF EXISTS public.data_cutover_rows ADD COLUMN IF NOT EXISTS source_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
    await db.query(readFileSync(repoPath("db", "patches", "20261020_01_data_cutover_preparation_1710.sql"), "utf8"));
    await db.query(readFileSync(repoPath("db", "patches", "20261020_05_financial_cutover_gate_1710.sql"), "utf8"));
    repo = await import("./data-cutover.repository");
    appPool = (await import("../../../config/database")).default;
  });
  beforeEach(async () => {
    // This database is guarded above as a disposable loopback fixture. Opening
    // and application tests may have added child evidence tables to it.
    await db.query("TRUNCATE public.data_cutover_events,public.data_cutover_commands,public.data_cutover_contributors,public.data_cutover_rows,public.data_cutover_batches CASCADE");
    await db.query(readFileSync(repoPath("db", "patches", "20261020_05_financial_cutover_gate_1710.sql"), "utf8"));
  });
  afterAll(async () => { await appPool?.end(); await db?.end(); });

  it("deduplicates concurrent uploads and rejects an idempotency key reused with different data", async () => {
    const [first, second] = await Promise.all([create(), create()]);
    expect(first.batch.id).toBe(second.batch.id);
    expect(await repo.repoCutoverFinancialStatus()).toEqual({ status: "PREPARING", emissions_suspended: true });
    const counts = await db.query("SELECT (SELECT count(*)::int FROM public.data_cutover_batches) AS batches,(SELECT count(*)::int FROM public.data_cutover_rows) AS rows");
    expect(counts.rows[0]).toEqual({ batches: 1, rows: 3 });
    await expect(repo.repoCreateCutoverBatch(createCutoverBatchSchema.parse({ ...base, name: "Different" }), 1, `create-${base.name}`)).rejects.toMatchObject({ status: 409, code: "CUTOVER_IDEMPOTENCY_CONFLICT" });
  });
  it("canonicalizes a known unit, preserves leading zeros and performs exact decimal checks", async () => {
    const { batch } = await create();
    const row = (await listRows(batch.id)).items.find((item) => item.domain === "INTERNAL_DEMAND")!;
    expect(row.values.unit).toBe("u");
    expect(row.source_values.unit).toBe("pièces");
    const saved = await edit(batch.id, row);
    expect(saved.row.status).toBe("READY");
    expect(saved.row.values.articleReference).toBe("00042");
    const badUnit = await edit(batch.id, saved.row, { ...saved.row.values, unit: "invented-unit" });
    expect(badUnit.row.status).toBe("MISSING");
    expect(badUnit.row.issues.some((issue) => issue.code === "UNKNOWN_STOCK_UNIT")).toBe(true);
    const preview = await repo.repoPreviewCutover(batch.id, { expected_version: badUnit.batch_version, cutoff_at: "2026-10-21T16:00:00Z" }, 1, "preview-invalid-unit");
    expect(preview.ready).toBe(false);
  });
  it("enforces optimistic edits and freezes source evidence in the database", async () => {
    const { batch } = await create();
    const row = (await listRows(batch.id)).items[0]!;
    await edit(batch.id, row);
    await expect(edit(batch.id, row, { ...row.values, plannedDueDate: "2026-10-22" }, admin, "different-editor-command")).rejects.toMatchObject({ status: 409, code: "CUTOVER_STALE_ROW" });
    await expect(db.query("UPDATE public.data_cutover_rows SET source_values='{}'::jsonb WHERE id=$1::uuid", [row.id])).rejects.toMatchObject({ code: "23514" });
  });
  it("blocks changing OLD provenance or PF/MP through direct API edits", async () => {
    const { batch } = await create();
    const row = (await listRows(batch.id)).items.find((item) => item.domain === "OPENING_STOCK")!;
    await expect(edit(batch.id, row, { ...row.values, stockScope: "NEW" })).rejects.toMatchObject({ status: 422, code: "CUTOVER_READ_ONLY_FIELD" });
    await expect(edit(batch.id, row, { ...row.values, stockKind: "MP" })).rejects.toMatchObject({ status: 422, code: "CUTOVER_READ_ONLY_FIELD" });
    expect((await listRows(batch.id)).items.find((item) => item.id === row.id)!.version).toBe(1);
  });
  it("limits contributors to assigned domains and rechecks authorization before replaying a command", async () => {
    const { batch } = await create();
    await repo.repoAssignCutoverContributor(batch.id, { user_id: 2, domains: ["INTERNAL_DEMAND"] }, 1, "grant-contributor");
    const visible = await listRows(batch.id, contributor);
    expect(visible.total).toBe(1);
    expect(JSON.stringify(visible)).not.toContain("FV-PRIVATE");
    const row = visible.items[0]!;
    const other = (await listRows(batch.id)).items.find((item) => item.domain === "OPENING_RECEIVABLE")!;
    await expect(edit(batch.id, other, other.values, contributor)).rejects.toMatchObject({ status: 404 });
    await expect(listRows(batch.id, stranger)).rejects.toMatchObject({ status: 404 });
    await edit(batch.id, row, row.values, contributor, "replay-scope-command");
    const refreshed = (await listRows(batch.id, contributor)).items.find((item) => item.id === row.id)!;
    await expect(edit(batch.id, refreshed, { ...refreshed.values, articleTargetId: "20000000-0000-4000-8000-000000000001" }, contributor, "forged-native-mapping")).rejects.toMatchObject({ status: 403, code: "CUTOVER_SUPERADMIN_MAPPING_REQUIRED" });
    await repo.repoAssignCutoverContributor(batch.id, { user_id: 2, domains: [] }, 1, "revoke-contributor");
    await expect(edit(batch.id, row, row.values, contributor, "replay-scope-command")).rejects.toMatchObject({ status: 404 });
    await expect(repo.repoAssignCutoverContributor(batch.id, { user_id: 4, domains: ["WIP"] }, 1, "disabled-contributor")).rejects.toMatchObject({ code: "CUTOVER_CONTRIBUTOR_NOT_FOUND" });
  });
  it("requires a current preview and applicable attestations; signing changes no business tables", async () => {
    const before = (await db.query("SELECT (SELECT count(*)::int FROM public.clients) AS clients,(SELECT count(*)::int FROM public.articles) AS articles")).rows[0];
    const { batch } = await create();
    const row = (await listRows(batch.id)).items.find((item) => item.domain === "INTERNAL_DEMAND")!;
    const edited = await edit(batch.id, row);
    const noCutoff = await repo.repoPreviewCutover(batch.id, { expected_version: edited.batch_version }, 1, "preview-without-cutoff");
    expect(noCutoff.blockers.some((item) => item.code === "CUTOVER_CUTOFF_REQUIRED")).toBe(true);
    const preview = await repo.repoPreviewCutover(batch.id, { expected_version: edited.batch_version, cutoff_at: "2026-10-21T16:00:00Z" }, 1, "preview-ready-fixture");
    expect(preview.ready).toBe(true);
    expect(preview.required_checklist).not.toContain("accounting_reconciled");
    const input = { expected_version: preview.batch_version, expected_preview_hash: preview.preview_hash, confirm: true as const, checklist: { sources_frozen: true, exclusive_scope: true, no_external_emissions: true }, reviewer_name: "Fixture reviewer", review_note: "Contrôles du pilote confirmés" };
    await expect(repo.repoValidateCutover(batch.id, { ...input, checklist: {} }, 1, "sign-missing-checks")).rejects.toMatchObject({ code: "CUTOVER_CHECKLIST_INCOMPLETE" });
    const result = await repo.repoValidateCutover(batch.id, input, 1, "sign-valid-preparation");
    expect(result.batch.status).toBe("VALIDATED");
    const exported = await repo.repoExportCutover(batch.id);
    expect(exported.purpose).toBe("PREPARATION_ONLY");
    expect(exported.posting_available).toBe(false);
    expect((await db.query("SELECT (SELECT count(*)::int FROM public.clients) AS clients,(SELECT count(*)::int FROM public.articles) AS articles")).rows[0]).toEqual(before);
    const changed = await edit(batch.id, edited.row, { ...edited.row.values, plannedDueDate: "2026-10-22" });
    expect((await repo.repoGetCutoverBatch(batch.id, admin)).batch.status).toBe("DRAFT");
    await expect(repo.repoValidateCutover(batch.id, { ...input, expected_version: changed.batch_version }, 1, "sign-stale-preview")).rejects.toMatchObject({ code: "CUTOVER_STALE_PREVIEW" });
  });
  it("locks a validated dossier for contributors and audits an administrator correction or ACL change", async () => {
    const { batch } = await create("Validated lock fixture", "d".repeat(64));
    await repo.repoAssignCutoverContributor(batch.id, { user_id: 2, domains: ["INTERNAL_DEMAND"] }, 1, "grant-before-validation");
    const row = (await listRows(batch.id)).items.find((item) => item.domain === "INTERNAL_DEMAND")!;
    const edited = await edit(batch.id, row);
    const preview = await repo.repoPreviewCutover(batch.id, { expected_version: edited.batch_version, cutoff_at: "2026-10-21T16:00:00Z" }, 1, "preview-lock-fixture");
    await repo.repoValidateCutover(batch.id, {
      expected_version: preview.batch_version, expected_preview_hash: preview.preview_hash, confirm: true,
      checklist: { sources_frozen: true, exclusive_scope: true, no_external_emissions: true },
      reviewer_name: "Fixture reviewer", review_note: "Contrôles du pilote confirmés",
    }, 1, "validate-lock-fixture");
    const contributorRow = (await listRows(batch.id, contributor)).items[0]!;
    await expect(edit(batch.id, contributorRow, contributorRow.values, contributor, "contributor-after-validation")).rejects.toMatchObject({ status: 409, code: "CUTOVER_BATCH_LOCKED" });
    expect((await repo.repoGetCutoverBatch(batch.id, admin)).batch.status).toBe("VALIDATED");

    const corrected = await edit(batch.id, edited.row, { ...edited.row.values, plannedDueDate: "2026-10-22" }, admin, "admin-after-validation");
    expect(corrected.batch_version).toBeGreaterThan(preview.batch_version);
    expect((await repo.repoGetCutoverBatch(batch.id, admin)).batch.status).toBe("DRAFT");
    const invalidation = await db.query<{ action: string; details: { reason: string; previous_validation_hash: string; previous_batch_version: number } }>("SELECT action,details FROM public.data_cutover_events WHERE batch_id=$1::uuid AND action='PREPARATION_VALIDATION_INVALIDATED' ORDER BY created_at,id", [batch.id]);
    expect(invalidation.rows[0]).toMatchObject({ action: "PREPARATION_VALIDATION_INVALIDATED", details: { reason: "ROW_UPDATED", previous_batch_version: corrected.batch_version - 1 } });
    expect(invalidation.rows[0]!.details.previous_validation_hash).toMatch(/^[a-f0-9]{64}$/);

    // Re-sign then alter the contributor ACL: this must revoke the new signature too.
    const rePreview = await repo.repoPreviewCutover(batch.id, { expected_version: corrected.batch_version, cutoff_at: "2026-10-21T16:00:00Z" }, 1, "repreview-lock-fixture");
    await repo.repoValidateCutover(batch.id, {
      expected_version: rePreview.batch_version, expected_preview_hash: rePreview.preview_hash, confirm: true,
      checklist: { sources_frozen: true, exclusive_scope: true, no_external_emissions: true },
      reviewer_name: "Fixture reviewer", review_note: "Nouveau contrôle confirmé",
    }, 1, "revalidate-lock-fixture");
    await repo.repoAssignCutoverContributor(batch.id, { user_id: 2, domains: ["INTERNAL_DEMAND", "WIP"] }, 1, "change-after-validation");
    expect((await repo.repoGetCutoverBatch(batch.id, admin)).batch.status).toBe("DRAFT");
    const reasons = await db.query<{ reason: string }>("SELECT details->>'reason' AS reason FROM public.data_cutover_events WHERE batch_id=$1::uuid AND action='PREPARATION_VALIDATION_INVALIDATED' ORDER BY created_at,id", [batch.id]);
    expect(reasons.rows.map((item) => item.reason)).toEqual(["ROW_UPDATED", "CONTRIBUTORS_CHANGED"]);
  });
  it("prevents signing the same operational source in two different batches", async () => {
    for (const [index, hash] of ["a", "b"].entries()) {
      const { batch } = await create(`Overlap fixture ${index}`, hash.repeat(64));
      const row = (await listRows(batch.id)).items.find((item) => item.domain === "INTERNAL_DEMAND")!;
      const edited = await edit(batch.id, row);
      const preview = await repo.repoPreviewCutover(batch.id, { expected_version: edited.batch_version, cutoff_at: "2026-10-21T16:00:00Z" }, 1, `preview-overlap-${index}`);
      const promise = repo.repoValidateCutover(batch.id, { expected_version: preview.batch_version, expected_preview_hash: preview.preview_hash, confirm: true, checklist: { sources_frozen: true, exclusive_scope: true, no_external_emissions: true }, reviewer_name: "Fixture reviewer", review_note: "Contrôles confirmés" }, 1, `sign-overlap-${index}`);
      if (index === 0) await expect(promise).resolves.toMatchObject({ batch: { status: "VALIDATED" } });
      else await expect(promise).rejects.toMatchObject({ status: 409, code: "CUTOVER_OVERLAPPING_SCOPE" });
    }
  });
  it("verifies selected native targets and treats SQL syntax as a literal search", async () => {
    const input = createCutoverBatchSchema.parse({ ...base, rows: [{ ...base.rows[0], domain: "CUSTOMER", values: { customerCode: "SOURCE-001", name: "Fixture customer", resolution: "LINK", targetId: "missing-id" } }] });
    const { batch } = await repo.repoCreateCutoverBatch(input, 1, "create-customer-target");
    const row = (await listRows(batch.id)).items[0]!;
    expect((await edit(batch.id, row)).row.issues.some((issue) => issue.code === "TARGET_NOT_FOUND")).toBe(true);
    expect(await repo.repoCutoverLookup("CUSTOMER", "' OR 1=1 --")).toEqual({ items: [] });
    expect((await repo.repoCutoverLookup("CUSTOMER", "fixture")).items[0]?.id).toBe("001");
  });
  it("limits newly committed mutations without consuming quota for identical retries", async () => {
    const first = await create();
    await db.query(`INSERT INTO public.data_cutover_commands(actor_user_id,operation,idempotency_key,request_hash,response) SELECT 1,'rate-fixture','rate-fixture-'||n,$1,'{}'::jsonb FROM generate_series(1,120)n`, ["f".repeat(64)]);
    await expect(create()).resolves.toMatchObject({ batch: { id: first.batch.id } });
    await expect(repo.repoPreviewCutover(first.batch.id, { expected_version: 1 }, 1, "limited-preview-command")).rejects.toMatchObject({ status: 429, code: "CUTOVER_RATE_LIMITED" });
  });
  it("paginates, filters and summarizes only the visible rows without leaking hidden domains", async () => {
    const { batch } = await create();
    const initial = await listRows(batch.id);
    await edit(batch.id, initial.items.find((item) => item.domain === "INTERNAL_DEMAND")!);
    const ready = await repo.repoGetCutoverRows(batch.id, { status: "READY", page: 1, page_size: 1 }, admin);
    expect(ready.total).toBe(1);
    expect(ready.items[0]?.domain).toBe("INTERNAL_DEMAND");
    expect(ready.summary).toMatchObject({ total: 3, included: 1, pending: 2, ready: 1 });
    const search = await repo.repoGetCutoverRows(batch.id, { search: "FV-PRIVATE", page: 1, page_size: 1 }, admin);
    expect(search.total).toBe(1);
    expect(search.items[0]?.domain).toBe("OPENING_RECEIVABLE");
    expect((await repo.repoGetCutoverRows(batch.id, { search: "' OR 1=1 --", page: 1, page_size: 25 }, admin)).total).toBe(0);
    await repo.repoAssignCutoverContributor(batch.id, { user_id: 2, domains: ["INTERNAL_DEMAND"] }, 1, "grant-filter-fixture");
    const hidden = await repo.repoGetCutoverRows(batch.id, { domain: "OPENING_RECEIVABLE", page: 1, page_size: 25 }, contributor);
    expect(hidden.total).toBe(0);
    expect(hidden.summary).toMatchObject({ total: 1, included: 1, pending: 0 });
    expect((await repo.repoGetCutoverBatch(batch.id, contributor)).batch.summary.total).toBe(1);
  });
});
