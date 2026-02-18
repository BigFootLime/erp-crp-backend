import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";

import type {
  CadreReleaseStatus,
  CommandeCadreRelease,
  CommandeCadreReleaseLine,
} from "../types/commande-client.types";
import type {
  CreateCadreReleaseBodyDTO,
  CreateCadreReleaseLineBodyDTO,
  UpdateCadreReleaseBodyDTO,
  UpdateCadreReleaseLineBodyDTO,
} from "../validators/commande-client.validators";

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

async function assertCommandeIsCadre(client: PoolClient, commandeId: number) {
  const res = await client.query<{ order_type: string }>(
    `SELECT order_type FROM commande_client WHERE id = $1`,
    [commandeId]
  );
  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande not found");
  if (row.order_type !== "CADRE") {
    throw new HttpError(400, "COMMANDE_NOT_CADRE", "Only CADRE commandes can have releases");
  }
}

function toStatus(value: unknown): CadreReleaseStatus {
  switch (value) {
    case "PLANNED":
    case "SENT":
    case "CONFIRMED":
    case "DELIVERED":
    case "CANCELLED":
      return value;
    default:
      return "PLANNED";
  }
}

export async function repoListCadreReleases(commandeIdRaw: string, opts?: { includeLines?: boolean }) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const includeLines = opts?.includeLines ?? false;
  const db = await pool.connect();
  try {
    await assertCommandeIsCadre(db, commandeId);

    type ReleaseRow = {
      id: string;
      commande_cadre_id: string;
      numero_release: string;
      date_demande: string;
      date_livraison_prevue: string | null;
      statut: string;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
    };

    const relRes = await db.query<ReleaseRow>(
      `
      SELECT
        r.id::text AS id,
        r.commande_cadre_id::text AS commande_cadre_id,
        r.numero_release,
        r.date_demande::text AS date_demande,
        r.date_livraison_prevue::text AS date_livraison_prevue,
        r.statut,
        r.notes,
        r.created_at::text AS created_at,
        r.updated_at::text AS updated_at,
        r.created_by,
        r.updated_by
      FROM commande_cadre_release r
      WHERE r.commande_cadre_id = $1
      ORDER BY r.date_demande DESC, r.id DESC
      `,
      [commandeId]
    );

    const releases: CommandeCadreRelease[] = relRes.rows.map((r) => ({
      id: toInt(r.id, "release.id"),
      commande_cadre_id: toInt(r.commande_cadre_id, "release.commande_cadre_id"),
      numero_release: r.numero_release,
      date_demande: r.date_demande,
      date_livraison_prevue: r.date_livraison_prevue,
      statut: toStatus(r.statut),
      notes: r.notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: r.created_by,
      updated_by: r.updated_by,
    }));

    if (!includeLines || releases.length === 0) {
      return { releases, linesByReleaseId: {} as Record<number, CommandeCadreReleaseLine[]> };
    }

    const releaseIds = releases.map((r) => r.id);
    type LineRow = {
      id: string;
      release_id: string;
      ordre: number;
      commande_ligne_id: string | null;
      designation: string;
      code_piece: string | null;
      quantite: number;
      unite: string | null;
      delai_client: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
    };

    const lineRes = await db.query<LineRow>(
      `
      SELECT
        l.id::text AS id,
        l.release_id::text AS release_id,
        l.ordre,
        l.commande_ligne_id::text AS commande_ligne_id,
        l.designation,
        l.code_piece,
        l.quantite::float8 AS quantite,
        l.unite,
        l.delai_client,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at,
        l.created_by,
        l.updated_by
      FROM commande_cadre_release_ligne l
      WHERE l.release_id = ANY($1::bigint[])
      ORDER BY l.release_id ASC, l.ordre ASC, l.id ASC
      `,
      [releaseIds]
    );

    const linesByReleaseId: Record<number, CommandeCadreReleaseLine[]> = {};
    lineRes.rows.forEach((r) => {
      const releaseId = toInt(r.release_id, "release_line.release_id");
      const line: CommandeCadreReleaseLine = {
        id: toInt(r.id, "release_line.id"),
        release_id: releaseId,
        ordre: r.ordre,
        commande_ligne_id: r.commande_ligne_id ? toInt(r.commande_ligne_id, "release_line.commande_ligne_id") : null,
        designation: r.designation,
        code_piece: r.code_piece,
        quantite: r.quantite,
        unite: r.unite,
        delai_client: r.delai_client,
        created_at: r.created_at,
        updated_at: r.updated_at,
        created_by: r.created_by,
        updated_by: r.updated_by,
      };
      (linesByReleaseId[releaseId] ??= []).push(line);
    });

    return { releases, linesByReleaseId };
  } finally {
    db.release();
  }
}

