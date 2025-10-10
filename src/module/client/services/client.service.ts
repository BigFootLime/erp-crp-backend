// src/module/client/services/client.service.ts
import pool from "../../../config/database";

export type ClientRow = {
  client_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  // … add the rest you select
};

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
  const { rows } = await pool.query<ClientRow>(
    `SELECT client_id, company_name, email, phone
     FROM clients
     WHERE $1 = '' OR company_name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%'
     ORDER BY company_name ASC
     LIMIT $2`,
    [q, limit]
  );
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
