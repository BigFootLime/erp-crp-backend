import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import db from "../../../config/database";
import { transferSecureUploadToDestination } from "../../../shared/uploads/secure-upload";
import { classifyUploadReconciliation, withUploadTransaction } from "../../../shared/uploads/upload-transaction";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import type { StockDocument } from "../types/stock.types";
import type { ArticleDocumentMetadataDTO } from "../validators/stock.validators";
import { insertAuditLog, type AuditContext } from "./stock-movement-core.repository";
import { repoListArticleDocuments } from "./stock-document-reads.repository";

type UploadedDocument = Express.Multer.File;

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase();
  const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
  return safeExt;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

type StockDocumentRow = {
  id: string;
  original_name: string;
  stored_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: string;
  sha256: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
  uploaded_by: number | null;
  removed_at: string | null;
  removed_by: number | null;
};

async function insertStockDocuments(
  client: PoolClient,
  documents: UploadedDocument[],
  audit: AuditContext,
  baseDirRel: string
): Promise<StockDocumentRow[]> {
  if (!documents.length) return [];

  const baseDirAbs = path.resolve(baseDirRel);
  await fs.mkdir(baseDirAbs, { recursive: true });

  const inserted: StockDocumentRow[] = [];
  for (const doc of documents) {
    const documentId = crypto.randomUUID();
    const safeExt = safeDocExtension(doc.originalname);
    const storedName = `${documentId}${safeExt}`;
    const relPath = toPosixPath(path.join(baseDirRel, storedName));
    const absPath = path.join(baseDirAbs, storedName);
    await transferSecureUploadToDestination(doc, absPath);

    const hash = await sha256File(absPath);

    await client.query(
      `
        INSERT INTO public.documents (id, title, file_path, mime_type, kind)
        VALUES ($1::uuid,$2,$3,$4,$5)
      `,
      [documentId, doc.originalname, relPath, doc.mimetype, "stock"]
    );

    const ins = await client.query<StockDocumentRow>(
      `
        INSERT INTO public.stock_documents (
          id, original_name, stored_name, storage_path, mime_type, size_bytes,
          sha256, label, uploaded_by,
          created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
        RETURNING
          id::text AS id,
          original_name,
          stored_name,
          storage_path,
          mime_type,
          size_bytes::text AS size_bytes,
          sha256,
          label,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          uploaded_by,
          removed_at::text AS removed_at,
          removed_by
      `,
      [documentId, doc.originalname, storedName, relPath, doc.mimetype, doc.size, hash, null, audit.user_id]
    );
    const row = ins.rows[0];
    if (!row) throw new Error("Failed to insert stock document");
    inserted.push(row);
  }

  return inserted;
}

