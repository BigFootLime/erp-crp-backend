import assert from "node:assert/strict";
import test from "node:test";
import { assertImportDatabase, stageLegacyImport } from "./legacy-import-stage.mjs";

const digest = "a".repeat(64);
const actor = { user_id: 7 };
const files = [
  { relativePath: "PC-01/first.pdf", sha256: digest, sizeBytes: 4, mimeType: "application/pdf" },
  { relativePath: "PC-02/second.pdf", sha256: digest, sizeBytes: 4, mimeType: "application/pdf" },
];
const preparedFiles = files.map((file, index) => ({ ...file, storagePath: "C:/vault/" + index, scan: {
  status: "clean", mode: "enforce", provider: "clamdscan", scanned_at: "2026-10-27T10:00:00.000Z",
} }));
const plan = {
  files,
  summary: { sources: 2, equipment: 1, observations: 1, evidence_rows: 2 },
  records: [
    { source: files[0].relativePath, sheet: "Sheet", coordinate: "equipment:g1", sha256: "b".repeat(64), key: "g1", raw: { exact: true }, normalized: { record_kind: "equipment" }, disposition: "PENDING", diagnostics: [] },
    { source: files[1].relativePath, sheet: "Sheet", coordinate: "history:h1", sha256: "c".repeat(64), key: "g1", raw: { fields: [{ value: 0 }] }, normalized: { record_kind: "history" }, disposition: "PENDING", diagnostics: [] },
  ],
};
const manifest = { parserVersion: "metrology-reconciliation/3.0.0+test" };
const semantics = { version: 1 };

class TranscriptClient {
  constructor({ prior = null, fail = null } = {}) { this.prior = prior; this.fail = fail; this.calls = []; this.sources = 0; this.raw = 0; }
  async query(sql, params = []) {
    const statement = Array.isArray(sql) ? sql.join(" ") : sql;
    this.calls.push({ statement, params });
    if (this.fail?.(statement, params, this)) throw new Error("synthetic database failure");
    if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK" || statement.startsWith("SET LOCAL") || statement.startsWith("SELECT pg_advisory")) return { rows: [], rowCount: 0 };
    if (statement.includes("FROM public.metrologie_import_batches WHERE source_set_sha256")) {
      return this.prior ? { rows: [this.prior], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (statement.includes("INSERT INTO public.metrologie_import_batches")) return { rows: [{ id: "batch-1" }], rowCount: 1 };
    if (statement.includes("INSERT INTO public.metrologie_import_source_files")) return { rows: [{ id: "source-" + (++this.sources) }], rowCount: 1 };
    if (statement.includes("INSERT INTO public.metrologie_import_raw_rows")) { this.raw += 1; return { rows: [], rowCount: 1 }; }
    throw new Error("unexpected query: " + statement);
  }
}

test("database guard refuses templates, a wrong target, and a missing actor", async () => {
  await assert.rejects(assertImportDatabase({ query: async () => ({ rows: [], rowCount: 0 }) }, "template_cerp", 7), /templates forbidden/);
  await assert.rejects(assertImportDatabase({ query: async () => ({ rows: [{ name: "other" }], rowCount: 1 }) }, "cerp_test", 7), /differs/);
  const calls = [];
  await assert.rejects(assertImportDatabase({ query: async (sql) => { calls.push(sql); return { rows: [{ name: "cerp_test" }], rowCount: 0 }; } }, "cerp_test", 7), /actor does not exist/);
  assert.equal(calls.length, 2);
  await assert.rejects(assertImportDatabase({ query: async () => ({ rows: [{ name: "cerp_test" }], rowCount: 1 }) }, "cerp_test", 0), /existing actor/);
});

test("staging preserves distinct source ids for duplicate hashes and serializes object evidence", async () => {
  const client = new TranscriptClient();
  const audits = [];
  const result = await stageLegacyImport({ client, sourceSetSha256: digest, manifest, semantics, plan, preparedFiles, actor,
    insertAudit: async (...args) => audits.push(args) });
  assert.deepEqual(result, { batch_id: "batch-1", status: "STAGED", replay: false, source_set_sha256: digest, ...plan.summary });
  const sourceInserts = client.calls.filter(call => call.statement.includes("INSERT INTO public.metrologie_import_source_files"));
  assert.equal(sourceInserts.length, 2);
  assert.notEqual(sourceInserts[0].params[1], sourceInserts[1].params[1]);
  assert.equal(sourceInserts[0].params[2], sourceInserts[1].params[2]);
  const rawInserts = client.calls.filter(call => call.statement.includes("INSERT INTO public.metrologie_import_raw_rows"));
  assert.equal(rawInserts.length, 2);
  for (const call of rawInserts) assert.equal(typeof JSON.parse(call.params[5]), "object");
  assert.equal(audits.length, 1);
  assert.equal(client.calls.at(-1).statement, "COMMIT");
});

test("coverage mismatch is refused before opening a transaction", async () => {
  const client = new TranscriptClient();
  await assert.rejects(stageLegacyImport({ client, sourceSetSha256: digest, manifest, semantics, plan,
    preparedFiles: preparedFiles.slice(0, 1), actor, insertAudit: async () => undefined }), /coverage mismatch/);
  assert.equal(client.calls.length, 0);
});

test("a prior batch replays without inserts", async () => {
  const client = new TranscriptClient({ prior: { id: "prior-1", status: "STAGED" } });
  const result = await stageLegacyImport({ client, sourceSetSha256: digest, manifest, semantics, plan, preparedFiles, actor, insertAudit: async () => undefined });
  assert.deepEqual(result, { batch_id: "prior-1", status: "STAGED", replay: true });
  assert.equal(client.calls.some(call => call.statement.includes("INSERT INTO public.metrologie_import")), false);
  assert.equal(client.calls.at(-1).statement, "COMMIT");
});

test("raw insert and audit failures roll back and never commit", async () => {
  for (const mode of ["raw", "audit"]) {
    const client = new TranscriptClient({ fail: statement => mode === "raw" && statement.includes("INSERT INTO public.metrologie_import_raw_rows") });
    const audit = async () => { if (mode === "audit") throw new Error("audit unavailable"); };
    await assert.rejects(stageLegacyImport({ client, sourceSetSha256: digest, manifest, semantics, plan, preparedFiles, actor, insertAudit: audit }));
    assert.equal(client.calls.some(call => call.statement === "ROLLBACK"), true, mode);
    assert.equal(client.calls.some(call => call.statement === "COMMIT"), false, mode);
  }
});