export async function repoGetCadreRelease(commandeIdRaw: string, releaseIdRaw: string) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const releaseId = toInt(releaseIdRaw, "release_id");
  const db = await pool.connect();
  try {
    await assertCommandeIsCadre(db, commandeId);

    type ReleaseRow = {
      id: string;
      commande_cadre_id: string;
      numero_release: string;
      date_demande: string;
      date_livraison_prevue: string | null;
      statut: string;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
    };

    const relRes = await db.query<ReleaseRow>(
      `
      SELECT
        r.id::text AS id,
        r.commande_cadre_id::text AS commande_cadre_id,
        r.numero_release,
        r.date_demande::text AS date_demande,
        r.date_livraison_prevue::text AS date_livraison_prevue,
        r.statut,
        r.notes,
        r.created_at::text AS created_at,
        r.updated_at::text AS updated_at,
        r.created_by,
        r.updated_by
      FROM commande_cadre_release r
      WHERE r.commande_cadre_id = $1 AND r.id = $2
      LIMIT 1
      `,
      [commandeId, releaseId]
    );
    const r = relRes.rows[0] ?? null;
    if (!r) return null;

    const release: CommandeCadreRelease = {
      id: toInt(r.id, "release.id"),
      commande_cadre_id: toInt(r.commande_cadre_id, "release.commande_cadre_id"),
      numero_release: r.numero_release,
      date_demande: r.date_demande,
      date_livraison_prevue: r.date_livraison_prevue,
      statut: toStatus(r.statut),
      notes: r.notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: r.created_by,
      updated_by: r.updated_by,
    };

    type LineRow = {
      id: string;
      release_id: string;
      ordre: number;
      commande_ligne_id: string | null;
      designation: string;
      code_piece: string | null;
      quantite: number;
      unite: string | null;
      delai_client: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
    };

    const linesRes = await db.query<LineRow>(
      `
      SELECT
        l.id::text AS id,
        l.release_id::text AS release_id,
        l.ordre,
        l.commande_ligne_id::text AS commande_ligne_id,
        l.designation,
        l.code_piece,
        l.quantite::float8 AS quantite,
        l.unite,
        l.delai_client,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at,
        l.created_by,
        l.updated_by
      FROM commande_cadre_release_ligne l
      WHERE l.release_id = $1
      ORDER BY l.ordre ASC, l.id ASC
      `,
      [releaseId]
    );

    const lignes: CommandeCadreReleaseLine[] = linesRes.rows.map((l) => ({
      id: toInt(l.id, "release_line.id"),
      release_id: toInt(l.release_id, "release_line.release_id"),
      ordre: l.ordre,
      commande_ligne_id: l.commande_ligne_id ? toInt(l.commande_ligne_id, "release_line.commande_ligne_id") : null,
      designation: l.designation,
      code_piece: l.code_piece,
      quantite: l.quantite,
      unite: l.unite,
      delai_client: l.delai_client,
      created_at: l.created_at,
      updated_at: l.updated_at,
      created_by: l.created_by,
      updated_by: l.updated_by,
    }));

    return { release, lignes };
  } finally {
    db.release();
  }
}

async function assertCommandeLigneBelongsToCommande(client: PoolClient, commandeId: number, commandeLigneId: number) {
  const res = await client.query(
    `SELECT 1 FROM commande_ligne WHERE id = $1 AND commande_id = $2 LIMIT 1`,
    [commandeLigneId, commandeId]
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new HttpError(400, "INVALID_COMMANDE_LIGNE", "commande_ligne_id does not belong to the CADRE commande");
  }
}

