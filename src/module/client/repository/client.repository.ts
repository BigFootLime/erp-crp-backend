// src/module/clients/repository/clients.repository.ts
import pool from "../../../config/database";
import { CreateClientDTO } from "../validators/client.validators";

/** 001, 002, ... (3 chars) */
async function nextClientId(client: any): Promise<string> {
  const { rows } = await client.query(
    `SELECT LPAD(CAST(COALESCE(MAX(client_id)::int,0)+1 AS text),3,'0') AS next_id FROM clients`
  );
  return rows[0].next_id as string;
}

async function insertAddressFacturation(client: any, a: CreateClientDTO["bill_address"]) {
  const { rows } = await client.query(
    `INSERT INTO adresse_facturation (street,house_number,postal_code,city,country,name)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING bill_address_id`,
    [a.street, a.house_number ?? null, a.postal_code, a.city, a.country, a.name]
  );
  return rows[0].bill_address_id as string;
}

async function insertAddressLivraison(client: any, a: CreateClientDTO["delivery_address"]) {
  const { rows } = await client.query(
    `INSERT INTO adresse_livraison (street,house_number,postal_code,city,country,name)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING delivery_address_id`,
    [a.street, a.house_number ?? null, a.postal_code, a.city, a.country, a.name]
  );
  return rows[0].delivery_address_id as string;
}

async function upsertBank(client: any, bank: CreateClientDTO["bank"]) {
  const { rows } = await client.query(
    `INSERT INTO informations_bancaires (iban,bic,name)
     VALUES ($1,$2,$3)
     ON CONFLICT (iban) DO UPDATE SET bic=EXCLUDED.bic, name=EXCLUDED.name
     RETURNING bank_info_id`,
    [bank.iban, bank.bic, bank.bank_name]
  );
  return rows[0].bank_info_id as string;
}

async function insertClient(
  db: any,
  dto: CreateClientDTO,
  billAddrId: string,
  delivAddrId: string,
  bankInfoId: string
): Promise<string> {
  const normalizedProvidedDocsId =
    dto.provided_documents_id && dto.provided_documents_id.trim() !== ''
      ? dto.provided_documents_id
      : null;

  const q = `
  INSERT INTO clients (
    company_name, contact_id,
    email, phone, website_url,
    siret, vat_number, naf_code,
    status, blocked, reason, creation_date,
    delivery_address_id, bill_address_id, bank_info_id,
    observations, provided_documents_id,
    quality_levels               
  ) VALUES (
    $1,$2,
    NULLIF($3,''), NULLIF($4,''), NULLIF($5,''),
    NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
    $9, $10, NULLIF($11,''), COALESCE($12::timestamp, now()),
    $13, $14, $15,
    NULLIF($16,''), $17,
    COALESCE($18::text[], '{}')   
  )
  RETURNING client_id
`;


 const { rows } = await db.query(q, [
  dto.company_name, null,
  dto.email ?? "", dto.phone ?? "", dto.website_url ?? "",
  dto.siret ?? "", dto.vat_number ?? "", dto.naf_code ?? "",
  dto.status, dto.blocked, dto.reason ?? "", dto.creation_date,
  delivAddrId, billAddrId, bankInfoId,
  dto.observations ?? "", normalizedProvidedDocsId,
  dto.quality_levels ?? []              // ⬅️ nouveau param
]);

  return rows[0].client_id as string;
}

async function insertPrimaryContact(client: any, dto: NonNullable<CreateClientDTO["primary_contact"]>, clientId: string) {
  const { rows } = await client.query(
    `INSERT INTO contacts (first_name,last_name,civility,role,phone_personal,email,client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING contact_id`,
    [dto.first_name, dto.last_name, dto.civility ?? null, dto.role ?? null, dto.phone_personal ?? null, dto.email, clientId]
  );
  return rows[0].contact_id as string;
}

async function insertContact(db: any, c: NonNullable<CreateClientDTO["contacts"]>[number], clientId: string) {
  const { rows } = await db.query(
    `INSERT INTO contacts (first_name,last_name,civility,role,phone_personal,email,client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING contact_id`,
    [c.first_name, c.last_name, c.civility ?? null, c.role ?? null, c.phone_personal ?? null, c.email, clientId]
  );
  return rows[0].contact_id as string;
}


async function linkPaymentModes(db: any, clientId: string, idsOrCodes: string[]) {
  if (!idsOrCodes?.length) return;

  const paymentIds = await resolvePaymentIds(db, idsOrCodes);

  const params = [clientId, ...paymentIds];
  const values = paymentIds.map((_, i) => `($1,$${i + 2})`).join(',');

  await db.query(
    `INSERT INTO client_payment_modes (client_id, payment_id)
     VALUES ${values}
     ON CONFLICT (client_id,payment_id) DO NOTHING`,
    params
  );
}




// src/module/clients/repository/clients.repository.ts

type PaymentRow = { payment_id: string };

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolvePaymentIds(db: any, ids: string[]): Promise<string[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  // keep only valid-looking UUIDs; trim & dedupe
  const asked = Array.from(
    new Set(
      ids
        .map((v) => (v ?? "").trim())
        .filter((v): v is string => v.length > 0 && uuidRe.test(v))
    )
  );
  if (asked.length === 0) return [];

  // select by UUIDs
  const result = await db.query(
    `SELECT payment_id
       FROM mode_reglement
      WHERE payment_id = ANY($1::uuid[])`,
    [asked]
  );
  const rows = result.rows as PaymentRow[];

  const found = new Set(rows.map((r) => r.payment_id));
  const missing = asked.filter((id) => !found.has(id));

  if (missing.length) {
    const err = new Error(`Unknown payment_id(s): ${missing.join(", ")}`);
    (err as any).status = 400;
    throw err;
  }

  return Array.from(found);
}



export async function repoCreateClient(dto: CreateClientDTO): Promise<{ client_id: string }> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const billAddrId = await insertAddressFacturation(db, dto.bill_address);
    const delivAddrId = await insertAddressLivraison(db, dto.delivery_address);
    const bankInfoId = await upsertBank(db, dto.bank);

    // ✅ récupère l'ID généré par le trigger
    const clientId = await insertClient(db, dto, billAddrId, delivAddrId, bankInfoId);

    // (optionnel) verrou léger pour s'assurer de la visibilité dans la TX
    await db.query(`SELECT 1 FROM clients WHERE client_id = $1 FOR UPDATE`, [clientId]);

    let contactId: string | null = null;
    if (dto.primary_contact) {
      contactId = await insertPrimaryContact(db, dto.primary_contact, clientId);
      await db.query(`UPDATE clients SET contact_id = $1 WHERE client_id = $2`, [contactId, clientId]);
    }

    if (Array.isArray(dto.contacts) && dto.contacts.length) {
  const ids: string[] = [];
  for (const c of dto.contacts) {
    const id = await insertContact(db, c, clientId);
    ids.push(id);
  }
  // Si pas de primary_contact défini, on pointe sur le 1er de la liste
  if (!contactId && ids.length) {
    await db.query(`UPDATE clients SET contact_id = $1 WHERE client_id = $2`, [ids[0], clientId]);
  }
}

    await linkPaymentModes(db, clientId, dto.payment_mode_ids);

    await db.query('COMMIT');
    return { client_id: clientId };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

