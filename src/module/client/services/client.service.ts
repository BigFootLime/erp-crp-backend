// src/module/client/services/client.service.ts
import pool from "../../../config/database";
import { normalizeStoredImagePath } from "../../../utils/imageStorage";
import { findAssetIdsByStorageKeys } from "../../operational-media/repository/operational-media.repository";

export type ClientRow = {
  client_id: string
  client_code: string | null
  company_name: string
  customer_type: "PROFESSIONAL" | "INDIVIDUAL"
  individual_first_name: string | null
  individual_last_name: string | null
  email: string | null
  phone: string | null
  website_url: string | null
  siret: string | null
  vat_number: string | null
  naf_code: string | null
  status: string
  blocked: boolean | null
  reason: string | null
  creation_date: string
  observations: string | null
  provided_documents_id: string | null
  quality_level: string | null;
  quality_levels: string[] | null
  devise: string | null
  encours_max: number | null
  incoterm: string | null
  langue: string | null

   /** Legacy storage field is never serialized as a path. */
   logo_path: null
   logo_url: null
   logo_asset: { asset_id: string; status: "AVAILABLE" } | null

  delivery_address_id: string | null
  bill_address_id: string | null
  biller_id: string | null

  // Billing address
  bill_name: string | null
  bill_street: string | null
  bill_house_number: string | null
  bill_address_complement: string | null
  bill_postal_code: string | null
  bill_city: string | null
  bill_country: string | null

  // Delivery address
  deliv_name: string | null
  deliv_street: string | null
  deliv_house_number: string | null
  deliv_address_complement: string | null
  deliv_postal_code: string | null
  deliv_city: string | null
  deliv_country: string | null

  // Bank — volontairement sans IBAN/BIC : données critiques réservées à la
  // fiche détail (masquées, RBAC finance). La liste n'en a aucun besoin métier.
  bank_name: string | null

  // Primary contact — phone_personal exclu (PII élevée, jamais en liste).
  contact_first_name: string | null
  contact_last_name: string | null
  contact_email: string | null
  contact_phone_direct: string | null
  contact_role: string | null
  contact_civility: string | null

  // Liste de contacts pour le dropdown
 contacts: Array<{
   contact_id: string
   full_name: string | null
   email: string | null
   role: string | null
   phone_direct: string | null
 }>


  // Payment modes
  payment_mode_ids: string[]
   payment_mode_labels: string[]  
}

