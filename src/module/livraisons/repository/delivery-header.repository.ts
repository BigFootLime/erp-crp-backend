import type { PoolClient } from "pg"

import { HttpError } from "../../../utils/httpError"
import type {
  AdresseLivraisonLite,
  BonLivraisonStatut,
  UserLite,
} from "../types/livraisons.types"

export function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  throw new Error(`Invalid ${label}: ${String(value)}`)
}

export function toFloat(value: unknown, label = "value"): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`Invalid ${label}: ${String(value)}`)
}
export function mapUserLite(row: {
  id: number | null
  username: string | null
  name: string | null
  surname: string | null
}): UserLite | null {
  if (!row.id || !row.username) return null
  const parts = [row.surname ?? "", row.name ?? ""].map((s) => s.trim()).filter(Boolean)
  const label = parts.join(" ").trim() || row.username
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    surname: row.surname,
    label,
  }
}

export function formatAddressInline(a: {
  name: string | null
  street: string | null
  house_number: string | null
  postal_code: string | null
  city: string | null
  country: string | null
}): string {
  const line1 = [a.street, a.house_number].map((s) => (s ?? "").trim()).filter(Boolean).join(" ")
  const line2 = [a.postal_code, a.city].map((s) => (s ?? "").trim()).filter(Boolean).join(" ")
  const parts = [a.name, line1, line2, a.country].map((s) => (s ?? "").trim()).filter(Boolean)
  return parts.join(", ")
}

export type HeaderRow = {
  id: string
  numero: string
  statut: BonLivraisonStatut
  client_id: string
  client_code: string | null
  client_company_name: string
  commande_id: string | null
  commande_numero: string | null
  commande_numeros: string[]
  affaire_id: string | null
  affaire_reference: string | null
  affaire_references: string[]
  adresse_livraison_id: string | null
  intercompany_request_id: string | null
  intercompany_destination_snapshot: Record<string, unknown> | null
  al_name: string | null
  al_street: string | null
  al_house_number: string | null
  al_postal_code: string | null
  al_city: string | null
  al_country: string | null
  date_creation: string
  date_expedition: string | null
  date_livraison: string | null
  transporteur: string | null
  tracking_number: string | null
  commentaire_interne: string | null
  commentaire_client: string | null
  reception_nom_signataire: string | null
  reception_date_signature: string | null
  row_version: number
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

export function intercompanyDestinationAddress(
  deliveryId: string,
  snapshot: Record<string, unknown> | null
): AdresseLivraisonLite {
  if (!snapshot) return null
  const required = (key: string) => {
    const value = snapshot[key]
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
  const recipient = required("recipient_name")
  const line1 = required("address_line_1")
  const postalCode = required("postal_code")
  const city = required("city")
  if (!recipient || !line1 || !postalCode || !city) {
    throw new HttpError(409, "INTERCOMPANY_DELIVERY_DESTINATION_INVALID", "La destination fournisseur figée est incomplète.")
  }
  const addressLine2 = required("address_line_2")
  const country = required("country_code")
  const address = {
    id: `intercompany:${deliveryId}`,
    name: recipient,
    street: line1,
    house_number: null,
    address_complement: addressLine2,
    postal_code: postalCode,
    city,
    country,
  }
  const label = [recipient, line1, addressLine2, `${postalCode} ${city}`, country]
    .filter((part): part is string => Boolean(part))
    .join(", ")
  return { ...address, label: label || "Adresse de livraison" }
}

export async function getHeader(client: PoolClient, id: string, opts?: { forUpdate?: boolean }): Promise<HeaderRow | null> {
  const lock = opts?.forUpdate ? "FOR UPDATE OF bl" : ""
  const sql = `
    SELECT
      bl.id::text AS id,
      bl.numero,
      bl.statut,
      bl.client_id,
      c.client_code,
      c.company_name AS client_company_name,
      bl.commande_id::text AS commande_id,
      cc.numero AS commande_numero,
      ARRAY(
        SELECT reference
        FROM (
          SELECT DISTINCT scope_commande.numero AS reference
          FROM public.bon_livraison_ligne scope_line
          JOIN public.bon_livraison_ligne_allocations scope_bla
            ON scope_bla.bon_livraison_ligne_id = scope_line.id
          JOIN public.commande_ligne_affaire_allocation scope_allocation
            ON scope_allocation.id = scope_bla.commande_ligne_affaire_allocation_id
          JOIN public.commande_client scope_commande
            ON scope_commande.id = scope_allocation.commande_id
          WHERE scope_line.bon_livraison_id = bl.id
          UNION
          SELECT cc.numero WHERE cc.numero IS NOT NULL
        ) commande_scope
        ORDER BY reference
      ) AS commande_numeros,
      bl.affaire_id::text AS affaire_id,
      a.reference AS affaire_reference,
      ARRAY(
        SELECT reference
        FROM (
          SELECT DISTINCT scope_affaire.reference
          FROM public.bon_livraison_ligne scope_line
          JOIN public.bon_livraison_ligne_allocations scope_bla
            ON scope_bla.bon_livraison_ligne_id = scope_line.id
          JOIN public.commande_ligne_affaire_allocation scope_allocation
            ON scope_allocation.id = scope_bla.commande_ligne_affaire_allocation_id
          JOIN public.affaire scope_affaire
            ON scope_affaire.id = scope_allocation.livraison_affaire_id
          WHERE scope_line.bon_livraison_id = bl.id
          UNION
          SELECT a.reference WHERE a.reference IS NOT NULL
        ) affaire_scope
        ORDER BY reference
      ) AS affaire_references,
      bl.adresse_livraison_id::text AS adresse_livraison_id,
      bl.intercompany_request_id::text AS intercompany_request_id,
      bl.intercompany_destination_snapshot,
      al.name AS al_name,
      al.street AS al_street,
      al.house_number AS al_house_number,
      al.postal_code AS al_postal_code,
      al.city AS al_city,
      al.country AS al_country,
      bl.date_creation::text AS date_creation,
      bl.date_expedition::text AS date_expedition,
      bl.date_livraison::text AS date_livraison,
      bl.transporteur,
      bl.tracking_number,
      bl.commentaire_interne,
      bl.commentaire_client,
      bl.reception_nom_signataire,
      bl.reception_date_signature::text AS reception_date_signature,
      bl.row_version::int AS row_version,
      bl.created_at::text AS created_at,
      bl.updated_at::text AS updated_at,
      cb.id AS created_by_id,
      cb.username AS created_by_username,
      cb.name AS created_by_name,
      cb.surname AS created_by_surname,
      ub.id AS updated_by_id,
      ub.username AS updated_by_username,
      ub.name AS updated_by_name,
      ub.surname AS updated_by_surname
    FROM bon_livraison bl
    JOIN clients c ON c.client_id = bl.client_id
    LEFT JOIN commande_client cc ON cc.id = bl.commande_id
    LEFT JOIN affaire a ON a.id = bl.affaire_id
    LEFT JOIN adresse_livraison al ON al.delivery_address_id = bl.adresse_livraison_id
    LEFT JOIN users cb ON cb.id = bl.created_by
    LEFT JOIN users ub ON ub.id = bl.updated_by
    WHERE bl.id = $1::uuid
    ${lock}
  `
  const res = await client.query<HeaderRow>(sql, [id])
  return res.rows[0] ?? null
}
