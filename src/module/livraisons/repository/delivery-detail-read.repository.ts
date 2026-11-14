import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { stockLotTraceReferenceValuesSql } from "../../../shared/provenance/stock-lot-trace.sql"
import { HttpError } from "../../../utils/httpError"
import { deliveryRemainderQuantitySql } from "./delivery-quantity-projections.sql"
import { repoListLivraisonProofs } from "./livraisons-shipment.repository"
import type {
  AdresseLivraisonLite,
  BonLivraisonDetail,
  BonLivraisonDocument,
  BonLivraisonEventLog,
  BonLivraisonHeader,
  BonLivraisonLigne,
  BonLivraisonLigneAllocation,
  BonLivraisonStatut,
  UserLite,
} from "../types/livraisons.types"

import { formatAddressInline, getHeader, intercompanyDestinationAddress, mapUserLite, toFloat, toInt } from "./delivery-header.repository"
import type { HeaderRow } from "./delivery-header.repository"

export async function repoGetLivraisonDetail(id: string): Promise<BonLivraisonDetail | null> {
  const db = await pool.connect()
  try {
    const headerRow = await getHeader(db, id)
    if (!headerRow) return null

    const addressRaw = headerRow.adresse_livraison_id
      ? {
          id: headerRow.adresse_livraison_id,
          name: headerRow.al_name,
          street: headerRow.al_street,
          house_number: headerRow.al_house_number,
          postal_code: headerRow.al_postal_code,
          city: headerRow.al_city,
          country: headerRow.al_country,
        }
      : null

    const adresse_livraison: AdresseLivraisonLite = intercompanyDestinationAddress(
      headerRow.id,
      headerRow.intercompany_destination_snapshot
    ) ?? (addressRaw
      ? {
          ...addressRaw,
          label: formatAddressInline(addressRaw) || "Adresse de livraison",
        }
      : null)

    const createdBy = mapUserLite({
      id: headerRow.created_by_id,
      username: headerRow.created_by_username,
      name: headerRow.created_by_name,
      surname: headerRow.created_by_surname,
    })
    const updatedBy = mapUserLite({
      id: headerRow.updated_by_id,
      username: headerRow.updated_by_username,
      name: headerRow.updated_by_name,
      surname: headerRow.updated_by_surname,
    })

    const bon_livraison: BonLivraisonHeader = {
      id: headerRow.id,
      numero: headerRow.numero,
      statut: headerRow.statut,
      client: {
        client_id: headerRow.client_id,
        client_code: headerRow.client_code,
        company_name: headerRow.client_company_name,
      },
      commande: headerRow.commande_id && headerRow.commande_numero ? { id: toInt(headerRow.commande_id, "bon_livraison.commande_id"), numero: headerRow.commande_numero } : null,
      commande_numeros: headerRow.commande_numeros,
      affaire: headerRow.affaire_id && headerRow.affaire_reference ? { id: toInt(headerRow.affaire_id, "bon_livraison.affaire_id"), reference: headerRow.affaire_reference } : null,
      affaire_references: headerRow.affaire_references,
      adresse_livraison,
      date_creation: headerRow.date_creation,
      date_expedition: headerRow.date_expedition,
      date_livraison: headerRow.date_livraison,
      transporteur: headerRow.transporteur,
      tracking_number: headerRow.tracking_number,
      commentaire_interne: headerRow.commentaire_interne,
      commentaire_client: headerRow.commentaire_client,
      reception_nom_signataire: headerRow.reception_nom_signataire,
      reception_date_signature: headerRow.reception_date_signature,
      row_version: headerRow.row_version,
      created_at: headerRow.created_at,
      updated_at: headerRow.updated_at,
      created_by: createdBy,
      updated_by: updatedBy,
    }

    // Lines
    type LineRow = {
      id: string
      bon_livraison_id: string
      ordre: number
      designation: string
      code_piece: string | null
      quantite: string | number
      unite: string | null
      commande_ligne_id: string | null
      delai_client: string | null
      created_at: string
      updated_at: string
      created_by_id: number | null
      created_by_username: string | null
      created_by_name: string | null
      created_by_surname: string | null
      updated_by_id: number | null
      updated_by_username: string | null
      updated_by_name: string | null
      updated_by_surname: string | null
    }

    const linesRes = await db.query<LineRow>(
      `
      SELECT
        l.id::text AS id,
        l.bon_livraison_id::text AS bon_livraison_id,
        l.ordre,
        l.designation,
        l.code_piece,
        l.quantite,
        l.unite,
        l.commande_ligne_id::text AS commande_ligne_id,
        l.delai_client::text AS delai_client,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM bon_livraison_ligne l
      LEFT JOIN users cb ON cb.id = l.created_by
      LEFT JOIN users ub ON ub.id = l.updated_by
      WHERE l.bon_livraison_id = $1::uuid
      ORDER BY l.ordre ASC, l.id ASC
      `,
      [id]
    )
    const lignes: BonLivraisonLigne[] = linesRes.rows.map((r: LineRow) => ({
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      ordre: r.ordre,
      designation: r.designation,
      code_piece: r.code_piece,
      quantite: toFloat(r.quantite, "bon_livraison_ligne.quantite"),
      unite: r.unite,
      commande_ligne_id: r.commande_ligne_id ? toInt(r.commande_ligne_id, "bon_livraison_ligne.commande_ligne_id") : null,
      delai_client: r.delai_client,
      allocations: [],
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: mapUserLite({
        id: r.created_by_id,
        username: r.created_by_username,
        name: r.created_by_name,
        surname: r.created_by_surname,
      }),
      updated_by: mapUserLite({
        id: r.updated_by_id,
        username: r.updated_by_username,
        name: r.updated_by_name,
        surname: r.updated_by_surname,
      }),
    }))

    const lignesById = new Map<string, BonLivraisonLigne>()
    for (const l of lignes) lignesById.set(l.id, l)

    // Allocations
    type AllocationRow = {
      id: string
      bon_livraison_ligne_id: string
      article_id: string
      lot_id: string | null
      lot_code: string | null
      lot_status: string | null
      magasin_id: string | null
      magasin_code: string | null
      emplacement_id: number | null
      emplacement_code: string | null
      location_id: string | null
      stock_level_id: string | null
      stock_batch_id: string | null
      reservation_id: string | null
      reservation_status: string | null
      source_scope: "OLD" | "NEW"
      commande_numero: string | null
      affaire_reference: string | null
      article_reference: string | null
      article_indice: string | null
      article_version: number | null
      quantite_commandee: string | number | null
      quantite_restante: string | number | null
      of_numero: string | null
      mp_reference: string | null
      tr_reference: string | null
      verified_at: string | null
      stock_movement_line_id: string | null
      quantite: string | number
      unite: string | null
      created_at: string
      updated_at: string
      created_by_id: number | null
      created_by_username: string | null
      created_by_name: string | null
      created_by_surname: string | null
      updated_by_id: number | null
      updated_by_username: string | null
      updated_by_name: string | null
      updated_by_surname: string | null
    }

    const allocRes = await db.query<AllocationRow>(
      `
      SELECT
        a.id::text AS id,
        a.bon_livraison_ligne_id::text AS bon_livraison_ligne_id,
        a.article_id::text AS article_id,
        a.lot_id::text AS lot_id,
        lot.lot_code,
        lot.lot_status,
        a.magasin_id::text AS magasin_id,
        COALESCE(magasin.code, magasin.code_magasin)::text AS magasin_code,
        a.emplacement_id::int AS emplacement_id,
        emplacement.code AS emplacement_code,
        a.location_id::text AS location_id,
        a.stock_level_id::text AS stock_level_id,
        a.stock_batch_id::text AS stock_batch_id,
        a.reservation_id::text AS reservation_id,
        reservation.status AS reservation_status,
        CASE WHEN COALESCE(reservation.source_scope, lot.source_scope, 'NEW') = 'OLD' THEN 'OLD' ELSE 'NEW' END AS source_scope,
        commande.numero AS commande_numero,
        allocation_affaire.reference AS affaire_reference,
        COALESCE(
          NULLIF(technical_version.plan_reference, ''),
          NULLIF(applicable_version.plan_reference, ''),
          NULLIF(l.code_piece, '')
        ) AS article_reference,
        COALESCE(
          NULLIF(technical_version.indice, ''),
          NULLIF(applicable_version.indice, ''),
          article.plan_index::text
        ) AS article_indice,
        COALESCE(technical_version.version_interne, applicable_version.version_interne)::int AS article_version,
        commande_allocation.qty_ordered AS quantite_commandee,
        ${deliveryRemainderQuantitySql} AS quantite_restante,
        COALESCE(
          NULLIF(a.verification_snapshot->>'of_number', ''),
          NULLIF(fabrication.numero, ''),
          lot_trace.of_reference
        ) AS of_numero,
        COALESCE(
          NULLIF(a.verification_snapshot->>'mp_reference', ''),
          lot_trace.mp_reference,
          NULLIF(lot.mp_reference, '')
        ) AS mp_reference,
        COALESCE(
          NULLIF(a.verification_snapshot->>'tr_reference', ''),
          lot_trace.tr_reference,
          NULLIF(lot.tr_reference, '')
        ) AS tr_reference,
        a.verified_at::text AS verified_at,
        a.stock_movement_line_id::text AS stock_movement_line_id,
        a.quantite,
        a.unite,
        a.created_at::text AS created_at,
        a.updated_at::text AS updated_at,
        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,
        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname
      FROM public.bon_livraison_ligne_allocations a
      JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
      JOIN public.bon_livraison delivery ON delivery.id = l.bon_livraison_id
      LEFT JOIN public.lots lot ON lot.id = a.lot_id
      LEFT JOIN public.articles article ON article.id = a.article_id
      LEFT JOIN public.magasins magasin ON magasin.id = a.magasin_id
      LEFT JOIN public.emplacements emplacement ON emplacement.id = a.emplacement_id
      LEFT JOIN public.stock_reservations reservation ON reservation.id = a.reservation_id
      LEFT JOIN public.commande_ligne_affaire_allocation commande_allocation
        ON commande_allocation.id = a.commande_ligne_affaire_allocation_id
      LEFT JOIN public.commande_client commande ON commande.id = commande_allocation.commande_id
      LEFT JOIN public.affaire allocation_affaire
        ON allocation_affaire.id = commande_allocation.livraison_affaire_id
      LEFT JOIN public.ordres_fabrication fabrication ON fabrication.id = reservation.of_id
      LEFT JOIN public.piece_technique_versions technical_version
        ON technical_version.id = lot.piece_technique_version_id
      LEFT JOIN LATERAL (
        SELECT version.plan_reference, version.indice, version.version_interne
        FROM public.piece_technique_versions version
        WHERE version.piece_technique_id = article.piece_technique_id
        ORDER BY
          version.is_current DESC,
          (lower(version.statut) = 'applicable') DESC,
          version.updated_at DESC,
          version.created_at DESC,
          version.id ASC
        LIMIT 1
      ) applicable_version ON true
      LEFT JOIN LATERAL (
        SELECT
          (
            SELECT string_agg(reference_value, ' · ' ORDER BY reference_value)
            FROM (
              SELECT DISTINCT reference_value
              FROM (
                SELECT reference.reference_value
                FROM public.stock_lot_trace_references reference
                WHERE reference.lot_id = a.lot_id AND reference.reference_type = 'OF'
                UNION ALL
                SELECT linked_of.numero
                FROM public.of_output_lots output
                JOIN public.ordres_fabrication linked_of ON linked_of.id = output.of_id
                WHERE output.lot_id = a.lot_id
              ) values_of(reference_value)
              WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
            ) distinct_of
          ) AS of_reference,
          (
            SELECT string_agg(reference_value, ' · ' ORDER BY reference_value)
            FROM (
              SELECT DISTINCT reference_value
              FROM (${stockLotTraceReferenceValuesSql("a.lot_id", "MP_LOT")}) recorded_origins
              WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
            ) distinct_mp(reference_value)
          ) AS mp_reference,
          (
            SELECT string_agg(reference_value, ' · ' ORDER BY reference_value)
            FROM (
              SELECT DISTINCT reference_value
              FROM (${stockLotTraceReferenceValuesSql("a.lot_id", "TRAITEMENT_LOT")}) recorded_origins
              WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
            ) distinct_tr(reference_value)
          ) AS tr_reference
      ) lot_trace ON a.lot_id IS NOT NULL
      LEFT JOIN users cb ON cb.id = a.created_by
      LEFT JOIN users ub ON ub.id = a.updated_by
      WHERE l.bon_livraison_id = $1::uuid
      ORDER BY a.created_at ASC, a.id ASC
      `,
      [id]
    )

    for (const r of allocRes.rows) {
      const alloc: BonLivraisonLigneAllocation = {
        id: r.id,
        bon_livraison_ligne_id: r.bon_livraison_ligne_id,
        article_id: r.article_id,
        lot_id: r.lot_id,
        lot_code: r.lot_code,
        lot_status: r.lot_status,
        magasin_id: r.magasin_id,
        magasin_code: r.magasin_code,
        emplacement_id: r.emplacement_id,
        emplacement_code: r.emplacement_code,
        location_id: r.location_id,
        stock_level_id: r.stock_level_id,
        stock_batch_id: r.stock_batch_id,
        reservation_id: r.reservation_id,
        reservation_status: r.reservation_status,
        source_scope: r.source_scope,
        commande_numero: r.commande_numero,
        affaire_reference: r.affaire_reference,
        article_reference: r.article_reference,
        article_indice: r.article_indice,
        article_version: r.article_version,
        quantite_commandee: r.quantite_commandee === null
          ? null
          : toFloat(r.quantite_commandee, "bon_livraison_ligne_allocations.quantite_commandee"),
        quantite_restante: r.quantite_restante === null
          ? null
          : toFloat(r.quantite_restante, "bon_livraison_ligne_allocations.quantite_restante"),
        of_numero: r.of_numero,
        mp_reference: r.mp_reference,
        tr_reference: r.tr_reference,
        verified_at: r.verified_at,
        stock_movement_line_id: r.stock_movement_line_id,
        quantite: toFloat(r.quantite, "bon_livraison_ligne_allocations.quantite"),
        unite: r.unite,
        created_at: r.created_at,
        updated_at: r.updated_at,
        created_by: mapUserLite({
          id: r.created_by_id,
          username: r.created_by_username,
          name: r.created_by_name,
          surname: r.created_by_surname,
        }),
        updated_by: mapUserLite({
          id: r.updated_by_id,
          username: r.updated_by_username,
          name: r.updated_by_name,
          surname: r.updated_by_surname,
        }),
      }

      const line = lignesById.get(alloc.bon_livraison_ligne_id)
      if (line) line.allocations.push(alloc)
    }

    // Documents
    type DocRow = {
      id: string
      bon_livraison_id: string
      document_id: string
      type: string | null
      version: number
      created_at: string
      uploaded_by_id: number | null
      uploaded_by_username: string | null
      uploaded_by_name: string | null
      uploaded_by_surname: string | null
      document_name: string | null
      document_type: string | null
      checksum_sha256: string | null
      file_size_bytes: number | null
      mime_type: string | null
    }

    const docsRes = await db.query<DocRow>(
      `
      SELECT
        d.id::text AS id,
        d.bon_livraison_id::text AS bon_livraison_id,
        d.document_id::text AS document_id,
        d.type,
        d.version,
        d.created_at::text AS created_at,
        u.id AS uploaded_by_id,
        u.username AS uploaded_by_username,
        u.name AS uploaded_by_name,
        u.surname AS uploaded_by_surname,
        dc.document_name,
        dc.type AS document_type,
        d.checksum_sha256,
        d.file_size_bytes::float8 AS file_size_bytes,
        d.mime_type
      FROM bon_livraison_documents d
      LEFT JOIN documents_clients dc ON dc.id = d.document_id
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.bon_livraison_id = $1::uuid
      ORDER BY d.created_at DESC, d.id DESC
      `,
      [id]
    )
    const documents: BonLivraisonDocument[] = docsRes.rows.map((r: DocRow) => ({
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      document_id: r.document_id,
      type: r.type,
      version: r.version,
      created_at: r.created_at,
      uploaded_by: mapUserLite({
        id: r.uploaded_by_id,
        username: r.uploaded_by_username,
        name: r.uploaded_by_name,
        surname: r.uploaded_by_surname,
      }),
      document_name: r.document_name,
      document_type: r.document_type,
      checksum_sha256: r.checksum_sha256,
      file_size_bytes: r.file_size_bytes,
      mime_type: r.mime_type,
    }))

    // Events
    type EventRow = {
      id: string
      bon_livraison_id: string
      event_type: string
      old_values: unknown | null
      new_values: unknown | null
      created_at: string
      user_id: number | null
      username: string | null
      name: string | null
      surname: string | null
    }

    const eventsRes = await db.query<EventRow>(
      `
      SELECT
        e.id::text AS id,
        e.bon_livraison_id::text AS bon_livraison_id,
        e.event_type,
        e.old_values,
        e.new_values,
        e.created_at::text AS created_at,
        u.id AS user_id,
        u.username,
        u.name,
        u.surname
      FROM bon_livraison_event_log e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.bon_livraison_id = $1::uuid
      ORDER BY e.created_at DESC, e.id DESC
      `,
      [id]
    )

    const events: BonLivraisonEventLog[] = eventsRes.rows.map((r: EventRow) => ({
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      event_type: r.event_type,
      old_values: r.old_values ?? null,
      new_values: r.new_values ?? null,
      user: mapUserLite({ id: r.user_id, username: r.username, name: r.name, surname: r.surname }),
      created_at: r.created_at,
    }))

    const proofs = await repoListLivraisonProofs(id, db)

    return { bon_livraison, lignes, documents, proofs, events }
  } finally {
    db.release()
  }
}
