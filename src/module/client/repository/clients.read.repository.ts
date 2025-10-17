// src/module/clients/repository/clients.read.repository.ts
import pool from "../../../config/database";

/**
 * Shape returned by GET /clients/:id — perfect for creating a commande client.
 * {
 *   client: {...},
 *   bill_address: {...},
 *   delivery_address: {...},
 *   bank: {...},
 *   biller: {...} | null,
 *   primary_contact: {...} | null,
 *   payment_modes: [{ id, code, type }]
 * }
 */
export async function repoGetClientById(clientId: string) {
  const { rows } = await pool.query(
    `
    SELECT
      c.client_id,
      c.company_name, c.email, c.phone, c.website_url,
      c.siret, c.vat_number, c.naf_code,
      c.status, c.blocked, c.reason, c.creation_date,
      c.observations, c.provided_documents_id,

      -- biller
      f.biller_id, f.biller_name,

      -- addresses
      af.bill_address_id, af.name AS bill_name, af.street AS bill_street, af.house_number AS bill_house_number,
      af.postal_code AS bill_postal_code, af.city AS bill_city, af.country AS bill_country,

      al.delivery_address_id, al.name AS deliv_name, al.street AS deliv_street, al.house_number AS deliv_house_number,
      al.postal_code AS deliv_postal_code, al.city AS deliv_city, al.country AS deliv_country,

      -- bank
      ib.bank_info_id, ib.name AS bank_name, ib.iban, ib.bic,

      -- primary contact
      ct.contact_id, ct.first_name, ct.last_name, ct.civility, ct.role, ct.phone_personal, ct.email AS contact_email
    FROM clients c
    LEFT JOIN factureur f ON f.biller_id = c.biller_id
    LEFT JOIN adresse_facturation af ON af.bill_address_id = c.bill_address_id
    LEFT JOIN adresse_livraison  al ON al.delivery_address_id = c.delivery_address_id
    LEFT JOIN informations_bancaires ib ON ib.bank_info_id = c.bank_info_id
    LEFT JOIN contacts ct ON ct.contact_id = c.contact_id
    WHERE c.client_id = $1
    `,
    [clientId]
  );

  if (rows.length === 0) return null;
  const r = rows[0];

  // payment modes (N:M)
  const pm = await pool.query(
    `
    SELECT mr.payment_id AS id, mr.payment_code AS code, mr.type
    FROM client_payment_modes cpm
  JOIN mode_reglement mr ON mr.payment_id = cpm.payment_id
    WHERE cpm.client_id = $1
    ORDER BY mr.payment_code ASC
    `,
    [clientId]
  );

  return {
    client: {
      client_id: r.client_id,
      company_name: r.company_name,
      email: r.email ?? null,
      phone: r.phone ?? null,
      website_url: r.website_url ?? null,
      siret: r.siret ?? null,
      vat_number: r.vat_number ?? null,
      naf_code: r.naf_code ?? null,
      status: r.status,
      blocked: !!r.blocked,
      reason: r.reason ?? null,
      creation_date: r.creation_date,
      observations: r.observations ?? null,
      provided_documents_id: r.provided_documents_id ?? null,
    },
    biller: r.biller_id
      ? { id: r.biller_id, name: r.biller_name }
      : null,
    bill_address: {
      id: r.bill_address_id,
      name: r.bill_name,
      street: r.bill_street,
      house_number: r.bill_house_number,
      postal_code: r.bill_postal_code,
      city: r.bill_city,
      country: r.bill_country,
    },
    delivery_address: {
      id: r.delivery_address_id,
      name: r.deliv_name,
      street: r.deliv_street,
      house_number: r.deliv_house_number,
      postal_code: r.deliv_postal_code,
      city: r.deliv_city,
      country: r.deliv_country,
    },
    bank: {
      id: r.bank_info_id,
      bank_name: r.bank_name,
      iban: r.iban,
      bic: r.bic,
    },
    primary_contact: r.contact_id
      ? {
          contact_id: r.contact_id,
          first_name: r.first_name,
          last_name: r.last_name,
          civility: r.civility,
          role: r.role,
          phone_personal: r.phone_personal,
          email: r.contact_email,
        }
      : null,
    payment_modes: pm.rows.map((x) => ({ id: x.id, code: x.code, type: x.type })),
  };
}

/**
 * Lightweight list for selectors/search.
 * Supports ?q= and ?limit=
 */
export async function repoListClients(q: string, limit = 25) {
  const like = `%${q.trim().toLowerCase()}%`;
  const { rows } = await pool.query(
    `
    SELECT client_id, company_name, email, siret
    FROM clients
    WHERE
      ($1 = '%%')
      OR (LOWER(company_name) LIKE $1 OR LOWER(client_id) LIKE $1 OR LOWER(COALESCE(email,'')) LIKE $1 OR COALESCE(siret,'') LIKE replace($1,'%',''))
    ORDER BY company_name ASC
    LIMIT $2
    `,
    [like, limit]
  );
  return rows as Array<{ client_id: string; company_name: string; email: string | null; siret: string | null }>;
}
