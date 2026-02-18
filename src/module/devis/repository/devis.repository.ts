import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type {
  CreateDevisBodyDTO,
  ListDevisQueryDTO,
  UpdateDevisBodyDTO,
} from "../validators/devis.validators";
import type {
  ClientLite,
  DevisDocument,
  DevisHeader,
  DevisLine,
  DevisListItem,
  UploadedDocument,
} from "../types/devis.types";

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null };
  const code = typeof err.code === "string" ? err.code : null;
  const constraint = typeof err.constraint === "string" ? err.constraint : null;
  return { code, constraint };
}

function normalizeStatus(value: unknown) {
  if (value === null || value === undefined) return "";
  try {
    return String(value)
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  } catch {
    return String(value).trim().toLowerCase();
  }
}

function isAcceptedStatus(value: unknown) {
  const s = normalizeStatus(value);
  return s === "accepte" || s === "acceptee";
}

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

function sortColumn(sortBy: ListDevisQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "d.numero";
    case "date_creation":
      return "d.date_creation";
    case "date_validite":
      return "d.date_validite";
    case "statut":
      return "d.statut";
    case "total_ttc":
      return "d.total_ttc";
    case "total_ht":
      return "d.total_ht";
    case "updated_at":
      return "d.updated_at";
    default:
      return "d.date_creation";
  }
}

function sortDirection(sortDir: ListDevisQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListDevisQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(d.numero ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`d.numero ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`d.client_id = ${p}`);
  }

  if (filters.statut && filters.statut.trim().length > 0) {
    const p = push(filters.statut.trim());
    where.push(`d.statut = ${p}`);
  }

  if (filters.from) {
    const p = push(filters.from);
    where.push(`d.date_creation::date >= ${p}::date`);
  }

  if (filters.to) {
    const p = push(filters.to);
    where.push(`d.date_creation::date <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

export async function repoListDevis(filters: ListDevisQueryDTO) {
  const includes = includesSet(filters.include ?? "client");
  const includeClient = includes.has("client");
  const joinClient = includeClient || (filters.q ? filters.q.trim().length > 0 : false);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = joinClient ? "LEFT JOIN clients c ON c.client_id = d.client_id" : "";
  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const { whereSql, values } = buildListWhere(filters, joinClient);
  const orderBy = sortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM devis d
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      d.id::text AS id,
      d.numero,
      d.client_id,
      d.date_creation::text AS date_creation,
      d.updated_at::text AS updated_at,
      d.date_validite::text AS date_validite,
      d.statut,
      d.remise_globale::float8 AS remise_globale,
      d.total_ht::float8 AS total_ht,
      d.total_ttc::float8 AS total_ttc,
      ${clientSelectSql}
    FROM devis d
    ${joinClientSql}
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  type DevisListRow = Omit<DevisListItem, "id"> & {
    id: string;
    client: ClientLite | null;
  };

  const dataRes = await pool.query<DevisListRow>(dataSql, [...values, pageSize, offset]);
  const items = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "devis.id"),
    client: includeClient ? r.client : undefined,
  }));

  return { items, total };
}

