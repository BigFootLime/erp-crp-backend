import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { computeDocumentTotals, computeLineTotals } from "../lib/totals";
import type { ClientLite, DocumentClient } from "../types/shared.types";
import type {
  FactureDetail,
  FactureDocument,
  FactureHeader,
  FactureLine,
  FactureListItem,
  Paginated,
  Paiement,
} from "../types/factures.types";
import type {
  CreateFactureBodyDTO,
  ListFacturesQueryDTO,
  UpdateFactureBodyDTO,
} from "../validators/factures.validators";

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

function includesSet(includeValue: string) {
  return new Set(
    includeValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

function sortColumn(sortBy: ListFacturesQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "f.numero";
    case "date_emission":
      return "f.date_emission";
    case "date_echeance":
      return "f.date_echeance";
    case "total_ttc":
      return "f.total_ttc";
    case "updated_at":
      return "f.updated_at";
    default:
      return "f.date_emission";
  }
}

function sortDirection(sortDir: ListFacturesQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC";
}

function factureProjectedStatusSql(alias = "f") {
  return `CASE
    WHEN ${alias}.document_status = 'ISSUED' AND ${alias}.settlement_status = 'UNPAID' THEN 'ISSUED'
    WHEN ${alias}.document_status = 'ISSUED' THEN ${alias}.settlement_status
    WHEN ${alias}.document_status = 'LEGACY' THEN ${alias}.statut
    ELSE ${alias}.document_status
  END`;
}

type ListWhere = { whereSql: string; values: unknown[] };
function buildListWhere(filters: ListFacturesQueryDTO, includeClientInSearch: boolean): ListWhere {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`);
    if (includeClientInSearch) {
      where.push(`(f.numero ILIKE ${p} OR c.company_name ILIKE ${p})`);
    } else {
      where.push(`f.numero ILIKE ${p}`);
    }
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim());
    where.push(`f.client_id = ${p}`);
  }

  if (filters.commande_id) {
    const p = push(filters.commande_id);
    where.push(`(
      f.commande_id = ${p}::bigint
      OR EXISTS (
        SELECT 1
        FROM public.facture_source_allocations source
        JOIN public.bon_livraison_ligne delivery_line
          ON source.source_type = 'DELIVERY_LINE'
         AND source.source_line_id = delivery_line.id::text
        JOIN public.bon_livraison delivery
          ON delivery.id = delivery_line.bon_livraison_id
        WHERE source.facture_id = f.id
          AND delivery.commande_id = ${p}::bigint
      )
    )`);
  }

  if (filters.statut && filters.statut.trim().length > 0) {
    const status = filters.statut.trim();
    if (status === "PARTIALLY_PAID" || status === "PAID") {
      const p = push(status);
      where.push(`f.document_status = 'ISSUED' AND f.settlement_status = ${p}`);
    } else if (status === "ISSUED") {
      where.push(`f.document_status = 'ISSUED' AND f.settlement_status = 'UNPAID'`);
    } else {
      const p = push(status);
      where.push(`f.document_status = ${p}`);
    }
  }

  if (filters.from) {
    const p = push(filters.from);
    where.push(`f.date_emission >= ${p}::date`);
  }

  if (filters.to) {
    const p = push(filters.to);
    where.push(`f.date_emission <= ${p}::date`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

export async function repoListFactures(filters: ListFacturesQueryDTO): Promise<Paginated<FactureListItem>> {
  const includes = includesSet(filters.include ?? "client");
  const includeClient = includes.has("client");
  const joinClient = includeClient || (filters.q ? filters.q.trim().length > 0 : false);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const joinClientSql = joinClient ? "LEFT JOIN clients c ON c.client_id = f.client_id" : "";
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
    FROM facture f
    ${joinClientSql}
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countSql, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      f.id::text AS id,
      f.numero,
      f.client_id,
      f.commande_id::bigint::int AS commande_id,
      f.date_emission::text AS date_emission,
      f.date_echeance::text AS date_echeance,
      f.total_ht::float8 AS total_ht,
      f.total_ttc::float8 AS total_ttc,
      f.updated_at::text AS updated_at,
      ${factureProjectedStatusSql("f")} AS statut,
      f.document_status,
      f.settlement_status,
      ${clientSelectSql},
      pay.total_paye_ttc,
      av.total_avoirs_ttc,
      GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc) AS reste_a_payer_ttc
    FROM facture f
    ${joinClientSql}
    LEFT JOIN LATERAL (
      SELECT (
        COALESCE((
          SELECT SUM(pa.amount_ttc)
          FROM paiement_allocations pa
          WHERE pa.facture_id = f.id
        ), 0)
        + COALESCE((
          SELECT SUM(p.montant)
          FROM paiement p
          WHERE p.facture_id = f.id
            AND NOT EXISTS (
              SELECT 1 FROM paiement_allocations pa WHERE pa.paiement_id = p.id
            )
        ), 0)
      )::float8 AS total_paye_ttc
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT (
        COALESCE((
          SELECT SUM(asa.amount_ttc)
          FROM avoir_source_allocations asa
          WHERE asa.facture_id = f.id AND asa.allocation_status = 'CONSUMED'
        ), 0)
        + COALESCE((
          SELECT SUM(a.total_ttc)
          FROM avoir a
          WHERE a.facture_id = f.id
            AND a.statut IN ('ISSUED','emis','emise','envoyee')
            AND NOT EXISTS (
              SELECT 1 FROM avoir_source_allocations asa WHERE asa.avoir_id = a.id
            )
        ), 0)
      )::float8 AS total_avoirs_ttc
    ) av ON TRUE
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const dataValues = [...values, pageSize, offset];
  type Row = Omit<FactureListItem, "id"> & { id: string; client: ClientLite | null };
  const dataRes = await pool.query<Row>(dataSql, dataValues);

  const items: FactureListItem[] = dataRes.rows.map((r) => ({
    ...r,
    id: toInt(r.id, "facture.id"),
    client: includeClient ? r.client : undefined,
  }));

  return { items, total };
}

type IncludeFlags = {
  lignes: boolean;
  documents: boolean;
  paiements: boolean;
  client: boolean;
};

function includeFlags(includes: Set<string>): IncludeFlags {
  const has = (v: string) => includes.has(v);
  return {
    lignes: has("lignes"),
    documents: has("documents"),
    paiements: has("paiements"),
    client: has("client"),
  };
}

export async function repoGetFacture(id: number, includeValue: string): Promise<FactureDetail | null> {
  const includes = includesSet(includeValue);
  const inc = includeFlags(includes);

  const joinClientSql = inc.client ? "LEFT JOIN clients c ON c.client_id = f.client_id" : "";
  const clientSelectSql = inc.client
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
      f.id::text AS id,
      f.numero,
      f.client_id,
      f.devis_id::text AS devis_id,
      f.commande_id::text AS commande_id,
      f.affaire_id::text AS affaire_id,
      f.date_emission::text AS date_emission,
      f.date_echeance::text AS date_echeance,
      ${factureProjectedStatusSql("f")} AS statut,
      f.document_status,
      f.settlement_status,
      f.remise_globale::float8 AS remise_globale,
      f.total_ht::float8 AS total_ht,
      f.total_ttc::float8 AS total_ttc,
      f.commentaires,
      f.created_at::text AS created_at,
      f.updated_at::text AS updated_at,
      ${clientSelectSql},
      pay.total_paye_ttc,
      av.total_avoirs_ttc,
      GREATEST(0, f.total_ttc::float8 - pay.total_paye_ttc - av.total_avoirs_ttc) AS reste_a_payer_ttc
    FROM facture f
    ${joinClientSql}
    LEFT JOIN LATERAL (
      SELECT (
        COALESCE((
          SELECT SUM(pa.amount_ttc)
          FROM paiement_allocations pa
          WHERE pa.facture_id = f.id
        ), 0)
        + COALESCE((
          SELECT SUM(p.montant)
          FROM paiement p
          WHERE p.facture_id = f.id
            AND NOT EXISTS (
              SELECT 1 FROM paiement_allocations pa WHERE pa.paiement_id = p.id
            )
        ), 0)
      )::float8 AS total_paye_ttc
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT (
        COALESCE((
          SELECT SUM(asa.amount_ttc)
          FROM avoir_source_allocations asa
          WHERE asa.facture_id = f.id AND asa.allocation_status = 'CONSUMED'
        ), 0)
        + COALESCE((
          SELECT SUM(a.total_ttc)
          FROM avoir a
          WHERE a.facture_id = f.id
            AND a.statut IN ('ISSUED','emis','emise','envoyee')
            AND NOT EXISTS (
              SELECT 1 FROM avoir_source_allocations asa WHERE asa.avoir_id = a.id
            )
        ), 0)
      )::float8 AS total_avoirs_ttc
    ) av ON TRUE
    WHERE f.id = $1
  `;

  type HeaderRow = Omit<FactureHeader, "id" | "devis_id" | "commande_id" | "affaire_id" | "client"> & {
    id: string;
    devis_id: string | null;
    commande_id: string | null;
    affaire_id: string | null;
    client: ClientLite | null;
  };

  const headerRes = await pool.query<HeaderRow>(headerSql, [id]);
  const row = headerRes.rows[0] ?? null;
  if (!row) return null;

  const facture: FactureHeader = {
    ...row,
    id: toInt(row.id, "facture.id"),
    devis_id: toNullableInt(row.devis_id, "facture.devis_id"),
    commande_id: toNullableInt(row.commande_id, "facture.commande_id"),
    affaire_id: toNullableInt(row.affaire_id, "facture.affaire_id"),
    client: inc.client ? row.client : undefined,
  };

  const lignes: FactureLine[] = inc.lignes
    ? (
        await pool.query<
          Omit<FactureLine, "id" | "facture_id"> & { id: string; facture_id: string }
        >(
          `
          SELECT
            id::text AS id,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM paiement_allocations target
                WHERE target.paiement_id = paiement.id AND target.facture_id = $1
              ) THEN $1::text
              ELSE facture_id::text
            END AS facture_id,
            ordre,
            designation,
            code_piece,
            quantite::float8 AS quantite,
            unite,
            prix_unitaire_ht::float8 AS prix_unitaire_ht,
            remise_ligne::float8 AS remise_ligne,
            taux_tva::float8 AS taux_tva,
            total_ht::float8 AS total_ht,
            total_ttc::float8 AS total_ttc
          FROM facture_ligne
          WHERE facture_id = $1
          ORDER BY ordre ASC, id ASC
          `,
          [id]
        )
      ).rows.map((l) => ({
        ...l,
        id: toInt(l.id, "facture_ligne.id"),
        facture_id: toInt(l.facture_id, "facture_ligne.facture_id"),
      }))
    : [];

  const documents: FactureDocument[] = inc.documents
    ? (
        await pool.query<
          Omit<FactureDocument, "id" | "facture_id" | "document"> & {
            id: string;
            facture_id: string;
            document: DocumentClient | null;
          }
        >(
          `
          SELECT
            fd.id::text AS id,
            fd.facture_id::text AS facture_id,
            fd.document_id::text AS document_id,
            fd.type,
            fd.created_at::text AS created_at,
            CASE WHEN dc.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', dc.id::text,
              'document_name', dc.document_name,
              'type', dc.type,
              'creation_date', dc.creation_date::text,
              'created_by', dc.created_by
            ) END AS document
          FROM facture_documents fd
          LEFT JOIN documents_clients dc ON dc.id = fd.document_id
          WHERE fd.facture_id = $1
          ORDER BY fd.id DESC
          `,
          [id]
        )
      ).rows.map((d) => ({
        ...d,
        id: toInt(d.id, "facture_documents.id"),
        facture_id: toInt(d.facture_id, "facture_documents.facture_id"),
      }))
    : [];

  const paiements: Paiement[] = inc.paiements
    ? (
        await pool.query<
          Omit<Paiement, "id" | "facture_id"> & { id: string; facture_id: string }
        >(
          `
          SELECT
            id::text AS id,
            facture_id::text AS facture_id,
            client_id,
            date_paiement::text AS date_paiement,
            montant::float8 AS montant,
            mode,
            reference,
            commentaire,
            created_at::text AS created_at,
            updated_at::text AS updated_at
          FROM paiement
          WHERE facture_id = $1
             OR EXISTS (
               SELECT 1
               FROM paiement_allocations pa
               WHERE pa.paiement_id = paiement.id AND pa.facture_id = $1
             )
          ORDER BY date_paiement DESC, id DESC
          `,
          [id]
        )
      ).rows.map((p) => ({
        ...p,
        id: toInt(p.id, "paiement.id"),
        facture_id: toInt(p.facture_id, "paiement.facture_id"),
      }))
    : [];

  return { facture, lignes, documents, paiements };
}

async function insertFactureLines(client: PoolClient, factureId: number, lignes: CreateFactureBodyDTO["lignes"]) {
  if (!lignes.length) return;

  const params: unknown[] = [factureId];
  const valuesSql: string[] = [];

  for (let idx = 0; idx < lignes.length; idx += 1) {
    const l = lignes[idx];
    const totals = computeLineTotals(l);
    const ordre = idx + 1;

    const baseIndex = params.length;
    params.push(
      ordre,
      l.designation,
      l.code_piece ?? null,
      l.quantite,
      l.unite ?? null,
      l.prix_unitaire_ht,
      l.remise_ligne ?? 0,
      l.taux_tva ?? 20,
      totals.total_ht,
      totals.total_ttc
    );

    const placeholders = Array.from({ length: 10 }, (_, j) => `$${baseIndex + 1 + j}`).join(",");
    valuesSql.push(`($1,${placeholders})`);
  }

  await client.query(
    `
    INSERT INTO facture_ligne (
      facture_id,
      ordre,
      designation,
      code_piece,
      quantite,
      unite,
      prix_unitaire_ht,
      remise_ligne,
      taux_tva,
      total_ht,
      total_ttc
    ) VALUES ${valuesSql.join(",")}
    `,
    params
  );
}

export async function repoCreateFacture(input: CreateFactureBodyDTO) {
  if (input.numero !== undefined) {
    throw new HttpError(400, "FACTURE_NUMERO_SERVER_MANAGED", "Le numéro légal de facture est attribué automatiquement.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seq = await client.query<{ id: string }>(`SELECT nextval('public.facture_id_seq')::bigint::text AS id`);
    const idRaw = seq.rows[0]?.id;
    if (!idRaw) throw new Error("Failed to allocate facture id");
    const factureId = toInt(idRaw, "facture.id");

    const numero = `FT-${factureId}`;
    const totals = computeDocumentTotals(input.lignes, input.remise_globale);

    const ins = await client.query<{ id: string }>(
      `
      INSERT INTO facture (
        id,
        numero,
        client_id,
        devis_id,
        commande_id,
        affaire_id,
        date_emission,
        date_echeance,
        statut,
        remise_globale,
        total_ht,
        total_ttc,
        commentaires
      ) VALUES (
        $1,$2,$3,
        $4::bigint,$5::bigint,$6::bigint,
        COALESCE($7::date, CURRENT_DATE),
        $8::date,
        $9,$10,$11,$12,$13
      )
      RETURNING id::text AS id
      `,
      [
        factureId,
        numero,
        input.client_id,
        input.devis_id ?? null,
        input.commande_id ?? null,
        input.affaire_id ?? null,
        input.date_emission ?? null,
        input.date_echeance ?? null,
        input.statut,
        totals.remise_pct,
        totals.total_ht,
        totals.total_ttc,
        input.commentaires ?? null,
      ]
    );

    await insertFactureLines(client, factureId, input.lignes);

    await client.query("COMMIT");
    const inserted = ins.rows[0]?.id;
    return { id: inserted ? toInt(inserted, "facture.id") : factureId };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "facture_numero_key") {
      throw new HttpError(409, "FACTURE_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateFacture(id: number, input: UpdateFactureBodyDTO) {
  if (input.numero !== undefined) {
    throw new HttpError(400, "FACTURE_NUMERO_IMMUTABLE", "Le numéro légal de facture ne peut pas être modifié.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const baseRes = await client.query<{
      id: string;
      remise_globale: number;
      statut: string;
    }>(
      `
      SELECT id::text AS id, remise_globale::float8 AS remise_globale, statut
      FROM facture
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );
    const base = baseRes.rows[0] ?? null;
    if (!base) {
      await client.query("ROLLBACK");
      return null;
    }
    if (!["DRAFT", "brouillon"].includes(base.statut)) {
      throw new HttpError(
        409,
        "FACTURE_IMMUTABLE",
        "Seul un brouillon peut être modifié. Un document émis se corrige par avoir."
      );
    }
    if (input.statut !== undefined && !["DRAFT", "brouillon"].includes(input.statut)) {
      throw new HttpError(
        409,
        "FACTURE_WORKFLOW_REQUIRED",
        "Les changements de statut passent par les commandes du workflow Finance."
      );
    }

    const hasAnyFieldUpdate = Object.keys(input).length > 0;
    const hasLineUpdate = Array.isArray(input.lignes);
    if (!hasAnyFieldUpdate && !hasLineUpdate) {
      await client.query("ROLLBACK");
      throw new HttpError(400, "NO_UPDATE", "No fields to update");
    }

    const lignesSource = hasLineUpdate
      ? (input.lignes as CreateFactureBodyDTO["lignes"])
      : (
          await client.query<{
            designation: string;
            code_piece: string | null;
            quantite: number;
            unite: string | null;
            prix_unitaire_ht: number;
            remise_ligne: number;
            taux_tva: number;
          }>(
            `
            SELECT
              designation,
              code_piece,
              quantite::float8 AS quantite,
              unite,
              prix_unitaire_ht::float8 AS prix_unitaire_ht,
              remise_ligne::float8 AS remise_ligne,
              taux_tva::float8 AS taux_tva
            FROM facture_ligne
            WHERE facture_id = $1
            ORDER BY ordre ASC, id ASC
            `,
            [id]
          )
        ).rows;

    const remise = input.remise_globale ?? base.remise_globale;
    const totals = computeDocumentTotals(lignesSource, remise);

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (input.client_id !== undefined) sets.push(`client_id = ${push(input.client_id)}`);
    if (input.devis_id !== undefined) sets.push(`devis_id = ${push(input.devis_id)}::bigint`);
    if (input.commande_id !== undefined) sets.push(`commande_id = ${push(input.commande_id)}::bigint`);
    if (input.affaire_id !== undefined) sets.push(`affaire_id = ${push(input.affaire_id)}::bigint`);
    if (input.date_emission !== undefined) sets.push(`date_emission = ${push(input.date_emission)}::date`);
    if (input.date_echeance !== undefined) sets.push(`date_echeance = ${push(input.date_echeance)}::date`);
    if (input.statut !== undefined) sets.push(`statut = ${push(input.statut)}`);
    if (input.remise_globale !== undefined) sets.push(`remise_globale = ${push(totals.remise_pct)}`);
    if (input.commentaires !== undefined) sets.push(`commentaires = ${push(input.commentaires)}`);

    sets.push(`total_ht = ${push(totals.total_ht)}`);
    sets.push(`total_ttc = ${push(totals.total_ttc)}`);
    sets.push(`updated_at = now()`);

    const updateSql = `
      UPDATE facture
      SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id::text AS id
    `;

    const updated = await client.query<{ id: string }>(updateSql, values);
    const updatedId = updated.rows[0]?.id;
    if (!updatedId) {
      await client.query("ROLLBACK");
      return null;
    }

    if (hasLineUpdate) {
      await client.query(`DELETE FROM facture_ligne WHERE facture_id = $1`, [id]);
      await insertFactureLines(client, id, lignesSource);
    }

    await client.query("COMMIT");
    return { id: toInt(updatedId, "facture.id") };
  } catch (err) {
    await client.query("ROLLBACK");
    const { code, constraint } = getPgErrorInfo(err);
    if (code === "23505" && constraint === "facture_numero_key") {
      throw new HttpError(409, "FACTURE_NUMERO_EXISTS", "Numero already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteFacture(id: number) {
  const { rowCount } = await pool.query(
    `DELETE FROM facture WHERE id = $1 AND statut IN ('DRAFT', 'brouillon')`,
    [id]
  );
  if ((rowCount ?? 0) === 0) {
    const exists = await pool.query(`SELECT 1 FROM facture WHERE id = $1`, [id]);
    if ((exists.rowCount ?? 0) > 0) {
      throw new HttpError(
        409,
        "FACTURE_IMMUTABLE",
        "Un document financier émis ne peut pas être supprimé."
      );
    }
  }
  return (rowCount ?? 0) > 0;
}