export async function getClientById(id: string): Promise<ClientRow | null> {
  const { rows } = await pool.query<ClientRow>(
    `SELECT client_id, company_name, email, phone
     FROM clients
     WHERE client_id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateClientLogoPath(id: string, logoPath: string): Promise<void> {
  await pool.query(
    `UPDATE clients
        SET logo_path = $1
      WHERE client_id = $2`,
    [logoPath, id]
  );
}


/**
 * A short numeric search is a client-code lookup, not a broad text search.
 * Without this distinction, entering "001" also matched SIRETs and made the
 * client selector unreliable. The stored legacy code may be "001", "CLI-001"
 * or "CLI 001"; all three forms are normalized by the SQL predicate below.
 */
function exactClientCodeQuery(q: string): string | null {
  const match = q.trim().match(/^(?:CLI[-\s]?)?(\d{1,3})$/i);
  if (!match) return null;

  return `CLI-${match[1].padStart(3, "0")}`;
}

export async function listClients(q = "", limit = 25): Promise<ClientRow[]> {
  const codeQuery = exactClientCodeQuery(q);
  const sql = `
  SELECT
    c.client_id::text,
    COALESCE(
      NULLIF(btrim(to_jsonb(c)->>'client_code'), ''),
      NULLIF(btrim(to_jsonb(c)->>'code_client'), '')
    ) AS client_code,
    c.company_name,
    COALESCE(NULLIF(btrim(to_jsonb(c)->>'customer_type'), ''), 'PROFESSIONAL') AS customer_type,
    CASE WHEN COALESCE(NULLIF(btrim(to_jsonb(c)->>'customer_type'), ''), 'PROFESSIONAL') = 'INDIVIDUAL'
      THEN NULLIF(btrim(to_jsonb(c)->>'individual_first_name'), '') END AS individual_first_name,
    CASE WHEN COALESCE(NULLIF(btrim(to_jsonb(c)->>'customer_type'), ''), 'PROFESSIONAL') = 'INDIVIDUAL'
      THEN NULLIF(btrim(to_jsonb(c)->>'individual_last_name'), '') END AS individual_last_name,
    c.email, c.phone, c.website_url,
    CASE WHEN COALESCE(NULLIF(btrim(to_jsonb(c)->>'customer_type'), ''), 'PROFESSIONAL') = 'INDIVIDUAL' THEN NULL ELSE c.siret END AS siret,
    CASE WHEN COALESCE(NULLIF(btrim(to_jsonb(c)->>'customer_type'), ''), 'PROFESSIONAL') = 'INDIVIDUAL' THEN NULL ELSE c.vat_number END AS vat_number,
    CASE WHEN COALESCE(NULLIF(btrim(to_jsonb(c)->>'customer_type'), ''), 'PROFESSIONAL') = 'INDIVIDUAL' THEN NULL ELSE c.naf_code END AS naf_code,
    c.status, c.blocked, c.reason, c.creation_date,
    c.observations, c.provided_documents_id,
    c.quality_level,
    c.quality_levels,
    -- Finance structurée (#162) — lecture tolérante tant que le patch
    -- 20260720_clients_360_hardening n'est pas appliqué partout.
    NULLIF(btrim(to_jsonb(c)->>'devise'), '') AS devise,
    NULLIF(btrim(to_jsonb(c)->>'encours_max'), '')::numeric AS encours_max,
    NULLIF(btrim(to_jsonb(c)->>'incoterm'), '') AS incoterm,
    NULLIF(btrim(to_jsonb(c)->>'langue'), '') AS langue,
    c.logo_path, 

    c.delivery_address_id::text AS delivery_address_id,
    c.bill_address_id::text AS bill_address_id,
    c.biller_id::text AS biller_id,

    -- Facturation
    af.name AS bill_name, af.street AS bill_street, af.house_number AS bill_house_number,
    af.address_complement AS bill_address_complement,
    af.postal_code AS bill_postal_code, af.city AS bill_city, af.country AS bill_country,

    -- Livraison
    al.name AS deliv_name, al.street AS deliv_street, al.house_number AS deliv_house_number,
    al.address_complement AS deliv_address_complement,
    al.postal_code AS deliv_postal_code, al.city AS deliv_city, al.country AS deliv_country,

    -- Banque : nom seul. Les coordonnées bancaires ne sortent JAMAIS par la
    -- liste (PII critique, réservées au détail avec masquage + RBAC finance).
    ib.name AS bank_name,

    -- Contact principal (aplati) — sans téléphone personnel (PII élevée).
    ct.first_name AS contact_first_name, ct.last_name AS contact_last_name,
    ct.email AS contact_email, ct.phone_direct AS contact_phone_direct,
    ct.role AS contact_role, ct.civility AS contact_civility,

    -- Tous les contacts du client (pour dropdown) — sans téléphone personnel.
    COALESCE(
      json_agg(
        DISTINCT jsonb_build_object(
          'contact_id',      ct2.contact_id::text,
          'full_name',       trim(concat(ct2.civility,' ',ct2.first_name,' ',ct2.last_name)),
          'email',           ct2.email,
          'role',            ct2.role,
          'phone_direct',    ct2.phone_direct
        )
      ) FILTER (WHERE ct2.contact_id IS NOT NULL),
      '[]'
    ) AS contacts,

    -- Modes de reglement (ids)
    COALESCE(
      ARRAY_REMOVE(
        ARRAY_AGG(DISTINCT cpm.payment_id::text),
        NULL
      ),
      '{}'
    ) AS payment_mode_ids,

    -- Modes de règlement (libellés) — version robuste sans FILTER
    COALESCE(
      ARRAY_REMOVE(
        ARRAY_AGG(DISTINCT
          CASE
            WHEN mr.payment_code IS NOT NULL THEN
              mr.payment_code || CASE WHEN mr.type IS NOT NULL THEN ' — ' || mr.type ELSE '' END
            ELSE NULL
          END
        ),
        NULL
      ),
      '{}'
    ) AS payment_mode_labels

  FROM clients c
  LEFT JOIN adresse_facturation    af  ON af.bill_address_id     = c.bill_address_id
  LEFT JOIN adresse_livraison      al  ON al.delivery_address_id = c.delivery_address_id
  LEFT JOIN informations_bancaires ib  ON ib.bank_info_id        = c.bank_info_id

  -- Contact principal (une seule fois !)
  LEFT JOIN contacts               ct  ON ct.contact_id          = c.contact_id

  -- Tous les contacts liés à ce client (pour le dropdown)
  LEFT JOIN contacts               ct2 ON ct2.client_id          = c.client_id

  LEFT JOIN client_payment_modes   cpm ON cpm.client_id          = c.client_id
  LEFT JOIN mode_reglement         mr  ON mr.payment_id          = cpm.payment_id

    WHERE
      $1 = '' OR (
        CASE
          WHEN $3::text IS NOT NULL THEN
            'CLI-' || LPAD(
              REGEXP_REPLACE(
                COALESCE(
                  NULLIF(btrim(to_jsonb(c)->>'client_code'), ''),
                  NULLIF(btrim(to_jsonb(c)->>'code_client'), '')
                ),
                '^CLI[- ]?',
                '',
                'i'
              ),
              3,
              '0'
            ) = $3
          ELSE
            c.company_name ILIKE '%' || $1 || '%'
            OR COALESCE(
              NULLIF(btrim(to_jsonb(c)->>'client_code'), ''),
              NULLIF(btrim(to_jsonb(c)->>'code_client'), '')
            ) ILIKE '%' || $1 || '%'
            OR c.email ILIKE '%' || $1 || '%'
            OR c.siret ILIKE replace('%' || $1 || '%',' ','')
            OR c.vat_number ILIKE '%' || $1 || '%'
            OR af.city ILIKE '%' || $1 || '%'
            OR al.city ILIKE '%' || $1 || '%'
        END
      )

  GROUP BY
    c.client_id, af.bill_address_id, al.delivery_address_id, ib.bank_info_id, ct.contact_id

  ORDER BY c.company_name ASC
  LIMIT $2
`;

  const { rows } = await pool.query<Omit<ClientRow, "logo_path" | "logo_url" | "logo_asset"> & { logo_path: string | null }>(sql, [q, limit, codeQuery]);
  const ids = await findAssetIdsByStorageKeys(rows.map((row) => row.logo_path));
  return rows.map((row) => {
    const assetId = ids.get(normalizeStoredImagePath(row.logo_path) ?? "") ?? null;
    return { ...row, logo_path: null, logo_url: null, logo_asset: assetId ? { asset_id: assetId, status: "AVAILABLE" as const } : null };
  });
}
// createClient (MAX+1 sur client_id) et updateClientPrimaryContact (sans
// vérification d'appartenance) ont été supprimés (#162) : la création passe par
// repoCreateClient (code serveur transactionnel) et la bascule de contact
// principal par repoSetPrimaryContact (appartenance vérifiée sous transaction).

export type ClientContactRow = {
  contact_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_direct: string | null;
  phone_personal: string | null;
  role: string | null;
  civility: string | null;
  label: string;
};

/**
 * Contacts d'un client. phone_personal (PII élevée, matrice données sensibles)
 * n'est renvoyé qu'aux rôles finance/gestion clients ; masqué à null sinon.
 */
export async function listClientContacts(
  clientId: string,
  options: { includePersonalPhone?: boolean } = {}
): Promise<ClientContactRow[]> {
  const { rows } = await pool.query<ClientContactRow>(
    `
    SELECT
      contact_id::text AS contact_id,
      first_name,
      last_name,
      email,
      phone_direct,
      phone_personal,
      role,
      civility
    FROM contacts
    WHERE client_id = $1
    ORDER BY last_name ASC, first_name ASC
    `,
    [clientId]
  );
  return rows.map((r) => ({
    ...r,
    phone_personal: options.includePersonalPhone ? r.phone_personal : null,
    label: `${r.first_name} ${r.last_name} — ${r.email}`,
  }));
}

export type CreateClientContactInput = {
  first_name: string;
  last_name: string;
  email: string;
  phone_direct?: string | null;
  phone_personal?: string | null;
  role?: string | null;
  civility?: string | null;
  set_primary?: boolean;
};

// La création de contact (avec promotion set_primary éventuelle) est désormais
// transactionnelle et auditée : voir repoCreateClientContact dans le repository.


/**
 * Minimal identity used by a quote. It deliberately excludes generic client
 * contact and finance fields while keeping the safe operational-media asset id
 * required to render an already selected quote customer in generated documents.
 */
export async function getClientQuoteReferenceById(id: string): Promise<{
  client_id: string;
  client_code: string | null;
  company_name: string;
  status: string;
  blocked: boolean;
  logo_asset: { asset_id: string; status: "AVAILABLE" } | null;
} | null> {
  const { rows } = await pool.query<{
    client_id: string;
    client_code: string | null;
    company_name: string;
    status: string;
    blocked: boolean | null;
    logo_path: string | null;
  }>(`
    SELECT c.client_id::text,
      COALESCE(NULLIF(btrim(to_jsonb(c)->>'client_code'), ''), NULLIF(btrim(to_jsonb(c)->>'code_client'), '')) AS client_code,
      c.company_name, c.status, c.blocked, c.logo_path
    FROM clients c
    WHERE c.client_id = $1
  `, [id]);
  const row = rows[0];
  if (!row) return null;
  const assets = await findAssetIdsByStorageKeys([row.logo_path]);
  const assetId = assets.get(normalizeStoredImagePath(row.logo_path) ?? "") ?? null;
  return {
    client_id: row.client_id,
    client_code: row.client_code,
    company_name: row.company_name,
    status: row.status,
    blocked: Boolean(row.blocked),
    logo_asset: assetId ? { asset_id: assetId, status: "AVAILABLE" } : null,
  };
}