async function insertReleaseLines(
  client: PoolClient,
  commandeId: number,
  releaseId: number,
  lines: CreateCadreReleaseLineBodyDTO[],
  userId: number | null
) {
  if (!lines.length) return;

  const params: unknown[] = [releaseId];
  const valuesSql: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const ordre = typeof l.ordre === "number" ? l.ordre : i + 1;
    const commandeLigneId = typeof l.commande_ligne_id === "number" ? l.commande_ligne_id : null;
    if (commandeLigneId) {
      await assertCommandeLigneBelongsToCommande(client, commandeId, commandeLigneId);
    }
    const baseIndex = params.length;
    params.push(
      ordre,
      commandeLigneId,
      l.designation,
      l.code_piece ?? null,
      l.quantite,
      l.unite ?? null,
      l.delai_client ?? null,
      userId,
      userId
    );
    const placeholders = Array.from({ length: 9 }, (_, j) => `$${baseIndex + 1 + j}`).join(",");
    valuesSql.push(`($1,${placeholders})`);
  }

  await client.query(
    `
    INSERT INTO commande_cadre_release_ligne (
      release_id,
      ordre,
      commande_ligne_id,
      designation,
      code_piece,
      quantite,
      unite,
      delai_client,
      created_by,
      updated_by
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  );
}

export async function repoCreateCadreRelease(commandeIdRaw: string, input: CreateCadreReleaseBodyDTO, userId: number | null) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await assertCommandeIsCadre(db, commandeId);

    const noRes = await db.query<{ n: number }>(
      `SELECT nextval('public.commande_cadre_release_no_seq')::int AS n`
    );
    const n = noRes.rows[0]?.n;
    if (!n) throw new Error("Failed to allocate release number");
    const numero_release = String(`REL-${commandeId}-${n}`).slice(0, 100);

    const ins = await db.query<{ id: string }>(
      `
      INSERT INTO commande_cadre_release (
        commande_cadre_id,
        numero_release,
        date_demande,
        date_livraison_prevue,
        statut,
        notes,
        created_by,
        updated_by
      ) VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8)
      RETURNING id::text AS id
      `,
      [
        commandeId,
        numero_release,
        input.date_demande,
        input.date_livraison_prevue ?? null,
        input.statut,
        input.notes ?? null,
        userId,
        userId,
      ]
    );
    const releaseIdRaw = ins.rows[0]?.id;
    if (!releaseIdRaw) throw new Error("Failed to create release");
    const releaseId = toInt(releaseIdRaw, "release.id");

    await insertReleaseLines(db, commandeId, releaseId, input.lignes ?? [], userId);

    await db.query("COMMIT");
    return { id: releaseId };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function repoUpdateCadreRelease(
  commandeIdRaw: string,
  releaseIdRaw: string,
  patch: UpdateCadreReleaseBodyDTO,
  userId: number | null
) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const releaseId = toInt(releaseIdRaw, "release_id");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await assertCommandeIsCadre(db, commandeId);

    const existsRes = await db.query(
      `SELECT id FROM commande_cadre_release WHERE id = $1 AND commande_cadre_id = $2 FOR UPDATE`,
      [releaseId, commandeId]
    );
    if ((existsRes.rowCount ?? 0) === 0) {
      await db.query("ROLLBACK");
      return null;
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.date_demande !== undefined) fields.push(`date_demande = ${push(patch.date_demande)}::date`);
    if (patch.date_livraison_prevue !== undefined)
      fields.push(`date_livraison_prevue = ${push(patch.date_livraison_prevue ?? null)}::date`);
    if (patch.statut !== undefined) fields.push(`statut = ${push(patch.statut)}`);
    if (patch.notes !== undefined) fields.push(`notes = ${push(patch.notes ?? null)}`);

    fields.push(`updated_by = ${push(userId)}`);
    if (fields.length) {
      await db.query(
        `UPDATE commande_cadre_release SET ${fields.join(", ")} WHERE id = ${push(releaseId)} AND commande_cadre_id = ${push(commandeId)}`,
        values
      );
    }

    await db.query("COMMIT");
    return { id: releaseId };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function repoUpdateCadreReleaseStatus(
  commandeIdRaw: string,
  releaseIdRaw: string,
  statut: CadreReleaseStatus,
  userId: number | null,
  opts?: { notes?: string | null }
) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const releaseId = toInt(releaseIdRaw, "release_id");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await assertCommandeIsCadre(db, commandeId);

    const existsRes = await db.query(
      `SELECT id, statut FROM commande_cadre_release WHERE id = $1 AND commande_cadre_id = $2 FOR UPDATE`,
      [releaseId, commandeId]
    );
    const row = existsRes.rows[0] ?? null;
    if (!row) {
      await db.query("ROLLBACK");
      return null;
    }

    await db.query(
      `UPDATE commande_cadre_release SET statut = $3, notes = COALESCE($4, notes), updated_by = $5 WHERE id = $1 AND commande_cadre_id = $2`,
      [releaseId, commandeId, statut, opts?.notes ?? null, userId]
    );

    await db.query("COMMIT");
    return { id: releaseId, statut };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function repoCancelCadreRelease(commandeIdRaw: string, releaseIdRaw: string, userId: number | null) {
  return repoUpdateCadreReleaseStatus(commandeIdRaw, releaseIdRaw, "CANCELLED", userId);
}

export async function repoAddCadreReleaseLine(
  commandeIdRaw: string,
  releaseIdRaw: string,
  input: CreateCadreReleaseLineBodyDTO,
  userId: number | null
) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const releaseId = toInt(releaseIdRaw, "release_id");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await assertCommandeIsCadre(db, commandeId);

    const relRes = await db.query(
      `SELECT id FROM commande_cadre_release WHERE id = $1 AND commande_cadre_id = $2 FOR UPDATE`,
      [releaseId, commandeId]
    );
    if ((relRes.rowCount ?? 0) === 0) throw new HttpError(404, "RELEASE_NOT_FOUND", "Release not found");

    const ordreRes = await db.query<{ next_ordre: number }>(
      `SELECT COALESCE(MAX(ordre), 0)::int + 1 AS next_ordre FROM commande_cadre_release_ligne WHERE release_id = $1`,
      [releaseId]
    );
    const ordre = typeof input.ordre === "number" ? input.ordre : ordreRes.rows[0]?.next_ordre ?? 1;

    const commandeLigneId = typeof input.commande_ligne_id === "number" ? input.commande_ligne_id : null;
    if (commandeLigneId) {
      await assertCommandeLigneBelongsToCommande(db, commandeId, commandeLigneId);
    }

    const ins = await db.query<{ id: string }>(
      `
      INSERT INTO commande_cadre_release_ligne (
        release_id,
        ordre,
        commande_ligne_id,
        designation,
        code_piece,
        quantite,
        unite,
        delai_client,
        created_by,
        updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id::text AS id
      `,
      [
        releaseId,
        ordre,
        commandeLigneId,
        input.designation,
        input.code_piece ?? null,
        input.quantite,
        input.unite ?? null,
        input.delai_client ?? null,
        userId,
        userId,
      ]
    );
    const lineId = toInt(ins.rows[0]?.id, "release_line.id");

    await db.query(`UPDATE commande_cadre_release SET updated_by = $2 WHERE id = $1`, [releaseId, userId]);

    await db.query("COMMIT");
    return { lineId };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function repoUpdateCadreReleaseLine(
  commandeIdRaw: string,
  releaseIdRaw: string,
  lineIdRaw: string,
  patch: UpdateCadreReleaseLineBodyDTO,
  userId: number | null
) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const releaseId = toInt(releaseIdRaw, "release_id");
  const lineId = toInt(lineIdRaw, "line_id");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await assertCommandeIsCadre(db, commandeId);

    const relRes = await db.query(
      `SELECT id FROM commande_cadre_release WHERE id = $1 AND commande_cadre_id = $2 FOR UPDATE`,
      [releaseId, commandeId]
    );
    if ((relRes.rowCount ?? 0) === 0) {
      await db.query("ROLLBACK");
      return null;
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.ordre !== undefined) fields.push(`ordre = ${push(patch.ordre)}`);
    if (patch.commande_ligne_id !== undefined) {
      const commandeLigneId = patch.commande_ligne_id ?? null;
      if (commandeLigneId) {
        await assertCommandeLigneBelongsToCommande(db, commandeId, commandeLigneId);
      }
      fields.push(`commande_ligne_id = ${push(commandeLigneId)}`);
    }
    if (patch.designation !== undefined) fields.push(`designation = ${push(patch.designation)}`);
    if (patch.code_piece !== undefined) fields.push(`code_piece = ${push(patch.code_piece ?? null)}`);
    if (patch.quantite !== undefined) fields.push(`quantite = ${push(patch.quantite)}`);
    if (patch.unite !== undefined) fields.push(`unite = ${push(patch.unite ?? null)}`);
    if (patch.delai_client !== undefined) fields.push(`delai_client = ${push(patch.delai_client ?? null)}`);

    if (fields.length === 0) {
      await db.query("ROLLBACK");
      return { lineId };
    }

    fields.push(`updated_by = ${push(userId)}`);

    const updRes = await db.query(
      `
      UPDATE commande_cadre_release_ligne
      SET ${fields.join(", ")}
      WHERE id = ${push(lineId)} AND release_id = ${push(releaseId)}
      `,
      values
    );
    if ((updRes.rowCount ?? 0) === 0) {
      await db.query("ROLLBACK");
      return null;
    }

    await db.query(`UPDATE commande_cadre_release SET updated_by = $2 WHERE id = $1`, [releaseId, userId]);

    await db.query("COMMIT");
    return { lineId };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function repoDeleteCadreReleaseLine(
  commandeIdRaw: string,
  releaseIdRaw: string,
  lineIdRaw: string,
  userId: number | null
) {
  const commandeId = toInt(commandeIdRaw, "commande_id");
  const releaseId = toInt(releaseIdRaw, "release_id");
  const lineId = toInt(lineIdRaw, "line_id");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await assertCommandeIsCadre(db, commandeId);

    const relRes = await db.query(
      `SELECT id FROM commande_cadre_release WHERE id = $1 AND commande_cadre_id = $2 FOR UPDATE`,
      [releaseId, commandeId]
    );
    if ((relRes.rowCount ?? 0) === 0) {
      await db.query("ROLLBACK");
      return false;
    }

    const delRes = await db.query(
      `DELETE FROM commande_cadre_release_ligne WHERE id = $1 AND release_id = $2`,
      [lineId, releaseId]
    );
    const ok = (delRes.rowCount ?? 0) > 0;
    if (ok) {
      await db.query(`UPDATE commande_cadre_release SET updated_by = $2 WHERE id = $1`, [releaseId, userId]);
    }

    await db.query("COMMIT");
    return ok;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