async function insertDevisLines(client: PoolClient, devisId: number, lignes: CreateDevisBodyDTO["lignes"]) {
  if (!lignes.length) return;

  const params: unknown[] = [devisId];
  const valuesSql: string[] = [];
  for (const l of lignes) {
    const baseIndex = params.length;
    params.push(
      l.description,
      l.code_piece ?? null,
      l.quantite,
      l.unite ?? null,
      l.prix_unitaire_ht,
      l.remise_ligne ?? 0,
      l.taux_tva ?? 20
    );

    const placeholders = Array.from({ length: 7 }, (_, j) => `$${baseIndex + 1 + j}`).join(",");
    valuesSql.push(`($1,${placeholders})`);
  }

  await client.query(
    `
    INSERT INTO devis_ligne (
      devis_id,
      description,
      code_piece,
      quantite,
      unite,
      prix_unitaire_ht,
      remise_ligne,
      taux_tva
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  );
}

async function insertDevisDocuments(client: PoolClient, devisId: number, documents: UploadedDocument[]) {
  if (!documents.length) return;

  for (const doc of documents) {
    const documentId = crypto.randomUUID();
    const isPdf = doc.originalname.toLowerCase().endsWith(".pdf");
    const docType = isPdf ? "PDF" : doc.mimetype;

    const extCandidate = path.extname(doc.originalname).toLowerCase();
    const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
    const uploadDir = path.resolve("uploads/docs");
    const finalPath = path.join(uploadDir, `${documentId}${safeExt}`);

    try {
      await fs.rename(doc.path, finalPath);
    } catch {
      await fs.copyFile(doc.path, finalPath);
      await fs.unlink(doc.path);
    }

    await client.query(
      `
      INSERT INTO documents_clients (id, document_name, type)
      VALUES ($1, $2, $3)
      `,
      [documentId, doc.originalname, docType]
    );

    await client.query(
      `
      INSERT INTO devis_documents (devis_id, document_id, type)
      VALUES ($1, $2, $3)
      `,
      [devisId, documentId, isPdf ? "PDF" : null]
    );
  }
}

export async function repoGetDevis(id: number, includeValue: string) {
  const includes = includesSet(includeValue);
  const includeClient = includes.has("client");
  const includeLignes = includes.has("lignes");
  const includeDocuments = includes.has("documents");

  const joinClientSql = includeClient ? "LEFT JOIN clients c ON c.client_id = d.client_id" : "";
  const clientSelectSql = includeClient
    ? `CASE WHEN c.client_id IS NULL THEN NULL ELSE jsonb_build_object(
        'client_id', c.client_id,
        'company_name', c.company_name,
        'email', c.email,
        'phone', c.phone,
        'delivery_address_id', c.delivery_address_id::text,
        'bill_address_id', c.bill_address_id::text
      ) END AS client`
    : "NULL AS client";

  const headerSql = `
    SELECT
      d.id::text AS id,
      d.numero,
      d.client_id,
      d.contact_id::text AS contact_id,
      d.user_id::text AS user_id,
      d.adresse_facturation_id::text AS adresse_facturation_id,
      d.adresse_livraison_id::text AS adresse_livraison_id,
      d.mode_reglement_id::text AS mode_reglement_id,
      d.compte_vente_id::text AS compte_vente_id,
      d.date_creation::text AS date_creation,
      d.updated_at::text AS updated_at,
      d.date_validite::text AS date_validite,
      d.statut,
      d.remise_globale::float8 AS remise_globale,
      d.total_ht::float8 AS total_ht,
      d.total_ttc::float8 AS total_ttc,
      d.commentaires,
      d.conditions_paiement_id,
      d.biller_id::text AS biller_id,
      ${clientSelectSql}
    FROM devis d
    ${joinClientSql}
    WHERE d.id = $1
  `;

  type HeaderRow = Omit<DevisHeader, "id" | "user_id" | "client"> & {
    id: string;
    user_id: string;
    client: ClientLite | null;
  };

  const headerRes = await pool.query<HeaderRow>(headerSql, [id]);
  const row = headerRes.rows[0] ?? null;
  if (!row) return null;

  const devis: DevisHeader = {
    ...row,
    id: toInt(row.id, "devis.id"),
    user_id: toInt(row.user_id, "devis.user_id"),
    client: includeClient ? row.client : undefined,
  };

  const lignes: DevisLine[] = includeLignes
    ? (
        await pool.query<
          Omit<DevisLine, "id" | "devis_id"> & { id: string; devis_id: string }
        >(
          `
          SELECT
            id::text AS id,
            devis_id::text AS devis_id,
            code_piece,
            description,
            quantite::float8 AS quantite,
            unite,
            prix_unitaire_ht::float8 AS prix_unitaire_ht,
            remise_ligne::float8 AS remise_ligne,
            taux_tva::float8 AS taux_tva,
            total_ht::float8 AS total_ht,
            total_ttc::float8 AS total_ttc
          FROM devis_ligne
          WHERE devis_id = $1
          ORDER BY id ASC
          `,
          [id]
        )
      ).rows.map((l) => ({
        ...l,
        id: toInt(l.id, "devis_ligne.id"),
        devis_id: toInt(l.devis_id, "devis_ligne.devis_id"),
      }))
    : [];

  const documents: DevisDocument[] = includeDocuments
    ? (
        await pool.query<
          Omit<DevisDocument, "id" | "devis_id"> & { id: string; devis_id: string }
        >(
          `
          SELECT
            dd.id::text AS id,
            dd.devis_id::text AS devis_id,
            dd.document_id::text AS document_id,
            dd.type,
            CASE WHEN dc.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', dc.id::text,
              'document_name', dc.document_name,
              'type', dc.type,
              'creation_date', dc.creation_date::text,
              'created_by', dc.created_by
            ) END AS document
          FROM devis_documents dd
          LEFT JOIN documents_clients dc ON dc.id = dd.document_id
          WHERE dd.devis_id = $1
          ORDER BY dd.id DESC
          `,
          [id]
        )
      ).rows.map((d) => ({
        ...d,
        id: toInt(d.id, "devis_documents.id"),
        devis_id: toInt(d.devis_id, "devis_documents.devis_id"),
      }))
    : [];

  return { devis, lignes, documents };
}

export type DevisDocumentFileMeta = {
  id: string;
  document_name: string;
  type: string | null;
};

export async function repoGetDevisDocumentFileMeta(devisId: number, docId: string): Promise<DevisDocumentFileMeta | null> {
  const sql = `
    SELECT
      dc.id::text AS id,
      dc.document_name,
      dc.type
    FROM devis_documents dd
    JOIN documents_clients dc ON dc.id = dd.document_id
    WHERE dd.devis_id = $1
      AND dd.document_id = $2
    LIMIT 1
  `;

  const res = await pool.query<DevisDocumentFileMeta>(sql, [devisId, docId]);
  return res.rows[0] ?? null;
}

export async function repoCreateDevis(input: CreateDevisBodyDTO, userId: number, documents: UploadedDocument[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seq = await client.query<{ id: string }>(`SELECT nextval('public.devis_id_seq')::bigint::text AS id`);
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate devis id");
    const devisId = toInt(idRaw, "devis.id");

    const numero = (input.numero ?? `DV-${devisId}`).slice(0, 30);
    const dateCreation = (input.date_creation ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO devis (
        id,
        numero,
        client_id,
        contact_id,
        user_id,
        adresse_facturation_id,
        adresse_livraison_id,
        mode_reglement_id,
        compte_vente_id,
        date_creation,
        date_validite,
        statut,
        remise_globale,
        total_ht,
        total_ttc,
        commentaires,
        conditions_paiement_id,
        biller_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17,$18
      )
      RETURNING id::text AS id
      `,
      [
        devisId,
        numero,
        input.client_id,
        input.contact_id ?? null,
        userId,
        input.adresse_facturation_id ?? null,
        input.adresse_livraison_id ?? null,
        input.mode_reglement_id ?? null,
        input.compte_vente_id ?? null,
        dateCreation,
        input.date_validite ?? null,
        input.statut,
        input.remise_globale,
        input.total_ht,
        input.total_ttc,
        input.commentaires ?? null,
        input.conditions_paiement_id ?? null,
        input.biller_id ?? null,
      ]
    );

    await insertDevisLines(client, devisId, input.lignes);
    await insertDevisDocuments(client, devisId, documents);

    await client.query("COMMIT");

    const inserted = ins.rows[0]?.id;
    return { id: inserted ? toInt(inserted, "devis.id") : devisId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateDevis(
  id: number,
  input: UpdateDevisBodyDTO,
  userId: number,
  documents: UploadedDocument[]
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (input.numero !== undefined) sets.push(`numero = ${push(input.numero)}`);
    if (input.client_id !== undefined) sets.push(`client_id = ${push(input.client_id)}`);
    if (input.contact_id !== undefined) sets.push(`contact_id = ${push(input.contact_id)}::uuid`);

    // keep user_id stable unless explicitly provided
    if (input.user_id !== undefined) sets.push(`user_id = ${push(input.user_id)}::bigint`);

    if (input.adresse_facturation_id !== undefined)
      sets.push(`adresse_facturation_id = ${push(input.adresse_facturation_id)}::uuid`);
    if (input.adresse_livraison_id !== undefined)
      sets.push(`adresse_livraison_id = ${push(input.adresse_livraison_id)}::uuid`);
    if (input.mode_reglement_id !== undefined) sets.push(`mode_reglement_id = ${push(input.mode_reglement_id)}::uuid`);
    if (input.compte_vente_id !== undefined) sets.push(`compte_vente_id = ${push(input.compte_vente_id)}::uuid`);
    if (input.date_creation !== undefined && input.date_creation !== null)
      sets.push(`date_creation = ${push(input.date_creation)}::date`);
    if (input.date_validite !== undefined) sets.push(`date_validite = ${push(input.date_validite)}::date`);
    if (input.statut !== undefined) sets.push(`statut = ${push(input.statut)}`);
    if (input.remise_globale !== undefined) sets.push(`remise_globale = ${push(input.remise_globale)}`);
    if (input.total_ht !== undefined) sets.push(`total_ht = ${push(input.total_ht)}`);
    if (input.total_ttc !== undefined) sets.push(`total_ttc = ${push(input.total_ttc)}`);
    if (input.commentaires !== undefined) sets.push(`commentaires = ${push(input.commentaires)}`);
    if (input.conditions_paiement_id !== undefined)
      sets.push(`conditions_paiement_id = ${push(input.conditions_paiement_id)}::int`);
    if (input.biller_id !== undefined) sets.push(`biller_id = ${push(input.biller_id)}::uuid`);

    if (sets.length === 0 && input.lignes === undefined && documents.length === 0) {
      await client.query("ROLLBACK");
      throw new HttpError(400, "NO_UPDATE", "No fields to update");
    }

    let updatedId: number | null = null;
    if (sets.length) {
      sets.push("updated_at = now()");
      const updateSql = `
        UPDATE devis
        SET ${sets.join(", ")}
        WHERE id = $1
        RETURNING id::text AS id
      `;
      const updateRes = await client.query<{ id: string }>(updateSql, values);
      const row = updateRes.rows[0] ?? null;
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      updatedId = toInt(row.id, "devis.id");
    } else {
      const touch = await client.query<{ id: string }>(
        `UPDATE devis SET updated_at = now() WHERE id = $1 RETURNING id::text AS id`,
        [id]
      );
      const row = touch.rows[0] ?? null;
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      updatedId = toInt(row.id, "devis.id");
    }

    if (input.lignes) {
      await client.query(`DELETE FROM devis_ligne WHERE devis_id = $1`, [id]);
      await insertDevisLines(client, id, input.lignes);
    }

    await insertDevisDocuments(client, id, documents);

    await client.query("COMMIT");
    return { id: updatedId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "devis_numero_key") {
      throw new HttpError(409, "DEVIS_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoConvertDevisToCommande(devisId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const devisRes = await client.query<{
      id: string;
      numero: string;
      client_id: string;
      contact_id: string | null;
      adresse_livraison_id: string | null;
      mode_reglement_id: string | null;
      conditions_paiement_id: number | null;
      biller_id: string | null;
      compte_vente_id: string | null;
      commentaires: string | null;
      remise_globale: number;
      total_ht: number;
      total_ttc: number;
      statut: string;
    }>(
      `
      SELECT
        id::text AS id,
        numero,
        client_id,
        contact_id::text AS contact_id,
        adresse_livraison_id::text AS adresse_livraison_id,
        mode_reglement_id::text AS mode_reglement_id,
        conditions_paiement_id,
        biller_id::text AS biller_id,
        compte_vente_id::text AS compte_vente_id,
        commentaires,
        remise_globale::float8 AS remise_globale,
        total_ht::float8 AS total_ht,
        total_ttc::float8 AS total_ttc,
        statut
      FROM devis
      WHERE id = $1
      FOR UPDATE
      `,
      [devisId]
    );

    const devis = devisRes.rows[0] ?? null;
    if (!devis) {
      await client.query("ROLLBACK");
      return null;
    }

    if (!isAcceptedStatus(devis.statut)) {
      throw new HttpError(400, "DEVIS_NOT_ACCEPTED", "Devis must be accepted before conversion");
    }

    const existing = await client.query<{ id: string; numero: string }>(
      `
      SELECT id::text AS id, numero
      FROM commande_client
      WHERE devis_id = $1
      LIMIT 1
      `,
      [devisId]
    );
    if (existing.rows.length > 0) {
      const numero = existing.rows[0]?.numero;
      throw new HttpError(409, "DEVIS_ALREADY_CONVERTED", numero ? `Devis already converted (${numero})` : "Devis already converted");
    }

    const seq = await client.query<{ id: string }>(
      `SELECT nextval('public.commande_client_id_seq')::bigint::text AS id`
    );
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate commande id");
    const commandeId = toInt(idRaw, "commande_client.id");
    const commandeNumero = `CC-${commandeId}`.slice(0, 30);

    await client.query(
      `
      INSERT INTO commande_client (
        id,
        numero,
        client_id,
        contact_id,
        destinataire_id,
        mode_reglement_id,
        conditions_paiement_id,
        biller_id,
        compte_vente_id,
        commentaire,
        remise_globale,
        total_ht,
        total_ttc,
        devis_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
      )
      `,
      [
        commandeId,
        commandeNumero,
        devis.client_id,
        devis.contact_id ?? null,
        devis.adresse_livraison_id ?? null,
        devis.mode_reglement_id ?? null,
        devis.conditions_paiement_id ?? null,
        devis.biller_id ?? null,
        devis.compte_vente_id ?? null,
        devis.commentaires ?? null,
        devis.remise_globale ?? 0,
        devis.total_ht ?? 0,
        devis.total_ttc ?? 0,
        devisId,
      ]
    );

    const insLines = await client.query(
      `
      INSERT INTO commande_ligne (
        commande_id,
        designation,
        code_piece,
        quantite,
        unite,
        prix_unitaire_ht,
        remise_ligne,
        taux_tva,
        delai_client,
        delai_interne,
        devis_numero,
        famille
      )
      SELECT
        $1,
        dl.description,
        NULL,
        dl.quantite,
        dl.unite,
        dl.prix_unitaire_ht,
        dl.remise_ligne,
        dl.taux_tva,
        NULL,
        NULL,
        $2,
        NULL
      FROM devis_ligne dl
      WHERE dl.devis_id = $3
      ORDER BY dl.id ASC
      `,
      [commandeId, devis.numero, devisId]
    );

    if ((insLines.rowCount ?? 0) === 0) {
      throw new HttpError(400, "DEVIS_EMPTY", "Devis has no lines to convert");
    }

    await client.query("COMMIT");
    return { id: commandeId, numero: commandeNumero };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "commande_client_devis_id_key") {
      throw new HttpError(409, "DEVIS_ALREADY_CONVERTED", "Devis already converted");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteDevis(id: number) {
  const { rowCount } = await pool.query(`DELETE FROM devis WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