export async function repoAttachArticleDocuments(
  articleId: string,
  documents: UploadedDocument[],
  metadata: ArticleDocumentMetadataDTO,
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const docsDirRel = ensureDocumentStoragePath("stock", "articles");
  const client = await db.connect();
  let expected: Array<{ id: string; key: string; absolutePath: string }> = [];
  const result = await withUploadTransaction({
    client,
    files: documents,
    context: "stock.articles.documents.attach",
    work: async () => {

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    if (!exists.rows[0]?.ok) {
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    expected = inserted.map((document) => ({
      id: document.id,
      key: `${articleId}|${document.id}|${document.sha256 ?? ""}|${document.storage_path}`,
      absolutePath: path.resolve(document.storage_path),
    }));
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.article_documents (
            article_id, document_id, type, revision, version, is_active,
            uploaded_by, created_by, updated_by
          )
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,true,$6,$6,$6)
          ON CONFLICT DO NOTHING
        `,
        [articleId, d.id, metadata.type ?? null, metadata.revision ?? null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.attach",
      entity_type: "articles",
      entity_id: articleId,
      details: {
        count: inserted.length,
        metadata,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      },
    });

    return inserted;
    },
    reconcile: async () => {
      if (expected.length === 0) return "committed";
      const { rows } = await db.query<{ article_id: string | null; id: string; sha256: string | null; storage_path: string }>(
        `SELECT ad.article_id::text AS article_id, sd.id::text AS id, sd.sha256, sd.storage_path
           FROM public.stock_documents sd
           LEFT JOIN public.article_documents ad
             ON ad.document_id = sd.id AND ad.article_id = $1::uuid
          WHERE sd.id = ANY($2::uuid[])`,
        [articleId, expected.map((entry) => entry.id)]
      );
      const status = classifyUploadReconciliation(
        expected.map((entry) => entry.key),
        rows.map((row) => `${row.article_id ?? ""}|${row.id}|${row.sha256 ?? ""}|${row.storage_path}`)
      );
      if (status !== "committed") return status;
      const present = await Promise.all(expected.map((entry) => fs.stat(entry.absolutePath).then((stat) => stat.isFile()).catch(() => false)));
      return present.every(Boolean) ? "committed" : "uncertain";
    },
  });
  if (result === null) return null;
  return repoListArticleDocuments(articleId);
}

export async function repoRemoveArticleDocument(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.articles WHERE id = $1::uuid FOR UPDATE`,
      [articleId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `UPDATE public.article_documents
       SET is_active = false,
           retired_at = now(),
           retired_by = $3,
           updated_at = now(),
           updated_by = $3
       WHERE article_id = $1::uuid
         AND document_id = $2::uuid
         AND is_active = true`,
      [articleId, documentId, audit.user_id]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertAuditLog(client, audit, {
      action: "stock.articles.documents.remove",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { article_id: articleId },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetArticleDocumentForDownload(
  articleId: string,
  documentId: string,
  audit: AuditContext
): Promise<{ storage_path: string; mime_type: string; original_name: string } | null> {
  const res = await db.query<{ storage_path: string; mime_type: string; original_name: string }>(
    `
      SELECT
        sd.storage_path,
        sd.mime_type,
        sd.original_name
      FROM public.article_documents ad
      JOIN public.stock_documents sd ON sd.id = ad.document_id
      WHERE ad.article_id = $1::uuid
        AND ad.document_id = $2::uuid
        AND ad.is_active = true
        AND sd.removed_at IS NULL
      LIMIT 1
    `,
    [articleId, documentId]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  await insertAuditLog(db, audit, {
    action: "stock.articles.documents.download",
    entity_type: "stock_documents",
    entity_id: documentId,
    details: { article_id: articleId, original_name: row.original_name },
  });

  return row;
}
export async function repoListMovementDocuments(movementId: string): Promise<StockDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid`,
    [movementId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<StockDocument>(
    `
      SELECT
        sd.id::text AS document_id,
        sd.original_name AS document_name,
        md.type
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1::uuid
        AND sd.removed_at IS NULL
      ORDER BY md.created_at DESC, md.id DESC
    `,
    [movementId]
  );
  return res.rows;
}

export async function repoAttachMovementDocuments(
  movementId: string,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<StockDocument[] | null> {
  const docsDirRel = ensureDocumentStoragePath("stock", "movements");
  const client = await db.connect();
  let expected: Array<{ id: string; key: string; absolutePath: string }> = [];
  const result = await withUploadTransaction({
    client,
    files: documents,
    context: "stock.movements.documents.attach",
    work: async () => {

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      return null;
    }

    const inserted = await insertStockDocuments(client, documents, audit, docsDirRel);
    expected = inserted.map((document) => ({
      id: document.id,
      key: `${movementId}|${document.id}|${document.sha256 ?? ""}|${document.storage_path}`,
      absolutePath: path.resolve(document.storage_path),
    }));
    for (const d of inserted) {
      await client.query(
        `
          INSERT INTO public.stock_movement_documents (stock_movement_id, document_id, type, version, uploaded_by, created_by, updated_by)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$5,$5)
          ON CONFLICT DO NOTHING
        `,
        [movementId, d.id, null, 1, audit.user_id]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.attach",
      entity_type: "stock_movements",
      entity_id: movementId,
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      },
    });

    return inserted;
    },
    reconcile: async () => {
      if (expected.length === 0) return "committed";
      const { rows } = await db.query<{ stock_movement_id: string | null; id: string; sha256: string | null; storage_path: string }>(
        `SELECT md.stock_movement_id::text AS stock_movement_id, sd.id::text AS id, sd.sha256, sd.storage_path
           FROM public.stock_documents sd
           LEFT JOIN public.stock_movement_documents md
             ON md.document_id = sd.id AND md.stock_movement_id = $1::uuid
          WHERE sd.id = ANY($2::uuid[])`,
        [movementId, expected.map((entry) => entry.id)]
      );
      const status = classifyUploadReconciliation(
        expected.map((entry) => entry.key),
        rows.map((row) => `${row.stock_movement_id ?? ""}|${row.id}|${row.sha256 ?? ""}|${row.storage_path}`)
      );
      if (status !== "committed") return status;
      const present = await Promise.all(expected.map((entry) => fs.stat(entry.absolutePath).then((stat) => stat.isFile()).catch(() => false)));
      return present.every(Boolean) ? "committed" : "uncertain";
    },
  });
  if (result === null) return null;
  return repoListMovementDocuments(movementId);
}

export async function repoRemoveMovementDocument(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ ok: number }>(
      `SELECT 1::int AS ok FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [movementId]
    );
    if (!exists.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const del = await client.query(
      `DELETE FROM public.stock_movement_documents WHERE stock_movement_id = $1::uuid AND document_id = $2::uuid`,
      [movementId, documentId]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `UPDATE public.stock_documents SET removed_at = now(), removed_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1::uuid AND removed_at IS NULL`,
      [documentId, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.movements.documents.remove",
      entity_type: "stock_documents",
      entity_id: documentId,
      details: { stock_movement_id: movementId },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetMovementDocumentForDownload(
  movementId: string,
  documentId: string,
  audit: AuditContext
): Promise<{ storage_path: string; mime_type: string; original_name: string } | null> {
  const res = await db.query<{ storage_path: string; mime_type: string; original_name: string }>(
    `
      SELECT
        sd.storage_path,
        sd.mime_type,
        sd.original_name
      FROM public.stock_movement_documents md
      JOIN public.stock_documents sd ON sd.id = md.document_id
      WHERE md.stock_movement_id = $1::uuid
        AND md.document_id = $2::uuid
        AND sd.removed_at IS NULL
      LIMIT 1
    `,
    [movementId, documentId]
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  await insertAuditLog(db, audit, {
    action: "stock.movements.documents.download",
    entity_type: "stock_documents",
    entity_id: documentId,
    details: { stock_movement_id: movementId, original_name: row.original_name },
  });

  return row;
}
