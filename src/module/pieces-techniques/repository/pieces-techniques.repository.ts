// src/module/pieces-techniques/repository/pieces-techniques.repository.ts
import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  Achat,
  AffairePieceTechniqueLink,
  BomLine,
  Operation,
  Paginated,
  PieceTechnique,
  PieceTechniqueAffaireLink,
  PieceTechniqueDocument,
  PieceTechniqueHistoryEntry,
  PieceTechniqueListItem,
  PieceTechniqueStatut,
} from "../types/pieces-techniques.types";
import type {
  AddAchatBodyDTO,
  AddBomLineBodyDTO,
  AddOperationBodyDTO,
  CreatePieceTechniqueBodyDTO,
  ListPiecesTechniquesQueryDTO,
  UpdateAchatBodyDTO,
  UpdateBomLineBodyDTO,
  UpdateOperationBodyDTO,
  UpdatePieceTechniqueBodyDTO,
} from "../validators/pieces-techniques.validators";

export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

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

async function insertAuditLog(tx: Pick<PoolClient, "query">, audit: AuditContext, entry: {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details?: Record<string, unknown> | null;
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function mapCoreRow(row: PieceTechniqueCoreRow): PieceTechnique {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client_id: row.client_id,
    created_by: row.created_by,
    updated_by: row.updated_by,
    famille_id: row.famille_id,
    name_piece: row.name_piece,
    code_piece: row.code_piece,
    designation: row.designation,
    designation_2: row.designation_2,
    prix_unitaire: row.prix_unitaire,
    statut: row.statut,
    en_fabrication: (row.en_fabrication ?? 0) === 1,
    cycle: row.cycle,
    cycle_fabrication: row.cycle_fabrication,
    code_client: row.code_client,
    client_name: row.client_name,
    ensemble: row.ensemble,
    bom: [],
    operations: [],
    achats: [],
  };
}

type PieceTechniqueCoreRow = {
  id: string;
  created_at: string;
  updated_at: string;
  client_id: string | null;
  created_by: number | null;
  updated_by: number | null;
  famille_id: string;
  name_piece: string;
  code_piece: string;
  designation: string;
  designation_2: string | null;
  prix_unitaire: number;
  statut: PieceTechniqueStatut;
  en_fabrication: number;
  cycle: number | null;
  cycle_fabrication: number | null;
  code_client: string | null;
  client_name: string | null;
  ensemble: boolean;
};

function includesSetForCreate(): Set<string> {
  return new Set(["nomenclature", "operations", "achats", "history"]);
}

function buildListWhere(filters: ListPiecesTechniquesQueryDTO) {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  // Soft-delete filter (keep list stable and audit-friendly).
  where.push(`p.deleted_at IS NULL`);

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(p.code_piece ILIKE ${p} OR p.designation ILIKE ${p} OR p.name_piece ILIKE ${p})`);
  }
  if (filters.client_id) where.push(`p.client_id = ${push(filters.client_id)}`);
  if (filters.famille_id) where.push(`p.famille_id = ${push(filters.famille_id)}::uuid`);
  if (filters.statut) where.push(`p.statut = ${push(filters.statut)}`);

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

function sortColumn(sortBy: ListPiecesTechniquesQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "created_at":
      return "p.created_at";
    case "code_piece":
      return "p.code_piece";
    case "designation":
      return "p.designation";
    case "prix_unitaire":
      return "p.prix_unitaire";
    case "statut":
      return "p.statut";
    case "updated_at":
    default:
      return "p.updated_at";
  }
}

function sortDirection(sortDir: ListPiecesTechniquesQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

export async function repoListPieceTechniques(filters: ListPiecesTechniquesQueryDTO): Promise<Paginated<PieceTechniqueListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const { whereSql, values } = buildListWhere(filters);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM pieces_techniques p
    ${whereSql}
  `;
  const countRes = await db.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      p.id::text AS id,
      p.code_piece,
      p.designation,
      p.designation_2,
      p.client_id,
      p.client_name,
      p.famille_id::text AS famille_id,
      f.code AS famille_code,
      f.designation AS famille_designation,
      p.statut::text AS statut,
      (p.en_fabrication::int = 1) AS en_fabrication,
      p.prix_unitaire::float8 AS prix_unitaire,
      p.ensemble,
      p.created_at::text AS created_at,
      p.updated_at::text AS updated_at,
      COALESCE(nb.bom_count, 0)::int AS bom_count,
      COALESCE(no.operations_count, 0)::int AS operations_count,
      COALESCE(na.achats_count, 0)::int AS achats_count,
      COALESCE(no.cout_mo_total, 0)::float8 AS cout_mo_total,
      COALESCE(na.achats_total_ht, 0)::float8 AS achats_total_ht
    FROM pieces_techniques p
    LEFT JOIN pieces_families f ON f.id = p.famille_id
    LEFT JOIN (
      SELECT parent_piece_technique_id, COUNT(*)::int AS bom_count
      FROM pieces_techniques_nomenclature
      GROUP BY parent_piece_technique_id
    ) nb ON nb.parent_piece_technique_id = p.id
    LEFT JOIN (
      SELECT piece_technique_id,
             COUNT(*)::int AS operations_count,
             COALESCE(SUM(cout_mo), 0)::float8 AS cout_mo_total
      FROM pieces_techniques_operations
      GROUP BY piece_technique_id
    ) no ON no.piece_technique_id = p.id
    LEFT JOIN (
      SELECT piece_technique_id,
             COUNT(*)::int AS achats_count,
             COALESCE(SUM(total_achat_ht), 0)::float8 AS achats_total_ht
      FROM pieces_techniques_achats
      GROUP BY piece_technique_id
    ) na ON na.piece_technique_id = p.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  type Row = Omit<PieceTechniqueListItem, "en_fabrication"> & {
    en_fabrication: boolean;
    statut: PieceTechniqueStatut;
  };
  const dataRes = await db.query<Row>(dataSql, [...values, pageSize, offset]);
  return { items: dataRes.rows, total };
}

export async function repoGetPieceTechnique(id: string, includes: Set<string>): Promise<PieceTechnique | null> {
  const coreSql = `
    SELECT
      p.id::text AS id,
      p.created_at::text AS created_at,
      p.updated_at::text AS updated_at,
      p.client_id,
      p.created_by,
      p.updated_by,
      p.famille_id::text AS famille_id,
      p.name_piece,
      p.code_piece,
      p.designation,
      p.designation_2,
      p.prix_unitaire::float8 AS prix_unitaire,
      p.statut::text AS statut,
      p.en_fabrication::int AS en_fabrication,
      p.cycle,
      p.cycle_fabrication,
      p.code_client,
      p.client_name,
      p.ensemble
    FROM pieces_techniques p
    WHERE p.id = $1::uuid
      AND p.deleted_at IS NULL
  `;
  const coreRes = await db.query<PieceTechniqueCoreRow>(coreSql, [id]);
  const core = coreRes.rows[0];
  if (!core) return null;

  const out = mapCoreRow(core);

  if (includes.has("nomenclature")) out.bom = await repoListBomLines(id);
  if (includes.has("operations")) out.operations = await repoListOperations(id);
  if (includes.has("achats")) out.achats = await repoListAchats(id);
  if (includes.has("history")) out.history = await repoListHistory(id);
  if (includes.has("documents")) out.documents = (await repoListPieceTechniqueDocuments(id)) ?? [];
  if (includes.has("affaires")) out.affaires = (await repoListPieceTechniqueAffaires(id)) ?? [];

  return out;
}

type PieceTechniqueAffaireLinkRow = {
  affaire_id: string;
  piece_technique_id: string;
  role: string;
  created_at: string;
  created_by: number | null;
  affaire_reference: string;
  affaire_client_id: string | null;
  affaire_statut: string;
};

function toFiniteNumber(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${label}`);
  return n;
}

function mapAffaireLinkRow(r: PieceTechniqueAffaireLinkRow): PieceTechniqueAffaireLink {
  return {
    affaire_id: toFiniteNumber(r.affaire_id, "affaire_id"),
    piece_technique_id: r.piece_technique_id,
    role: r.role,
    created_at: r.created_at,
    created_by: r.created_by,
    affaire_reference: r.affaire_reference,
    affaire_client_id: r.affaire_client_id ?? "",
    affaire_statut: r.affaire_statut,
  };
}

export async function repoListPieceTechniqueAffaires(pieceTechniqueId: string): Promise<PieceTechniqueAffaireLink[] | null> {
  const exists = await db.query<{ ok: number }>(
    "SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL",
    [pieceTechniqueId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<PieceTechniqueAffaireLinkRow>(
    `
      SELECT
        apt.affaire_id::text AS affaire_id,
        apt.piece_technique_id::text AS piece_technique_id,
        apt.role,
        apt.created_at::text AS created_at,
        apt.created_by,
        a.reference AS affaire_reference,
        a.client_id AS affaire_client_id,
        a.statut AS affaire_statut
      FROM affaire_pieces_techniques apt
      JOIN affaire a ON a.id = apt.affaire_id
      WHERE apt.piece_technique_id = $1::uuid
      ORDER BY (apt.role = 'MAIN') DESC, apt.created_at DESC
    `,
    [pieceTechniqueId]
  );

  return res.rows.map(mapAffaireLinkRow);
}

async function ensureAffaireExists(client: PoolClient, affaireId: number): Promise<{ reference: string; client_id: string | null; statut: string } | null> {
  const res = await client.query<{ reference: string; client_id: string | null; statut: string }>(
    `
      SELECT reference, client_id, statut
      FROM affaire
      WHERE id = $1
    `,
    [affaireId]
  );
  return res.rows[0] ?? null;
}

export async function repoUpsertPieceTechniqueAffaireLink(
  pieceTechniqueId: string,
  affaireId: number,
  role: "MAIN" | "LINKED",
  audit: AuditContext
): Promise<PieceTechniqueAffaireLink[] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const pieceExists = await ensurePieceTechniqueExists(client, pieceTechniqueId);
    if (!pieceExists) {
      await client.query("ROLLBACK");
      return null;
    }

    const affaire = await ensureAffaireExists(client, affaireId);
    if (!affaire) {
      throw new HttpError(404, "AFFAIRE_NOT_FOUND", "Affaire not found");
    }

    const existing = await client.query<{ role: string }>(
      `
        SELECT role
        FROM affaire_pieces_techniques
        WHERE affaire_id = $1 AND piece_technique_id = $2::uuid
        FOR UPDATE
      `,
      [affaireId, pieceTechniqueId]
    );
    const prevRole = existing.rows[0]?.role ?? null;

    let prevMainPieceTechniqueId: string | null = null;
    if (role === "MAIN") {
      const prevMain = await client.query<{ piece_technique_id: string }>(
        `
          SELECT piece_technique_id::text AS piece_technique_id
          FROM affaire_pieces_techniques
          WHERE affaire_id = $1 AND role = 'MAIN'
          FOR UPDATE
        `,
        [affaireId]
      );
      prevMainPieceTechniqueId = prevMain.rows[0]?.piece_technique_id ?? null;

      await client.query(
        `
          UPDATE affaire_pieces_techniques
          SET role = 'LINKED'
          WHERE affaire_id = $1 AND role = 'MAIN'
        `,
        [affaireId]
      );
    }

    await client.query(
      `
        INSERT INTO affaire_pieces_techniques (affaire_id, piece_technique_id, role, created_by)
        VALUES ($1, $2::uuid, $3, $4)
        ON CONFLICT (affaire_id, piece_technique_id)
        DO UPDATE SET role = EXCLUDED.role
      `,
      [affaireId, pieceTechniqueId, role, audit.user_id]
    );

    const action = prevRole === null ? "pieces-techniques.affaires.link" : "pieces-techniques.affaires.update";
    await insertAuditLog(client, audit, {
      action,
      entity_type: "pieces_techniques",
      entity_id: pieceTechniqueId,
      details: {
        affaire_id: affaireId,
        affaire_reference: affaire.reference,
        role,
        prev_role: prevRole,
        prev_main_piece_technique_id: prevMainPieceTechniqueId,
      },
    });

    await client.query("COMMIT");
    return repoListPieceTechniqueAffaires(pieceTechniqueId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUnlinkPieceTechniqueFromAffaire(
  pieceTechniqueId: string,
  affaireId: number,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const pieceExists = await ensurePieceTechniqueExists(client, pieceTechniqueId);
    if (!pieceExists) {
      await client.query("ROLLBACK");
      return null;
    }

    const row = await client.query<{ role: string }>(
      `
        SELECT role
        FROM affaire_pieces_techniques
        WHERE affaire_id = $1 AND piece_technique_id = $2::uuid
        FOR UPDATE
      `,
      [affaireId, pieceTechniqueId]
    );
    const prevRole = row.rows[0]?.role ?? null;
    if (!prevRole) {
      await client.query("ROLLBACK");
      return false;
    }

    const del = await client.query(
      `DELETE FROM affaire_pieces_techniques WHERE affaire_id = $1 AND piece_technique_id = $2::uuid`,
      [affaireId, pieceTechniqueId]
    );
    const removed = (del.rowCount ?? 0) > 0;
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.affaires.unlink",
      entity_type: "pieces_techniques",
      entity_id: pieceTechniqueId,
      details: {
        affaire_id: affaireId,
        prev_role: prevRole,
      },
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

type AffairePieceTechniqueLinkRow = {
  affaire_id: string;
  piece_technique_id: string;
  role: string;
  created_at: string;
  created_by: number | null;
  code_piece: string;
  designation: string;
  designation_2: string | null;
  statut: PieceTechniqueStatut;
  updated_at: string;
};

function mapAffairePieceTechniqueLinkRow(r: AffairePieceTechniqueLinkRow): AffairePieceTechniqueLink {
  return {
    affaire_id: toFiniteNumber(r.affaire_id, "affaire_id"),
    piece_technique_id: r.piece_technique_id,
    role: r.role,
    created_at: r.created_at,
    created_by: r.created_by,
    code_piece: r.code_piece,
    designation: r.designation,
    designation_2: r.designation_2,
    statut: r.statut,
    updated_at: r.updated_at,
  };
}

export async function repoListAffairePieceTechniques(affaireId: number): Promise<AffairePieceTechniqueLink[] | null> {
  const exists = await db.query<{ ok: number }>("SELECT 1::int AS ok FROM affaire WHERE id = $1", [affaireId]);
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<AffairePieceTechniqueLinkRow>(
    `
      SELECT
        apt.affaire_id::text AS affaire_id,
        apt.piece_technique_id::text AS piece_technique_id,
        apt.role,
        apt.created_at::text AS created_at,
        apt.created_by,
        p.code_piece,
        p.designation,
        p.designation_2,
        p.statut::text AS statut,
        p.updated_at::text AS updated_at
      FROM affaire_pieces_techniques apt
      JOIN pieces_techniques p
        ON p.id = apt.piece_technique_id
       AND p.deleted_at IS NULL
      WHERE apt.affaire_id = $1
      ORDER BY (apt.role = 'MAIN') DESC, apt.created_at DESC
    `,
    [affaireId]
  );

  return res.rows.map(mapAffairePieceTechniqueLinkRow);
}

type PieceTechniqueDocumentRow = {
  id: string;
  piece_technique_id: string;
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

function mapDocRow(r: PieceTechniqueDocumentRow): PieceTechniqueDocument {
  return {
    id: r.id,
    piece_technique_id: r.piece_technique_id,
    original_name: r.original_name,
    stored_name: r.stored_name,
    storage_path: r.storage_path,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    label: r.label,
    created_at: r.created_at,
    updated_at: r.updated_at,
    uploaded_by: r.uploaded_by,
    removed_at: r.removed_at,
    removed_by: r.removed_by,
  };
}

export async function repoListPieceTechniqueDocuments(pieceTechniqueId: string): Promise<PieceTechniqueDocument[] | null> {
  const exists = await db.query<{ ok: number }>(
    "SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL",
    [pieceTechniqueId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<PieceTechniqueDocumentRow>(
    `
      SELECT
        id::text AS id,
        piece_technique_id::text AS piece_technique_id,
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
      FROM pieces_techniques_documents
      WHERE piece_technique_id = $1::uuid
        AND removed_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
    [pieceTechniqueId]
  );
  return res.rows.map(mapDocRow);
}

