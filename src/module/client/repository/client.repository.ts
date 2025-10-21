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
  client: any,
  id: string,
  dto: CreateClientDTO,
  billAddrId: string,
  delivAddrId: string,
  bankInfoId: string,
  contactId?: string | null
) {
  const q = `
    INSERT INTO clients (
      client_id, company_name, contact_id,
      email, phone, website_url,
      siret, vat_number, naf_code,
      status, blocked, reason, creation_date,
      delivery_address_id, bill_address_id, biller_id, bank_info_id,
      observations, provided_documents_id
    ) VALUES (
      $1,$2,$3,
      NULLIF($4,''), NULLIF($5,''), NULLIF($6,''),
      NULLIF($7,''), NULLIF($8,''), NULLIF($9,''),
      $10, $11, NULLIF($12,''), COALESCE($13::timestamp, now()),
      $14, $15, NULLIF($16,''), $17,
      NULLIF($18,''), NULLIF($19,'')
    )
  `;
  await client.query(q, [
    id, dto.company_name, contactId ?? null,
    dto.email ?? "", dto.phone ?? "", dto.website_url ?? "",
    dto.siret ?? "", dto.vat_number ?? "", dto.naf_code ?? "",
    dto.status, dto.blocked, dto.reason ?? "", dto.creation_date,
    delivAddrId, billAddrId, dto.biller_id ?? "", bankInfoId,
    dto.observations ?? "", dto.provided_documents_id ?? ""
  ]);
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

async function linkPaymentModes(client: any, clientId: string, ids: string[]) {
  if (!ids?.length) return;
  const values = ids.map((_, i) => `($1,$${i + 2})`).join(",");
  await client.query(
    `INSERT INTO client_payment_modes (client_id, payment_id)
     VALUES ${values}
     ON CONFLICT (client_id,payment_id) DO NOTHING`,
    [clientId, ...ids]
  );
}

export async function repoCreateClient(dto: CreateClientDTO): Promise<{ client_id: string }> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const clientId = await nextClientId(db);
    // 1) Préparer FK nécessaires
    const billAddrId = await insertAddressFacturation(db, dto.bill_address);
    const delivAddrId = await insertAddressLivraison(db, dto.delivery_address);
    const bankInfoId = await upsertBank(db, dto.bank);

    // 2) Insérer le client (contact_id = null pour l’instant)
    await insertClient(db, clientId, dto, billAddrId, delivAddrId, bankInfoId, null);

    // 3) Insérer le contact (si fourni) avec le client déjà existant
    let contactId: string | null = null;
    if (dto.primary_contact) {
      contactId = await insertPrimaryContact(db, dto.primary_contact, clientId);
      // 4) Répercuter sur le client
      await db.query(
        `UPDATE clients SET contact_id = $1 WHERE client_id = $2`,
        [contactId, clientId]
      );
    }

    // 5) Lier modes de règlement
    await linkPaymentModes(db, clientId, dto.payment_mode_ids);

    await db.query("COMMIT");
    return { client_id: clientId };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
