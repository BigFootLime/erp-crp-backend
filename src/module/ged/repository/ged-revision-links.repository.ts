import type { PoolClient } from "pg";
import pool from "../../../config/database";

type Db = Pick<PoolClient, "query">;
export type ReusableRevisionDocument = {
  id: string; code: string; title: string; class_key: string;
  version_id: string; status: string; original_name: string;
};

/** Every revision must still exist and belong to exactly one live business piece. */
export async function repoResolveRevisionBusinessParent(ids: string[], db: Db = pool): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  const result = await db.query<{ id: string; piece_id: string }>(
    `SELECT v.id::text, p.id::text AS piece_id
       FROM public.piece_technique_versions v
       JOIN public.pieces_techniques p ON p.id = v.piece_technique_id
      WHERE v.id = ANY($1::uuid[])`, [unique]);
  const pieces = new Set(result.rows.map(row => row.piece_id));
  return result.rows.length === unique.length && pieces.size === 1 ? result.rows[0].piece_id : null;
}

export async function repoListReusableRevisionDocuments(revisionId: string): Promise<ReusableRevisionDocument[]> {
  const result = await pool.query<ReusableRevisionDocument>(
    `SELECT d.id::text, d.code, d.title, d.class_key, cv.id::text AS version_id,
            cv.status, cv.original_name
       FROM public.ged_documents d
       JOIN public.ged_document_versions cv ON cv.id = d.current_version_id
       JOIN public.ged_upload_sessions s ON s.id = cv.upload_session_id
       JOIN public.piece_technique_versions target ON target.id = $1::uuid
      WHERE d.archived_at IS NULL AND cv.status <> 'OBSOLETE'
        AND d.class_key IN ('PLAN_CLIENT', 'GAMME_DOC')
        AND s.scan_status = 'clean' AND s.quarantine_status = 'released'
        AND target.statut <> 'OBSOLETE'
        AND EXISTS (SELECT 1 FROM public.ged_document_links l WHERE l.document_id = d.id)
        AND NOT EXISTS (
          SELECT 1 FROM public.ged_document_links l
          LEFT JOIN public.piece_technique_versions source ON source.id::text = l.entity_id
          WHERE l.document_id = d.id AND
            (l.entity_type <> 'PIECE_TECHNIQUE_VERSION' OR source.id IS NULL
             OR source.piece_technique_id <> target.piece_technique_id))
      ORDER BY d.updated_at DESC, d.id LIMIT 100`, [revisionId]);
  return result.rows;
}

export async function repoLockRevisionDocument(db: Db, documentId: string) {
  const doc = await db.query<{ id: string; class_key: string; current_version_id: string; archived_at: string | null }>(
    `SELECT id::text, class_key, current_version_id::text, archived_at
       FROM public.ged_documents WHERE id = $1::uuid FOR UPDATE`, [documentId]);
  if (!doc.rows[0]) return null;
  const version = await db.query<{ id: string; status: string; scan_status: string; quarantine_status: string }>(
    `SELECT v.id::text, v.status, s.scan_status, s.quarantine_status
       FROM public.ged_document_versions v
       JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
      WHERE v.id = $1::uuid FOR SHARE OF v, s`, [doc.rows[0].current_version_id]);
  if (!version.rows[0]) return null;
  const links = await db.query<{ entity_type: string; entity_id: string }>(
    `SELECT entity_type, entity_id FROM public.ged_document_links
      WHERE document_id = $1::uuid ORDER BY id FOR SHARE`, [documentId]);
  return { document: doc.rows[0], version: version.rows[0], links: links.rows };
}

export async function repoLockPieceRevisions(db: Db, ids: string[]) {
  const result = await db.query<{ id: string; piece_id: string; statut: string }>(
    `SELECT v.id::text, v.piece_technique_id::text AS piece_id, v.statut
       FROM public.piece_technique_versions v
       JOIN public.pieces_techniques p ON p.id = v.piece_technique_id
      WHERE v.id = ANY($1::uuid[]) ORDER BY v.id FOR SHARE OF v, p`, [[...new Set(ids)]]);
  return result.rows;
}
