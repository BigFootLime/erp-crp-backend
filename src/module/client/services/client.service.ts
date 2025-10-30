// src/module/client/services/client.service.ts
import pool from "../../../config/database";

export type ClientRow = {
  client_id: string
  company_name: string
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

  // Billing address
  bill_name: string | null
  bill_street: string | null
  bill_house_number: string | null
  bill_postal_code: string | null
  bill_city: string | null
  bill_country: string | null

  // Delivery address
  deliv_name: string | null
  deliv_street: string | null
  deliv_house_number: string | null
  deliv_postal_code: string | null
  deliv_city: string | null
  deliv_country: string | null

  // Bank
  bank_name: string | null
  iban: string | null
  bic: string | null

  // Primary contact
  contact_first_name: string | null
  contact_last_name: string | null
  contact_email: string | null
  contact_phone_personal: string | null
  contact_role: string | null
  contact_civility: string | null

  // Liste de contacts pour le dropdown
contacts: Array<{
  contact_id: string;
  full_name: string;
  email: string | null;
  role: string | null;
  phone_personal: string | null;
}>; 

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

export async function listClients(q = "", limit = 25): Promise<ClientRow[]> {
  const sql = `
    SELECT
      c.client_id::text,
      c.company_name, c.email, c.phone, c.website_url,
      c.siret, c.vat_number, c.naf_code,
      c.status, c.blocked, c.reason, c.creation_date,
      c.observations, c.provided_documents_id,
      c.quality_level,    

      -- Facturation
      af.name AS bill_name, af.street AS bill_street, af.house_number AS bill_house_number,
      af.postal_code AS bill_postal_code, af.city AS bill_city, af.country AS bill_country,

      -- Livraison
      al.name AS deliv_name, al.street AS deliv_street, al.house_number AS deliv_house_number,
      al.postal_code AS deliv_postal_code, al.city AS deliv_city, al.country AS deliv_country,

      -- Banque
      ib.name AS bank_name, ib.iban, ib.bic,

      -- Contact
      ct.first_name AS contact_first_name, ct.last_name AS contact_last_name,
      ct.email AS contact_email, ct.phone_personal AS contact_phone_personal,
      ct.role AS contact_role, ct.civility AS contact_civility,

      COALESCE(
  json_agg(
    DISTINCT jsonb_build_object(
      'contact_id',   ct2.contact_id::text,
      'full_name',    trim(concat(ct2.civility,' ',ct2.first_name,' ',ct2.last_name)),
      'email',        ct2.email,
      'role',         ct2.role,
      'phone_personal', ct2.phone_personal
    )
  ) FILTER (WHERE ct2.contact_id IS NOT NULL),
  '[]'
) AS contacts


      -- Modes de règlement (libellés)
      COALESCE(
       ARRAY_AGG(DISTINCT (mr.payment_code || COALESCE(' — ' || mr.type, ''))) FILTER (WHERE mr.payment_code IS NOT NULL),
        '{}'
      ) AS payment_mode_labels

    FROM clients c
    LEFT JOIN adresse_facturation   af  ON af.bill_address_id     = c.bill_address_id
    LEFT JOIN adresse_livraison     al  ON al.delivery_address_id = c.delivery_address_id
    LEFT JOIN informations_bancaires ib  ON ib.bank_info_id       = c.bank_info_id
    LEFT JOIN contacts              ct  ON ct.contact_id          = c.contact_id
    LEFT JOIN contacts ct   ON ct.contact_id = c.contact_id           -- primaire (aplati)
    LEFT JOIN contacts ct2  ON ct2.client_id  = c.client_id           -- liste pour dropdown

    LEFT JOIN client_payment_modes  cpm ON cpm.client_id          = c.client_id
    LEFT JOIN mode_reglement        mr  ON mr.payment_id          = cpm.payment_id   -- <---
    

    WHERE
      $1 = '' OR (
        c.company_name ILIKE '%' || $1 || '%'
        OR c.email ILIKE '%' || $1 || '%'
        OR c.siret ILIKE replace('%' || $1 || '%',' ','')
        OR c.vat_number ILIKE '%' || $1 || '%'
        OR af.city ILIKE '%' || $1 || '%'
        OR al.city ILIKE '%' || $1 || '%'
      )

    GROUP BY
      c.client_id, af.bill_address_id, al.delivery_address_id, ib.bank_info_id, ct.contact_id

    ORDER BY c.company_name ASC
    LIMIT $2
  `;
  const { rows } = await pool.query<ClientRow>(sql, [q, limit]);
  return rows;
}
export async function createClient(data: {
  company_name: string;
  email?: string;
  phone?: string;
  // …the rest of your payload
}): Promise<ClientRow> {
  const { rows } = await pool.query<ClientRow>(
    `INSERT INTO clients (client_id, company_name, email, phone)
     VALUES (
       lpad((SELECT COALESCE(MAX(client_id)::int,0)+1 FROM clients)::text, 3, '0'),
       $1, $2, $3
     )
     RETURNING client_id, company_name, email, phone`,
    [data.company_name, data.email ?? null, data.phone ?? null]
  );
  return rows[0];
}

export async function updateClientPrimaryContact(clientId: string, contactId: string) {
  await pool.query(`UPDATE clients SET contact_id = $1 WHERE client_id = $2`, [contactId, clientId]);
}