export async function repoAttachPieceTechniqueDocuments(
  pieceTechniqueId: string,
  documents: UploadedDocument[],
  audit: AuditContext
): Promise<PieceTechniqueDocument[] | null> {
  const client = await db.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "pieces-techniques");
  const docsDirAbs = path.resolve(docsDirRel);

  try {
    await client.query("BEGIN");

    const exists = await ensurePieceTechniqueExists(client, pieceTechniqueId);
    if (!exists) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!documents.length) {
      await client.query("COMMIT");
      return [];
    }

    await fs.mkdir(docsDirAbs, { recursive: true });

    const inserted: PieceTechniqueDocument[] = [];
    for (const doc of documents) {
      const documentId = crypto.randomUUID();
      const safeExt = safeDocExtension(doc.originalname);
      const storedName = `${documentId}${safeExt}`;
      const relPath = toPosixPath(path.join(docsDirRel, storedName));
      const absPath = path.join(docsDirAbs, storedName);
      const tempPath = path.resolve(doc.path);

      try {
        await fs.rename(tempPath, absPath);
      } catch {
        // Fallback for cross-device issues
        await fs.copyFile(tempPath, absPath);
        await fs.unlink(tempPath);
      }

      const hash = await sha256File(absPath);
      const ins = await client.query<PieceTechniqueDocumentRow>(
        `
          INSERT INTO pieces_techniques_documents (
            piece_technique_id,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes,
            sha256,
            label,
            uploaded_by
          )
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING
            id::text AS id,
            piece_technique_id::text AS piece_technique_id,
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
        [
          pieceTechniqueId,
          doc.originalname,
          storedName,
          relPath,
          doc.mimetype,
          doc.size,
          hash,
          null,
          audit.user_id,
        ]
      );

      const row = ins.rows[0];
      if (!row) throw new Error("Failed to insert piece technique document");
      inserted.push(mapDocRow(row));
    }

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.documents.attach",
      entity_type: "pieces_techniques",
      entity_id: pieceTechniqueId,
      details: {
        count: inserted.length,
        documents: inserted.map((d) => ({
          id: d.id,
          original_name: d.original_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
          sha256: d.sha256,
        })),
      },
    });

    await client.query("COMMIT");
    return inserted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoRemovePieceTechniqueDocument(
  pieceTechniqueId: string,
  documentId: string,
  audit: AuditContext
): Promise<boolean | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await ensurePieceTechniqueExists(client, pieceTechniqueId);
    if (!exists) {
      await client.query("ROLLBACK");
      return null;
    }

    const current = await client.query<Pick<PieceTechniqueDocumentRow, "original_name" | "storage_path">>(
      `
        SELECT original_name, storage_path
        FROM pieces_techniques_documents
        WHERE id = $1::uuid AND piece_technique_id = $2::uuid AND removed_at IS NULL
        FOR UPDATE
      `,
      [documentId, pieceTechniqueId]
    );
    const doc = current.rows[0] ?? null;
    if (!doc) {
      await client.query("ROLLBACK");
      return false;
    }

    const upd = await client.query(
      `
        UPDATE pieces_techniques_documents
        SET removed_at = now(), removed_by = $3, updated_at = now()
        WHERE id = $1::uuid AND piece_technique_id = $2::uuid AND removed_at IS NULL
      `,
      [documentId, pieceTechniqueId, audit.user_id]
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.documents.remove",
      entity_type: "pieces_techniques_documents",
      entity_id: documentId,
      details: {
        piece_technique_id: pieceTechniqueId,
        original_name: doc.original_name,
        storage_path: doc.storage_path,
      },
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

export async function repoGetPieceTechniqueDocumentForDownload(
  pieceTechniqueId: string,
  documentId: string,
  audit: AuditContext
): Promise<PieceTechniqueDocument | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await ensurePieceTechniqueExists(client, pieceTechniqueId);
    if (!exists) {
      await client.query("ROLLBACK");
      return null;
    }

    const res = await client.query<PieceTechniqueDocumentRow>(
      `
        SELECT
          id::text AS id,
          piece_technique_id::text AS piece_technique_id,
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
        FROM pieces_techniques_documents
        WHERE id = $1::uuid
          AND piece_technique_id = $2::uuid
          AND removed_at IS NULL
      `,
      [documentId, pieceTechniqueId]
    );
    const row = res.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.documents.download",
      entity_type: "pieces_techniques_documents",
      entity_id: documentId,
      details: {
        piece_technique_id: pieceTechniqueId,
        original_name: row.original_name,
      },
    });

    await client.query("COMMIT");
    return mapDocRow(row);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

type BomRow = {
  id: string;
  child_piece_id: string;
  rang: number;
  quantite: number;
  repere: string | null;
  designation: string | null;
};

async function repoListBomLines(pieceTechniqueId: string): Promise<BomLine[]> {
  const sql = `
    SELECT
      id::text AS id,
      child_piece_technique_id::text AS child_piece_id,
      rang::int AS rang,
      quantite::float8 AS quantite,
      repere,
      designation
    FROM pieces_techniques_nomenclature
    WHERE parent_piece_technique_id = $1::uuid
    ORDER BY rang ASC, id ASC
  `;
  const res = await db.query<BomRow>(sql, [pieceTechniqueId]);
  return res.rows.map((r) => ({
    id: r.id,
    child_piece_id: r.child_piece_id,
    rang: r.rang,
    quantite: Number(r.quantite),
    repere: r.repere,
    designation: r.designation,
  }));
}

type OperationRow = {
  id: string;
  phase: number;
  designation: string;
  designation_2: string | null;
  cf_id: string | null;
  prix: number;
  coef: number;
  tp: number;
  tf_unit: number;
  qte: number;
  taux_horaire: number;
  temps_total: number;
  cout_mo: number;
};

async function repoListOperations(pieceTechniqueId: string): Promise<Operation[]> {
  const sql = `
    SELECT
      id::text AS id,
      phase::int AS phase,
      designation,
      designation_2,
      cf_id::text AS cf_id,
      prix::float8 AS prix,
      coef::float8 AS coef,
      tp::float8 AS tp,
      tf_unit::float8 AS tf_unit,
      qte::float8 AS qte,
      taux_horaire::float8 AS taux_horaire,
      temps_total::float8 AS temps_total,
      cout_mo::float8 AS cout_mo
    FROM pieces_techniques_operations
    WHERE piece_technique_id = $1::uuid
    ORDER BY phase ASC, id ASC
  `;
  const res = await db.query<OperationRow>(sql, [pieceTechniqueId]);
  return res.rows.map((r) => ({
    id: r.id,
    phase: r.phase,
    designation: r.designation,
    designation_2: r.designation_2,
    cf_id: r.cf_id,
    prix: Number(r.prix),
    coef: Number(r.coef),
    tp: Number(r.tp),
    tf_unit: Number(r.tf_unit),
    qte: Number(r.qte),
    taux_horaire: Number(r.taux_horaire),
    temps_total: Number(r.temps_total),
    cout_mo: Number(r.cout_mo),
  }));
}

type AchatRow = {
  id: string;
  phase: number | null;
  famille_piece_id: string | null;
  nom: string | null;
  fournisseur_id: string | null;
  fournisseur_nom: string | null;
  fournisseur_code: string | null;
  quantite: number;
  quantite_brut_mm: number | null;
  longueur_mm: number | null;
  coefficient_chute: number | null;
  quantite_pieces: number | null;
  prix_par_quantite: number | null;
  tarif: number | null;
  prix: number | null;
  unite_prix: string | null;
  pu_achat: number | null;
  tva_achat: number | null;
  total_achat_ht: number | null;
  total_achat_ttc: number | null;
  designation: string | null;
  designation_2: string | null;
  designation_3: string | null;
};

async function repoListAchats(pieceTechniqueId: string): Promise<Achat[]> {
  const sql = `
    SELECT
      id::text AS id,
      phase,
      famille_piece_id::text AS famille_piece_id,
      nom,
      fournisseur_id::text AS fournisseur_id,
      fournisseur_nom,
      fournisseur_code,
      quantite::float8 AS quantite,
      quantite_brut_mm::float8 AS quantite_brut_mm,
      longueur_mm::float8 AS longueur_mm,
      coefficient_chute::float8 AS coefficient_chute,
      quantite_pieces::float8 AS quantite_pieces,
      prix_par_quantite::float8 AS prix_par_quantite,
      tarif::float8 AS tarif,
      prix::float8 AS prix,
      unite_prix,
      pu_achat::float8 AS pu_achat,
      tva_achat::float8 AS tva_achat,
      total_achat_ht::float8 AS total_achat_ht,
      total_achat_ttc::float8 AS total_achat_ttc,
      designation,
      designation_2,
      designation_3
    FROM pieces_techniques_achats
    WHERE piece_technique_id = $1::uuid
    ORDER BY phase NULLS LAST, id ASC
  `;
  const res = await db.query<AchatRow>(sql, [pieceTechniqueId]);
  return res.rows.map((r) => ({
    id: r.id,
    phase: r.phase,
    famille_piece_id: r.famille_piece_id,
    nom: r.nom,
    fournisseur_id: r.fournisseur_id,
    fournisseur_nom: r.fournisseur_nom,
    fournisseur_code: r.fournisseur_code,
    quantite: Number(r.quantite),
    quantite_brut_mm: r.quantite_brut_mm === null ? null : Number(r.quantite_brut_mm),
    longueur_mm: r.longueur_mm === null ? null : Number(r.longueur_mm),
    coefficient_chute: r.coefficient_chute === null ? null : Number(r.coefficient_chute),
    quantite_pieces: r.quantite_pieces === null ? null : Number(r.quantite_pieces),
    prix_par_quantite: r.prix_par_quantite === null ? null : Number(r.prix_par_quantite),
    tarif: r.tarif === null ? null : Number(r.tarif),
    prix: r.prix === null ? null : Number(r.prix),
    unite_prix: r.unite_prix,
    pu_achat: r.pu_achat === null ? null : Number(r.pu_achat),
    tva_achat: r.tva_achat === null ? null : Number(r.tva_achat),
    total_achat_ht: r.total_achat_ht === null ? null : Number(r.total_achat_ht),
    total_achat_ttc: r.total_achat_ttc === null ? null : Number(r.total_achat_ttc),
    designation: r.designation,
    designation_2: r.designation_2,
    designation_3: r.designation_3,
  }));
}

type HistoryRow = {
  id: string;
  date_action: string;
  user_id: number | null;
  ancien_statut: PieceTechniqueStatut | null;
  nouveau_statut: PieceTechniqueStatut;
  commentaire: string | null;
};

async function repoListHistory(pieceTechniqueId: string): Promise<PieceTechniqueHistoryEntry[]> {
  const sql = `
    SELECT
      id::text AS id,
      date_action::text AS date_action,
      user_id,
      ancien_statut::text AS ancien_statut,
      nouveau_statut::text AS nouveau_statut,
      commentaire
    FROM pieces_techniques_historique
    WHERE piece_technique_id = $1::uuid
    ORDER BY date_action DESC, id DESC
  `;
  const res = await db.query<HistoryRow>(sql, [pieceTechniqueId]);
  return res.rows;
}

export async function repoCreatePieceTechnique(
  body: CreatePieceTechniqueBodyDTO & {
    statut: PieceTechniqueStatut;
    en_fabrication: boolean;
    operations: (AddOperationBodyDTO & { temps_total: number; cout_mo: number })[];
    achats: (AddAchatBodyDTO & { total_achat_ht: number; total_achat_ttc: number })[];
  },
  audit: AuditContext
): Promise<PieceTechnique> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const actorUserId = audit.user_id;
    const createdBy = actorUserId;
    const updatedBy = actorUserId;
    const insertMainSQL = `
      INSERT INTO pieces_techniques (
        client_id, created_by, updated_by,
        famille_id, name_piece, code_piece, designation, designation_2,
        prix_unitaire, statut, en_fabrication, cycle, cycle_fabrication,
        code_client, client_name, ensemble
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, $16
      )
      RETURNING
        id::text AS id,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        client_id,
        created_by,
        updated_by,
        famille_id::text AS famille_id,
        name_piece,
        code_piece,
        designation,
        designation_2,
        prix_unitaire::float8 AS prix_unitaire,
        statut::text AS statut,
        en_fabrication::int AS en_fabrication,
        cycle,
        cycle_fabrication,
        code_client,
        client_name,
        ensemble
    `;
    const mainParams = [
      body.client_id ?? null,
      createdBy,
      updatedBy,
      body.famille_id,
      body.name_piece,
      body.code_piece,
      body.designation,
      body.designation_2 ?? null,
      body.prix_unitaire,
      body.statut,
      body.en_fabrication ? 1 : 0,
      body.cycle ?? null,
      body.cycle_fabrication ?? null,
      body.code_client ?? null,
      body.client_name ?? null,
      body.ensemble,
    ];

    const mainRes = await client.query<PieceTechniqueCoreRow>(insertMainSQL, mainParams);
    const core = mainRes.rows[0];
    if (!core) throw new Error("Failed to create piece technique");

    const piece = mapCoreRow(core);
    const pieceId = core.id;

    piece.bom = await insertBomLines(client, pieceId, body.bom ?? []);
    piece.operations = await insertOperations(client, pieceId, body.operations ?? []);
    piece.achats = await insertAchats(client, pieceId, body.achats ?? []);

    const histComment = "Creation";
    const histRes = await client.query<Pick<PieceTechniqueHistoryEntry, "id" | "date_action">>(
      `
        INSERT INTO pieces_techniques_historique (piece_technique_id, user_id, ancien_statut, nouveau_statut, commentaire)
        VALUES ($1::uuid, $2, $3, $4, $5)
        RETURNING id::text AS id, date_action::text AS date_action
      `,
      [pieceId, actorUserId, null, body.statut, histComment]
    );
    const histRow = histRes.rows[0];
    piece.history = histRow
      ? [
          {
            id: histRow.id,
            date_action: histRow.date_action,
            user_id: actorUserId,
            ancien_statut: null,
            nouveau_statut: body.statut,
            commentaire: histComment,
          },
        ]
      : [];

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.create",
      entity_type: "pieces_techniques",
      entity_id: pieceId,
      details: {
        code_piece: body.code_piece,
        designation: body.designation,
        statut: body.statut,
        bom_count: piece.bom.length,
        operations_count: piece.operations.length,
        achats_count: piece.achats.length,
      },
    });

    await client.query("COMMIT");
    return piece;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function insertBomLines(client: PoolClient, pieceTechniqueId: string, bom: AddBomLineBodyDTO[]): Promise<BomLine[]> {
  if (!bom.length) return [];

  let nextRang = 10;
  const out: BomLine[] = [];
  for (let i = 0; i < bom.length; i++) {
    const l = bom[i];
    const rang = typeof l.rang === "number" ? l.rang : nextRang;
    nextRang = rang + 10;

    const res = await client.query<{
      id: string;
      child_piece_id: string;
      rang: number;
      quantite: number;
      repere: string | null;
      designation: string | null;
    }>(
      `
        INSERT INTO pieces_techniques_nomenclature (
          parent_piece_technique_id,
          child_piece_technique_id,
          rang,
          quantite,
          repere,
          designation
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
        RETURNING
          id::text AS id,
          child_piece_technique_id::text AS child_piece_id,
          rang::int AS rang,
          quantite::float8 AS quantite,
          repere,
          designation
      `,
      [pieceTechniqueId, l.child_piece_id, rang, l.quantite, l.repere ?? null, l.designation ?? null]
    );
    const r = res.rows[0];
    out.push({
      id: r.id,
      child_piece_id: r.child_piece_id,
      rang: r.rang,
      quantite: Number(r.quantite),
      repere: r.repere,
      designation: r.designation,
    });
  }
  return out;
}

async function insertOperations(
  client: PoolClient,
  pieceTechniqueId: string,
  operations: (AddOperationBodyDTO & { temps_total: number; cout_mo: number })[]
): Promise<Operation[]> {
  if (!operations.length) return [];
  const out: Operation[] = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const res = await client.query<OperationRow>(
      `
        INSERT INTO pieces_techniques_operations (
          piece_technique_id,
          cf_id,
          phase,
          designation,
          designation_2,
          prix,
          coef,
          tp,
          tf_unit,
          qte,
          taux_horaire,
          temps_total,
          cout_mo
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING
          id::text AS id,
          phase::int AS phase,
          designation,
          designation_2,
          cf_id::text AS cf_id,
          prix::float8 AS prix,
          coef::float8 AS coef,
          tp::float8 AS tp,
          tf_unit::float8 AS tf_unit,
          qte::float8 AS qte,
          taux_horaire::float8 AS taux_horaire,
          temps_total::float8 AS temps_total,
          cout_mo::float8 AS cout_mo
      `,
      [
        pieceTechniqueId,
        op.cf_id ?? null,
        op.phase,
        op.designation,
        op.designation_2 ?? null,
        op.prix ?? 0,
        op.coef,
        op.tp,
        op.tf_unit,
        op.qte,
        op.taux_horaire,
        op.temps_total,
        op.cout_mo,
      ]
    );
    const r = res.rows[0];
    out.push({
      id: r.id,
      phase: r.phase,
      designation: r.designation,
      designation_2: r.designation_2,
      cf_id: r.cf_id,
      prix: Number(r.prix),
      coef: Number(r.coef),
      tp: Number(r.tp),
      tf_unit: Number(r.tf_unit),
      qte: Number(r.qte),
      taux_horaire: Number(r.taux_horaire),
      temps_total: Number(r.temps_total),
      cout_mo: Number(r.cout_mo),
    });
  }
  return out;
}

async function insertAchats(
  client: PoolClient,
  pieceTechniqueId: string,
  achats: (AddAchatBodyDTO & { total_achat_ht: number; total_achat_ttc: number })[]
): Promise<Achat[]> {
  if (!achats.length) return [];
  const out: Achat[] = [];
  for (let i = 0; i < achats.length; i++) {
    const a = achats[i];
    const res = await client.query<AchatRow>(
      `
        INSERT INTO pieces_techniques_achats (
          piece_technique_id,
          phase,
          famille_piece_id,
          nom,
          fournisseur_id,
          fournisseur_nom,
          fournisseur_code,
          quantite,
          quantite_brut_mm,
          longueur_mm,
          coefficient_chute,
          quantite_pieces,
          prix_par_quantite,
          tarif,
          prix,
          unite_prix,
          pu_achat,
          tva_achat,
          total_achat_ht,
          total_achat_ttc,
          designation,
          designation_2,
          designation_3
        )
        VALUES (
          $1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,
          $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )
        RETURNING
          id::text AS id,
          phase,
          famille_piece_id::text AS famille_piece_id,
          nom,
          fournisseur_id::text AS fournisseur_id,
          fournisseur_nom,
          fournisseur_code,
          quantite::float8 AS quantite,
          quantite_brut_mm::float8 AS quantite_brut_mm,
          longueur_mm::float8 AS longueur_mm,
          coefficient_chute::float8 AS coefficient_chute,
          quantite_pieces::float8 AS quantite_pieces,
          prix_par_quantite::float8 AS prix_par_quantite,
          tarif::float8 AS tarif,
          prix::float8 AS prix,
          unite_prix,
          pu_achat::float8 AS pu_achat,
          tva_achat::float8 AS tva_achat,
          total_achat_ht::float8 AS total_achat_ht,
          total_achat_ttc::float8 AS total_achat_ttc,
          designation,
          designation_2,
          designation_3
      `,
      [
        pieceTechniqueId,
        a.phase ?? null,
        a.famille_piece_id ?? null,
        a.nom ?? null,
        a.fournisseur_id ?? null,
        a.fournisseur_nom ?? null,
        a.fournisseur_code ?? null,
        a.quantite,
        a.quantite_brut_mm ?? null,
        a.longueur_mm ?? null,
        a.coefficient_chute ?? null,
        a.quantite_pieces ?? null,
        a.prix_par_quantite ?? null,
        a.tarif ?? null,
        a.prix ?? null,
        a.unite_prix ?? null,
        a.pu_achat ?? null,
        a.tva_achat ?? null,
        a.total_achat_ht,
        a.total_achat_ttc,
        a.designation ?? null,
        a.designation_2 ?? null,
        a.designation_3 ?? null,
      ]
    );
    const r = res.rows[0];
    out.push({
      id: r.id,
      phase: r.phase,
      famille_piece_id: r.famille_piece_id,
      nom: r.nom,
      fournisseur_id: r.fournisseur_id,
      fournisseur_nom: r.fournisseur_nom,
      fournisseur_code: r.fournisseur_code,
      quantite: Number(r.quantite),
      quantite_brut_mm: r.quantite_brut_mm === null ? null : Number(r.quantite_brut_mm),
      longueur_mm: r.longueur_mm === null ? null : Number(r.longueur_mm),
      coefficient_chute: r.coefficient_chute === null ? null : Number(r.coefficient_chute),
      quantite_pieces: r.quantite_pieces === null ? null : Number(r.quantite_pieces),
      prix_par_quantite: r.prix_par_quantite === null ? null : Number(r.prix_par_quantite),
      tarif: r.tarif === null ? null : Number(r.tarif),
      prix: r.prix === null ? null : Number(r.prix),
      unite_prix: r.unite_prix,
      pu_achat: r.pu_achat === null ? null : Number(r.pu_achat),
      tva_achat: r.tva_achat === null ? null : Number(r.tva_achat),
      total_achat_ht: r.total_achat_ht === null ? null : Number(r.total_achat_ht),
      total_achat_ttc: r.total_achat_ttc === null ? null : Number(r.total_achat_ttc),
      designation: r.designation,
      designation_2: r.designation_2,
      designation_3: r.designation_3,
    });
  }
  return out;
}

export async function repoUpdatePieceTechnique(
  id: string,
  patch: UpdatePieceTechniqueBodyDTO,
  audit: AuditContext
): Promise<PieceTechnique | null> {
  const client = await db.connect();
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.client_id !== undefined) sets.push(`client_id = ${push(patch.client_id)}`);
  if (patch.code_client !== undefined) sets.push(`code_client = ${push(patch.code_client)}`);
  if (patch.client_name !== undefined) sets.push(`client_name = ${push(patch.client_name)}`);
  if (patch.famille_id !== undefined) sets.push(`famille_id = ${push(patch.famille_id)}::uuid`);
  if (patch.name_piece !== undefined) sets.push(`name_piece = ${push(patch.name_piece)}`);
  if (patch.code_piece !== undefined) sets.push(`code_piece = ${push(patch.code_piece)}`);
  if (patch.designation !== undefined) sets.push(`designation = ${push(patch.designation)}`);
  if (patch.designation_2 !== undefined) sets.push(`designation_2 = ${push(patch.designation_2)}`);
  if (patch.prix_unitaire !== undefined) sets.push(`prix_unitaire = ${push(patch.prix_unitaire)}`);
  if (patch.cycle !== undefined) sets.push(`cycle = ${push(patch.cycle)}`);
  if (patch.cycle_fabrication !== undefined) sets.push(`cycle_fabrication = ${push(patch.cycle_fabrication)}`);
  if (patch.ensemble !== undefined) sets.push(`ensemble = ${push(patch.ensemble)}`);

  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  const where: string[] = [];
  where.push(`id = ${push(id)}::uuid`);
  where.push(`deleted_at IS NULL`);
  if (patch.expected_updated_at !== undefined) {
    where.push(`updated_at = ${push(patch.expected_updated_at)}::timestamptz`);
  }

  const sql = `
    UPDATE pieces_techniques
    SET ${sets.join(", ")}
    WHERE ${where.join(" AND ")}
    RETURNING id::text AS id
  `;

  try {
    await client.query("BEGIN");

    const res = await client.query<{ id: string }>(sql, values);
    const row = res.rows[0] ?? null;
    if (!row) {
      const exists = await client.query<{ ok: number }>(
        `SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL`,
        [id]
      );
      if (!exists.rows[0]?.ok) {
        await client.query("ROLLBACK");
        return null;
      }
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Record was modified by another user");
    }

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.update",
      entity_type: "pieces_techniques",
      entity_id: id,
      details: {
        patch,
      },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return repoGetPieceTechnique(id, includesSetForCreate());
}

export async function repoDeletePieceTechnique(id: string, audit: AuditContext): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ code_piece: string; designation: string }>(
      `
        SELECT code_piece, designation
        FROM pieces_techniques
        WHERE id = $1::uuid AND deleted_at IS NULL
        FOR UPDATE
      `,
      [id]
    );
    const base = existing.rows[0] ?? null;
    if (!base) {
      await client.query("ROLLBACK");
      return false;
    }

    const upd = await client.query(
      `
        UPDATE pieces_techniques
        SET deleted_at = now(), deleted_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid AND deleted_at IS NULL
      `,
      [id, audit.user_id]
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.delete",
      entity_type: "pieces_techniques",
      entity_id: id,
      details: {
        code_piece: base.code_piece,
        designation: base.designation,
      },
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

export async function repoUpdatePieceTechniqueStatus(
  id: string,
  ancienStatut: PieceTechniqueStatut,
  nouveauStatut: PieceTechniqueStatut,
  commentaire: string | null,
  expectedUpdatedAt: string | undefined,
  audit: AuditContext
): Promise<PieceTechnique | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ statut: PieceTechniqueStatut }>(
      `
        SELECT statut::text AS statut
        FROM pieces_techniques
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR updated_at = $2::timestamptz)
        FOR UPDATE
      `,
      [id, expectedUpdatedAt ?? null]
    );
    if (!lock.rows[0]) {
      const exists = await client.query<{ ok: number }>(
        `SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL`,
        [id]
      );
      if (!exists.rows[0]?.ok) {
        await client.query("ROLLBACK");
        return null;
      }
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Record was modified by another user");
    }

    const enFabrication = nouveauStatut === "IN_FABRICATION";
    await client.query(
      `
        UPDATE pieces_techniques
        SET statut = $2, en_fabrication = $3, updated_by = $4, updated_at = now()
        WHERE id = $1::uuid
      `,
      [id, nouveauStatut, enFabrication ? 1 : 0, audit.user_id]
    );

    await client.query(
      `
        INSERT INTO pieces_techniques_historique (piece_technique_id, user_id, ancien_statut, nouveau_statut, commentaire)
        VALUES ($1::uuid, $2, $3, $4, $5)
      `,
      [id, audit.user_id, ancienStatut, nouveauStatut, commentaire]
    );

    await insertAuditLog(client, audit, {
      action: "pieces-techniques.status",
      entity_type: "pieces_techniques",
      entity_id: id,
      details: {
        from: ancienStatut,
        to: nouveauStatut,
        commentaire,
      },
    });

    await client.query("COMMIT");
    return repoGetPieceTechnique(id, new Set());
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function buildDuplicateCode(baseCode: string, attempt: number): string {
  if (attempt <= 1) return `${baseCode}-COPIE`;
  return `${baseCode}-COPIE-${attempt}`;
}

export async function repoDuplicatePieceTechnique(id: string, userId: number | null): Promise<PieceTechnique | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const original = await client.query<PieceTechniqueCoreRow>(
      `
        SELECT
          p.id::text AS id,
          p.created_at::text AS created_at,
          p.updated_at::text AS updated_at,
          p.client_id,
          p.created_by,
          p.updated_by,
          p.famille_id::text AS famille_id,
          p.name_piece,
          p.code_piece,
          p.designation,
          p.designation_2,
          p.prix_unitaire::float8 AS prix_unitaire,
          p.statut::text AS statut,
          p.en_fabrication::int AS en_fabrication,
          p.cycle,
          p.cycle_fabrication,
          p.code_client,
          p.client_name,
          p.ensemble
        FROM pieces_techniques p
        WHERE p.id = $1::uuid
          AND p.deleted_at IS NULL
        FOR UPDATE
      `,
      [id]
    );
    const o = original.rows[0];
    if (!o) {
      await client.query("ROLLBACK");
      return null;
    }

    const bom = await client.query<BomRow>(
      `
        SELECT
          id::text AS id,
          child_piece_technique_id::text AS child_piece_id,
          rang::int AS rang,
          quantite::float8 AS quantite,
          repere,
          designation
        FROM pieces_techniques_nomenclature
        WHERE parent_piece_technique_id = $1::uuid
        ORDER BY rang ASC, id ASC
      `,
      [id]
    );
    const operations = await client.query<OperationRow>(
      `
        SELECT
          id::text AS id,
          phase::int AS phase,
          designation,
          designation_2,
          cf_id::text AS cf_id,
          prix::float8 AS prix,
          coef::float8 AS coef,
          tp::float8 AS tp,
          tf_unit::float8 AS tf_unit,
          qte::float8 AS qte,
          taux_horaire::float8 AS taux_horaire,
          temps_total::float8 AS temps_total,
          cout_mo::float8 AS cout_mo
        FROM pieces_techniques_operations
        WHERE piece_technique_id = $1::uuid
        ORDER BY phase ASC, id ASC
      `,
      [id]
    );
    const achats = await client.query<AchatRow>(
      `
        SELECT
          id::text AS id,
          phase,
          famille_piece_id::text AS famille_piece_id,
          nom,
          fournisseur_id::text AS fournisseur_id,
          fournisseur_nom,
          fournisseur_code,
          quantite::float8 AS quantite,
          quantite_brut_mm::float8 AS quantite_brut_mm,
          longueur_mm::float8 AS longueur_mm,
          coefficient_chute::float8 AS coefficient_chute,
          quantite_pieces::float8 AS quantite_pieces,
          prix_par_quantite::float8 AS prix_par_quantite,
          tarif::float8 AS tarif,
          prix::float8 AS prix,
          unite_prix,
          pu_achat::float8 AS pu_achat,
          tva_achat::float8 AS tva_achat,
          total_achat_ht::float8 AS total_achat_ht,
          total_achat_ttc::float8 AS total_achat_ttc,
          designation,
          designation_2,
          designation_3
        FROM pieces_techniques_achats
        WHERE piece_technique_id = $1::uuid
        ORDER BY phase NULLS LAST, id ASC
      `,
      [id]
    );

    const statut: PieceTechniqueStatut = "DRAFT";
    const enFabrication = 0;

    let newRow: PieceTechniqueCoreRow | null = null;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const code = buildDuplicateCode(o.code_piece, attempt);
      try {
        const ins = await client.query<PieceTechniqueCoreRow>(
          `
            INSERT INTO pieces_techniques (
              client_id, created_by, updated_by,
              famille_id, name_piece, code_piece, designation, designation_2,
              prix_unitaire, statut, en_fabrication, cycle, cycle_fabrication,
              code_client, client_name, ensemble
            )
            VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8,
              $9, $10, $11, $12, $13,
              $14, $15, $16
            )
            RETURNING
              id::text AS id,
              created_at::text AS created_at,
              updated_at::text AS updated_at,
              client_id,
              created_by,
              updated_by,
              famille_id::text AS famille_id,
              name_piece,
              code_piece,
              designation,
              designation_2,
              prix_unitaire::float8 AS prix_unitaire,
              statut::text AS statut,
              en_fabrication::int AS en_fabrication,
              cycle,
              cycle_fabrication,
              code_client,
              client_name,
              ensemble
          `,
          [
            o.client_id,
            userId,
            userId,
            o.famille_id,
            o.name_piece,
            code,
            o.designation,
            o.designation_2,
            o.prix_unitaire,
            statut,
            enFabrication,
            o.cycle,
            o.cycle_fabrication,
            o.code_client,
            o.client_name,
            o.ensemble,
          ]
        );
        newRow = ins.rows[0] ?? null;
        break;
      } catch (e: unknown) {
        if (isPgUniqueViolation(e)) continue;
        throw e;
      }
    }

    if (!newRow) throw new HttpError(409, "CONFLICT", "Unable to allocate unique code_piece for duplicate");
    const newId = newRow.id;

    if (bom.rows.length) {
      for (const l of bom.rows) {
        await client.query(
          `
            INSERT INTO pieces_techniques_nomenclature (
              parent_piece_technique_id,
              child_piece_technique_id,
              rang,
              quantite,
              repere,
              designation
            )
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
          `,
          [newId, l.child_piece_id, l.rang, l.quantite, l.repere ?? null, l.designation ?? null]
        );
      }
    }
    if (operations.rows.length) {
      for (const op of operations.rows) {
        await client.query(
          `
            INSERT INTO pieces_techniques_operations (
              piece_technique_id,
              cf_id,
              phase,
              designation,
              designation_2,
              prix,
              coef,
              tp,
              tf_unit,
              qte,
              taux_horaire,
              temps_total,
              cout_mo
            )
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            newId,
            op.cf_id ?? null,
            op.phase,
            op.designation,
            op.designation_2 ?? null,
            op.prix,
            op.coef,
            op.tp,
            op.tf_unit,
            op.qte,
            op.taux_horaire,
            op.temps_total,
            op.cout_mo,
          ]
        );
      }
    }
    if (achats.rows.length) {
      for (const a of achats.rows) {
        await client.query(
          `
            INSERT INTO pieces_techniques_achats (
              piece_technique_id,
              phase,
              famille_piece_id,
              nom,
              fournisseur_id,
              fournisseur_nom,
              fournisseur_code,
              quantite,
              quantite_brut_mm,
              longueur_mm,
              coefficient_chute,
              quantite_pieces,
              prix_par_quantite,
              tarif,
              prix,
              unite_prix,
              pu_achat,
              tva_achat,
              total_achat_ht,
              total_achat_ttc,
              designation,
              designation_2,
              designation_3
            )
            VALUES (
              $1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,
              $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
            )
          `,
          [
            newId,
            a.phase ?? null,
            a.famille_piece_id ?? null,
            a.nom ?? null,
            a.fournisseur_id ?? null,
            a.fournisseur_nom ?? null,
            a.fournisseur_code ?? null,
            a.quantite,
            a.quantite_brut_mm ?? null,
            a.longueur_mm ?? null,
            a.coefficient_chute ?? null,
            a.quantite_pieces ?? null,
            a.prix_par_quantite ?? null,
            a.tarif ?? null,
            a.prix ?? null,
            a.unite_prix ?? null,
            a.pu_achat ?? null,
            a.tva_achat ?? null,
            a.total_achat_ht ?? null,
            a.total_achat_ttc ?? null,
            a.designation ?? null,
            a.designation_2 ?? null,
            a.designation_3 ?? null,
          ]
        );
      }
    }

    await client.query(
      `
        INSERT INTO pieces_techniques_historique (piece_technique_id, user_id, ancien_statut, nouveau_statut, commentaire)
        VALUES ($1::uuid, $2, $3, $4, $5)
      `,
      [newId, userId, null, statut, `Duplicated from piece technique ${id}`]
    );

    await client.query("COMMIT");
    return repoGetPieceTechnique(newId, includesSetForCreate());
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function ensurePieceTechniqueExists(client: PoolClient, pieceTechniqueId: string): Promise<boolean> {
  const res = await client.query<{ ok: number }>(
    "SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL",
    [pieceTechniqueId]
  );
  return Boolean(res.rows[0]?.ok);
}

