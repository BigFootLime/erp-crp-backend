import { refuse, sha256 } from "./legacy-import-files.mjs";

export async function assertImportDatabase(client, expectedDatabase, actorUserId) {
  if (!expectedDatabase || /template|^postgres$/i.test(expectedDatabase)) refuse("business import into templates forbidden");
  const actual = await client.query("SELECT current_database() AS name");
  if (actual.rows[0]?.name !== expectedDatabase) refuse("connected database differs from explicit target");
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) refuse("existing actor user required");
  const actor = await client.query("SELECT id FROM public.users WHERE id=$1", [actorUserId]);
  if (actor.rowCount !== 1) refuse("actor does not exist in target database");
}

/** All database staging facts commit together; file copy/AV happen before this transaction. */
export async function stageLegacyImport({ client, sourceSetSha256, manifest, semantics, plan, preparedFiles, actor, insertAudit }) {
  if (preparedFiles.length !== plan.files.length) refuse("prepared source coverage mismatch");
  const stagedFiles = new Map(preparedFiles.map(file => [file.relativePath, file]));
  for (const file of plan.files) {
    const prepared = stagedFiles.get(file.relativePath);
    if (!prepared || prepared.sha256 !== file.sha256 || prepared.sizeBytes !== file.sizeBytes ||
        prepared.scan?.status !== "clean" || prepared.scan?.mode !== "enforce") refuse("source scan/copy coverage mismatch");
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["metrology-legacy-import:" + sourceSetSha256]);
    const prior = await client.query("SELECT id::text,status FROM public.metrologie_import_batches WHERE source_set_sha256=$1 FOR UPDATE", [sourceSetSha256]);
    if (prior.rowCount) {
      await client.query("COMMIT");
      return { batch_id: prior.rows[0].id, status: prior.rows[0].status, replay: true };
    }
    const scanReceipt = preparedFiles.map(file => ({
      source: file.relativePath, sha256: file.sha256, size_bytes: file.sizeBytes, ...file.scan,
    }));
    const inserted = await client.query([
      "INSERT INTO public.metrologie_import_batches(source_set_sha256,parser_version,status,manifest,reconciliation,created_by)",
      "VALUES($1,$2,'STAGED',$3::jsonb,$4::jsonb,$5) RETURNING id::text",
    ].join(" "), [
      sourceSetSha256, manifest.parserVersion,
      JSON.stringify({ ...manifest, semantic_sidecar: semantics, summary: plan.summary }),
      JSON.stringify({ ...plan.summary, scan_receipt_sha256: sha256(JSON.stringify(scanReceipt)), scans: scanReceipt }),
      actor.user_id,
    ]);
    const batchId = inserted.rows[0].id;
    const sourceIds = new Map();
    for (const file of preparedFiles) {
      const row = await client.query([
        "INSERT INTO public.metrologie_import_source_files",
        "(batch_id,source_name,sha256,mime_type,storage_path,size_bytes,av_status,av_scanned_at)",
        "VALUES($1,$2,$3,$4,$5,$6,'CLEAN',$7) RETURNING id::text",
      ].join(" "), [batchId, file.relativePath, file.sha256, file.mimeType, file.storagePath, file.sizeBytes, file.scan.scanned_at]);
      sourceIds.set(file.relativePath, row.rows[0].id);
    }
    for (const record of plan.records) {
      const sourceId = sourceIds.get(record.source);
      if (!sourceId) refuse("record source missing from staged copy");
      await client.query([
        "INSERT INTO public.metrologie_import_raw_rows",
        "(source_file_id,sheet_name,source_coordinate,row_sha256,source_equipment_key,raw_cells,normalized,disposition,diagnostic)",
        "VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb)",
      ].join(" "), [sourceId, record.sheet, record.coordinate, record.sha256, record.key,
        JSON.stringify(record.raw), JSON.stringify(record.normalized), record.disposition, JSON.stringify(record.diagnostics)]);
    }
    await insertAudit(client, actor, {
      action: "metrologie.legacy_import.stage", entity_type: "metrologie_import_batches", entity_id: batchId,
      details: { source_set_sha256: sourceSetSha256, ...plan.summary },
    });
    await client.query("COMMIT");
    return { batch_id: batchId, status: "STAGED", replay: false, source_set_sha256: sourceSetSha256, ...plan.summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