async function wouldCreateBomCycle(client: PoolClient, parentId: string, childId: string): Promise<boolean> {
  if (parentId === childId) return true;
  const res = await client.query<{ found: number }>(
    `
      WITH RECURSIVE descendants AS (
        SELECT child_piece_technique_id
        FROM pieces_techniques_nomenclature
        WHERE parent_piece_technique_id = $1::uuid
        UNION ALL
        SELECT n.child_piece_technique_id
        FROM pieces_techniques_nomenclature n
        JOIN descendants d ON n.parent_piece_technique_id = d.child_piece_technique_id
      )
      SELECT 1::int AS found
      FROM descendants
      WHERE child_piece_technique_id = $2::uuid
      LIMIT 1
    `,
    [childId, parentId]
  );
  return Boolean(res.rows[0]?.found);
}

export async function repoAddBomLine(pieceTechniqueId: string, body: AddBomLineBodyDTO): Promise<BomLine | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const exists = await ensurePieceTechniqueExists(client, pieceTechniqueId);
    if (!exists) {
      await client.query("ROLLBACK");
      return null;
    }

    const cycle = await wouldCreateBomCycle(client, pieceTechniqueId, body.child_piece_id);
    if (cycle) throw new HttpError(409, "BOM_CYCLE", "This line would create a nomenclature cycle");

    let rang = body.rang;
    if (rang === undefined) {
      const maxRes = await client.query<{ max_rang: number | null }>(
        `SELECT MAX(rang)::int AS max_rang FROM pieces_techniques_nomenclature WHERE parent_piece_technique_id = $1::uuid`,
        [pieceTechniqueId]
      );
      const max = maxRes.rows[0]?.max_rang ?? 0;
      rang = max + 10;
    }

    const ins = await client.query<BomRow>(
      `
        INSERT INTO pieces_techniques_nomenclature (
          parent_piece_technique_id,
          child_piece_technique_id,
          rang,
          quantite,
          repere,
          designation
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
        RETURNING
          id::text AS id,
          child_piece_technique_id::text AS child_piece_id,
          rang::int AS rang,
          quantite::float8 AS quantite,
          repere,
          designation
      `,
      [pieceTechniqueId, body.child_piece_id, rang, body.quantite, body.repere ?? null, body.designation ?? null]
    );
    await client.query("COMMIT");
    const r = ins.rows[0];
    return {
      id: r.id,
      child_piece_id: r.child_piece_id,
      rang: r.rang,
      quantite: Number(r.quantite),
      repere: r.repere,
      designation: r.designation,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateBomLine(
  pieceTechniqueId: string,
  lineId: string,
  body: UpdateBomLineBodyDTO
): Promise<BomLine | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (body.child_piece_id !== undefined) {
      const cycle = await wouldCreateBomCycle(client, pieceTechniqueId, body.child_piece_id);
      if (cycle) throw new HttpError(409, "BOM_CYCLE", "This line would create a nomenclature cycle");
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (body.child_piece_id !== undefined) sets.push(`child_piece_technique_id = ${push(body.child_piece_id)}::uuid`);
    if (body.rang !== undefined) sets.push(`rang = ${push(body.rang)}`);
    if (body.quantite !== undefined) sets.push(`quantite = ${push(body.quantite)}`);
    if (body.repere !== undefined) sets.push(`repere = ${push(body.repere)}`);
    if (body.designation !== undefined) sets.push(`designation = ${push(body.designation)}`);

    if (!sets.length) {
      await client.query("ROLLBACK");
      return await repoGetBomLine(pieceTechniqueId, lineId);
    }

    const sql = `
      UPDATE pieces_techniques_nomenclature
      SET ${sets.join(", ")}
      WHERE id = ${push(lineId)}::uuid AND parent_piece_technique_id = ${push(pieceTechniqueId)}::uuid
      RETURNING
        id::text AS id,
        child_piece_technique_id::text AS child_piece_id,
        rang::int AS rang,
        quantite::float8 AS quantite,
        repere,
        designation
    `;
    const res = await client.query<BomRow>(sql, values);
    const r = res.rows[0];
    if (!r) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("COMMIT");
    return {
      id: r.id,
      child_piece_id: r.child_piece_id,
      rang: r.rang,
      quantite: Number(r.quantite),
      repere: r.repere,
      designation: r.designation,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function repoGetBomLine(pieceTechniqueId: string, lineId: string): Promise<BomLine | null> {
  const res = await db.query<BomRow>(
    `
      SELECT
        id::text AS id,
        child_piece_technique_id::text AS child_piece_id,
        rang::int AS rang,
        quantite::float8 AS quantite,
        repere,
        designation
      FROM pieces_techniques_nomenclature
      WHERE id = $1::uuid AND parent_piece_technique_id = $2::uuid
    `,
    [lineId, pieceTechniqueId]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    child_piece_id: r.child_piece_id,
    rang: r.rang,
    quantite: Number(r.quantite),
    repere: r.repere,
    designation: r.designation,
  };
}

export async function repoDeleteBomLine(pieceTechniqueId: string, lineId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM pieces_techniques_nomenclature WHERE id = $1::uuid AND parent_piece_technique_id = $2::uuid`,
    [lineId, pieceTechniqueId]
  );
  return (rowCount ?? 0) > 0;
}

export async function repoReorderBom(pieceTechniqueId: string, order: string[]): Promise<BomLine[] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM pieces_techniques_nomenclature WHERE parent_piece_technique_id = $1::uuid`,
      [pieceTechniqueId]
    );
    const currentIds = new Set(current.rows.map((r) => r.id));
    for (const id of order) {
      if (!currentIds.has(id)) throw new HttpError(422, "INVALID_ORDER", "Order contains invalid line id");
    }

    const params: unknown[] = [pieceTechniqueId];
    const cases: string[] = [];
    for (let i = 0; i < order.length; i++) {
      params.push(order[i]);
      params.push((i + 1) * 10);
      const idParam = `$${params.length - 1}`;
      const rankParam = `$${params.length}`;
      cases.push(`WHEN id = ${idParam}::uuid THEN ${rankParam}`);
    }
    const inList = order.map((_, i) => `$${2 + i * 2}`).join(", ");
    await client.query(
      `
        UPDATE pieces_techniques_nomenclature
        SET rang = CASE ${cases.join(" ")} ELSE rang END
        WHERE parent_piece_technique_id = $1::uuid AND id IN (${inList})
      `,
      params
    );

    await client.query("COMMIT");
    return repoListBomLines(pieceTechniqueId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoAddOperation(pieceTechniqueId: string, body: AddOperationBodyDTO & { temps_total: number; cout_mo: number }) {
  const exists = await db.query<{ ok: number }>(
    "SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid",
    [pieceTechniqueId]
  );
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<OperationRow>(
    `
      INSERT INTO pieces_techniques_operations (
        piece_technique_id,
        cf_id,
        phase,
        designation,
        designation_2,
        prix,
        coef,
        tp,
        tf_unit,
        qte,
        taux_horaire,
        temps_total,
        cout_mo
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING
        id::text AS id,
        phase::int AS phase,
        designation,
        designation_2,
        cf_id::text AS cf_id,
        prix::float8 AS prix,
        coef::float8 AS coef,
        tp::float8 AS tp,
        tf_unit::float8 AS tf_unit,
        qte::float8 AS qte,
        taux_horaire::float8 AS taux_horaire,
        temps_total::float8 AS temps_total,
        cout_mo::float8 AS cout_mo
    `,
    [
      pieceTechniqueId,
      body.cf_id ?? null,
      body.phase,
      body.designation,
      body.designation_2 ?? null,
      body.prix ?? 0,
      body.coef,
      body.tp,
      body.tf_unit,
      body.qte,
      body.taux_horaire,
      body.temps_total,
      body.cout_mo,
    ]
  );
  const r = res.rows[0];
  return {
    id: r.id,
    phase: r.phase,
    designation: r.designation,
    designation_2: r.designation_2,
    cf_id: r.cf_id,
    prix: Number(r.prix),
    coef: Number(r.coef),
    tp: Number(r.tp),
    tf_unit: Number(r.tf_unit),
    qte: Number(r.qte),
    taux_horaire: Number(r.taux_horaire),
    temps_total: Number(r.temps_total),
    cout_mo: Number(r.cout_mo),
  };
}

export async function repoUpdateOperation(
  pieceTechniqueId: string,
  opId: string,
  body: UpdateOperationBodyDTO & { temps_total: number; cout_mo: number }
): Promise<Operation | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (body.phase !== undefined) sets.push(`phase = ${push(body.phase)}`);
  if (body.designation !== undefined) sets.push(`designation = ${push(body.designation)}`);
  if (body.designation_2 !== undefined) sets.push(`designation_2 = ${push(body.designation_2)}`);
  if (body.cf_id !== undefined) sets.push(`cf_id = ${push(body.cf_id)}::uuid`);
  if (body.prix !== undefined) sets.push(`prix = ${push(body.prix)}`);
  if (body.coef !== undefined) sets.push(`coef = ${push(body.coef)}`);
  if (body.tp !== undefined) sets.push(`tp = ${push(body.tp)}`);
  if (body.tf_unit !== undefined) sets.push(`tf_unit = ${push(body.tf_unit)}`);
  if (body.qte !== undefined) sets.push(`qte = ${push(body.qte)}`);
  if (body.taux_horaire !== undefined) sets.push(`taux_horaire = ${push(body.taux_horaire)}`);

  // Always keep computed fields aligned when any related numeric changes are posted
  sets.push(`temps_total = ${push(body.temps_total)}`);
  sets.push(`cout_mo = ${push(body.cout_mo)}`);

  const sql = `
    UPDATE pieces_techniques_operations
    SET ${sets.join(", ")}
    WHERE id = ${push(opId)}::uuid AND piece_technique_id = ${push(pieceTechniqueId)}::uuid
    RETURNING
      id::text AS id,
      phase::int AS phase,
      designation,
      designation_2,
      cf_id::text AS cf_id,
      prix::float8 AS prix,
      coef::float8 AS coef,
      tp::float8 AS tp,
      tf_unit::float8 AS tf_unit,
      qte::float8 AS qte,
      taux_horaire::float8 AS taux_horaire,
      temps_total::float8 AS temps_total,
      cout_mo::float8 AS cout_mo
  `;
  const res = await db.query<OperationRow>(sql, values);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    phase: r.phase,
    designation: r.designation,
    designation_2: r.designation_2,
    cf_id: r.cf_id,
    prix: Number(r.prix),
    coef: Number(r.coef),
    tp: Number(r.tp),
    tf_unit: Number(r.tf_unit),
    qte: Number(r.qte),
    taux_horaire: Number(r.taux_horaire),
    temps_total: Number(r.temps_total),
    cout_mo: Number(r.cout_mo),
  };
}

export async function repoDeleteOperation(pieceTechniqueId: string, opId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM pieces_techniques_operations WHERE id = $1::uuid AND piece_technique_id = $2::uuid`,
    [opId, pieceTechniqueId]
  );
  return (rowCount ?? 0) > 0;
}

export async function repoReorderOperations(pieceTechniqueId: string, order: string[]): Promise<Operation[] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM pieces_techniques_operations WHERE piece_technique_id = $1::uuid`,
      [pieceTechniqueId]
    );
    const currentIds = new Set(current.rows.map((r) => r.id));
    for (const id of order) {
      if (!currentIds.has(id)) throw new HttpError(422, "INVALID_ORDER", "Order contains invalid operation id");
    }

    const params: unknown[] = [pieceTechniqueId];
    const cases: string[] = [];
    for (let i = 0; i < order.length; i++) {
      params.push(order[i]);
      params.push((i + 1) * 10);
      const idParam = `$${params.length - 1}`;
      const phaseParam = `$${params.length}`;
      cases.push(`WHEN id = ${idParam}::uuid THEN ${phaseParam}`);
    }
    const inList = order.map((_, i) => `$${2 + i * 2}`).join(", ");
    await client.query(
      `
        UPDATE pieces_techniques_operations
        SET phase = CASE ${cases.join(" ")} ELSE phase END
        WHERE piece_technique_id = $1::uuid AND id IN (${inList})
      `,
      params
    );
    await client.query("COMMIT");
    return repoListOperations(pieceTechniqueId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoAddAchat(
  pieceTechniqueId: string,
  body: AddAchatBodyDTO & { total_achat_ht: number; total_achat_ttc: number }
): Promise<Achat | null> {
  const exists = await db.query<{ ok: number }>("SELECT 1::int AS ok FROM pieces_techniques WHERE id = $1::uuid", [pieceTechniqueId]);
  if (!exists.rows[0]?.ok) return null;

  const res = await db.query<AchatRow>(
    `
      INSERT INTO pieces_techniques_achats (
        piece_technique_id,
        phase,
        famille_piece_id,
        nom,
        fournisseur_id,
        fournisseur_nom,
        fournisseur_code,
        quantite,
        quantite_brut_mm,
        longueur_mm,
        coefficient_chute,
        quantite_pieces,
        prix_par_quantite,
        tarif,
        prix,
        unite_prix,
        pu_achat,
        tva_achat,
        total_achat_ht,
        total_achat_ttc,
        designation,
        designation_2,
        designation_3
      )
      VALUES (
        $1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      )
      RETURNING
        id::text AS id,
        phase,
        famille_piece_id::text AS famille_piece_id,
        nom,
        fournisseur_id::text AS fournisseur_id,
        fournisseur_nom,
        fournisseur_code,
        quantite::float8 AS quantite,
        quantite_brut_mm::float8 AS quantite_brut_mm,
        longueur_mm::float8 AS longueur_mm,
        coefficient_chute::float8 AS coefficient_chute,
        quantite_pieces::float8 AS quantite_pieces,
        prix_par_quantite::float8 AS prix_par_quantite,
        tarif::float8 AS tarif,
        prix::float8 AS prix,
        unite_prix,
        pu_achat::float8 AS pu_achat,
        tva_achat::float8 AS tva_achat,
        total_achat_ht::float8 AS total_achat_ht,
        total_achat_ttc::float8 AS total_achat_ttc,
        designation,
        designation_2,
        designation_3
    `,
    [
      pieceTechniqueId,
      body.phase ?? null,
      body.famille_piece_id ?? null,
      body.nom ?? null,
      body.fournisseur_id ?? null,
      body.fournisseur_nom ?? null,
      body.fournisseur_code ?? null,
      body.quantite,
      body.quantite_brut_mm ?? null,
      body.longueur_mm ?? null,
      body.coefficient_chute ?? null,
      body.quantite_pieces ?? null,
      body.prix_par_quantite ?? null,
      body.tarif ?? null,
      body.prix ?? null,
      body.unite_prix ?? null,
      body.pu_achat ?? null,
      body.tva_achat ?? null,
      body.total_achat_ht,
      body.total_achat_ttc,
      body.designation ?? null,
      body.designation_2 ?? null,
      body.designation_3 ?? null,
    ]
  );

  const r = res.rows[0];
  return {
    id: r.id,
    phase: r.phase,
    famille_piece_id: r.famille_piece_id,
    nom: r.nom,
    fournisseur_id: r.fournisseur_id,
    fournisseur_nom: r.fournisseur_nom,
    fournisseur_code: r.fournisseur_code,
    quantite: Number(r.quantite),
    quantite_brut_mm: r.quantite_brut_mm === null ? null : Number(r.quantite_brut_mm),
    longueur_mm: r.longueur_mm === null ? null : Number(r.longueur_mm),
    coefficient_chute: r.coefficient_chute === null ? null : Number(r.coefficient_chute),
    quantite_pieces: r.quantite_pieces === null ? null : Number(r.quantite_pieces),
    prix_par_quantite: r.prix_par_quantite === null ? null : Number(r.prix_par_quantite),
    tarif: r.tarif === null ? null : Number(r.tarif),
    prix: r.prix === null ? null : Number(r.prix),
    unite_prix: r.unite_prix,
    pu_achat: r.pu_achat === null ? null : Number(r.pu_achat),
    tva_achat: r.tva_achat === null ? null : Number(r.tva_achat),
    total_achat_ht: r.total_achat_ht === null ? null : Number(r.total_achat_ht),
    total_achat_ttc: r.total_achat_ttc === null ? null : Number(r.total_achat_ttc),
    designation: r.designation,
    designation_2: r.designation_2,
    designation_3: r.designation_3,
  };
}

export async function repoUpdateAchat(
  pieceTechniqueId: string,
  achatId: string,
  body: UpdateAchatBodyDTO & { total_achat_ht: number; total_achat_ttc: number }
): Promise<Achat | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (body.phase !== undefined) sets.push(`phase = ${push(body.phase)}`);
  if (body.famille_piece_id !== undefined) sets.push(`famille_piece_id = ${push(body.famille_piece_id)}::uuid`);
  if (body.nom !== undefined) sets.push(`nom = ${push(body.nom)}`);
  if (body.fournisseur_id !== undefined) sets.push(`fournisseur_id = ${push(body.fournisseur_id)}::uuid`);
  if (body.fournisseur_nom !== undefined) sets.push(`fournisseur_nom = ${push(body.fournisseur_nom)}`);
  if (body.fournisseur_code !== undefined) sets.push(`fournisseur_code = ${push(body.fournisseur_code)}`);
  if (body.quantite !== undefined) sets.push(`quantite = ${push(body.quantite)}`);
  if (body.quantite_brut_mm !== undefined) sets.push(`quantite_brut_mm = ${push(body.quantite_brut_mm)}`);
  if (body.longueur_mm !== undefined) sets.push(`longueur_mm = ${push(body.longueur_mm)}`);
  if (body.coefficient_chute !== undefined) sets.push(`coefficient_chute = ${push(body.coefficient_chute)}`);
  if (body.quantite_pieces !== undefined) sets.push(`quantite_pieces = ${push(body.quantite_pieces)}`);
  if (body.prix_par_quantite !== undefined) sets.push(`prix_par_quantite = ${push(body.prix_par_quantite)}`);
  if (body.tarif !== undefined) sets.push(`tarif = ${push(body.tarif)}`);
  if (body.prix !== undefined) sets.push(`prix = ${push(body.prix)}`);
  if (body.unite_prix !== undefined) sets.push(`unite_prix = ${push(body.unite_prix)}`);
  if (body.pu_achat !== undefined) sets.push(`pu_achat = ${push(body.pu_achat)}`);
  if (body.tva_achat !== undefined) sets.push(`tva_achat = ${push(body.tva_achat)}`);
  if (body.designation !== undefined) sets.push(`designation = ${push(body.designation)}`);
  if (body.designation_2 !== undefined) sets.push(`designation_2 = ${push(body.designation_2)}`);
  if (body.designation_3 !== undefined) sets.push(`designation_3 = ${push(body.designation_3)}`);

  sets.push(`total_achat_ht = ${push(body.total_achat_ht)}`);
  sets.push(`total_achat_ttc = ${push(body.total_achat_ttc)}`);

  const sql = `
    UPDATE pieces_techniques_achats
    SET ${sets.join(", ")}
    WHERE id = ${push(achatId)}::uuid AND piece_technique_id = ${push(pieceTechniqueId)}::uuid
    RETURNING
      id::text AS id,
      phase,
      famille_piece_id::text AS famille_piece_id,
      nom,
      fournisseur_id::text AS fournisseur_id,
      fournisseur_nom,
      fournisseur_code,
      quantite::float8 AS quantite,
      quantite_brut_mm::float8 AS quantite_brut_mm,
      longueur_mm::float8 AS longueur_mm,
      coefficient_chute::float8 AS coefficient_chute,
      quantite_pieces::float8 AS quantite_pieces,
      prix_par_quantite::float8 AS prix_par_quantite,
      tarif::float8 AS tarif,
      prix::float8 AS prix,
      unite_prix,
      pu_achat::float8 AS pu_achat,
      tva_achat::float8 AS tva_achat,
      total_achat_ht::float8 AS total_achat_ht,
      total_achat_ttc::float8 AS total_achat_ttc,
      designation,
      designation_2,
      designation_3
  `;
  const res = await db.query<AchatRow>(sql, values);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    phase: r.phase,
    famille_piece_id: r.famille_piece_id,
    nom: r.nom,
    fournisseur_id: r.fournisseur_id,
    fournisseur_nom: r.fournisseur_nom,
    fournisseur_code: r.fournisseur_code,
    quantite: Number(r.quantite),
    quantite_brut_mm: r.quantite_brut_mm === null ? null : Number(r.quantite_brut_mm),
    longueur_mm: r.longueur_mm === null ? null : Number(r.longueur_mm),
    coefficient_chute: r.coefficient_chute === null ? null : Number(r.coefficient_chute),
    quantite_pieces: r.quantite_pieces === null ? null : Number(r.quantite_pieces),
    prix_par_quantite: r.prix_par_quantite === null ? null : Number(r.prix_par_quantite),
    tarif: r.tarif === null ? null : Number(r.tarif),
    prix: r.prix === null ? null : Number(r.prix),
    unite_prix: r.unite_prix,
    pu_achat: r.pu_achat === null ? null : Number(r.pu_achat),
    tva_achat: r.tva_achat === null ? null : Number(r.tva_achat),
    total_achat_ht: r.total_achat_ht === null ? null : Number(r.total_achat_ht),
    total_achat_ttc: r.total_achat_ttc === null ? null : Number(r.total_achat_ttc),
    designation: r.designation,
    designation_2: r.designation_2,
    designation_3: r.designation_3,
  };
}

export async function repoDeleteAchat(pieceTechniqueId: string, achatId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM pieces_techniques_achats WHERE id = $1::uuid AND piece_technique_id = $2::uuid`,
    [achatId, pieceTechniqueId]
  );
  return (rowCount ?? 0) > 0;
}

export async function repoReorderAchats(pieceTechniqueId: string, order: string[]): Promise<Achat[] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM pieces_techniques_achats WHERE piece_technique_id = $1::uuid`,
      [pieceTechniqueId]
    );
    const currentIds = new Set(current.rows.map((r) => r.id));
    for (const id of order) {
      if (!currentIds.has(id)) throw new HttpError(422, "INVALID_ORDER", "Order contains invalid achat id");
    }
    const params: unknown[] = [pieceTechniqueId];
    const cases: string[] = [];
    for (let i = 0; i < order.length; i++) {
      params.push(order[i]);
      params.push((i + 1) * 10);
      const idParam = `$${params.length - 1}`;
      const phaseParam = `$${params.length}`;
      cases.push(`WHEN id = ${idParam}::uuid THEN ${phaseParam}`);
    }
    const inList = order.map((_, i) => `$${2 + i * 2}`).join(", ");
    await client.query(
      `
        UPDATE pieces_techniques_achats
        SET phase = CASE ${cases.join(" ")} ELSE phase END
        WHERE piece_technique_id = $1::uuid AND id IN (${inList})
      `,
      params
    );
    await client.query("COMMIT");
    return repoListAchats(pieceTechniqueId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
