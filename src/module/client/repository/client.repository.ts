// src/module/clients/repository/clients.repository.ts
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { CreateClientDTO } from "../validators/client.validators";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";

export type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type DbQueryer = Pick<PoolClient, "query">;

function isPgForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23503";
}

async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: {
    action: string;
    entity_type?: string | null;
    entity_id?: string | null;
    details?: Record<string, unknown> | null;
  }
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type ?? null,
    entity_id: entry.entity_id ?? null,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

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

  const normalizedBillerId =
    typeof dto.biller_id === "string" && dto.biller_id.trim() !== "" ? dto.biller_id : null;

  const q = `
  INSERT INTO clients (
    company_name, contact_id,
    email, phone, website_url,
    siret, vat_number, naf_code,
    status, blocked, reason, creation_date,
    biller_id,
    delivery_address_id, bill_address_id, bank_info_id,
    observations, provided_documents_id,
    quality_levels               
  ) VALUES (
    $1,$2,
    NULLIF($3,''), NULLIF($4,''), NULLIF($5,''),
    NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
    $9, $10, NULLIF($11,''), COALESCE($12::timestamp, now()),
    $13,
    $14, $15, $16,
    NULLIF($17,''), $18,
    COALESCE($19::text[], '{}')   
  )
  RETURNING client_id
`;


 const { rows } = await db.query(q, [
  dto.company_name, null,
  dto.email ?? "", dto.phone ?? "", dto.website_url ?? "",
  dto.siret ?? "", dto.vat_number ?? "", dto.naf_code ?? "",
  dto.status, dto.blocked, dto.reason ?? "", dto.creation_date,
  normalizedBillerId,
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

async function updateContact(
  db: any,
  contactId: string,
  c: NonNullable<CreateClientDTO["contacts"]>[number]
) {
  await db.query(
    `UPDATE contacts
        SET first_name     = $1,
            last_name      = $2,
            civility       = $3,
            role           = $4,
            phone_personal = $5,
            email          = $6
      WHERE contact_id = $7`,
    [
      c.first_name,
      c.last_name,
      c.civility ?? null,
      c.role ?? null,
      c.phone_personal ?? null,
      c.email,
      contactId,
    ]
  );
}

async function fetchExistingContacts(db: any, clientId: string) {
  const { rows } = await db.query(
    `SELECT contact_id
       FROM contacts
      WHERE client_id = $1`,
    [clientId]
  );
  return rows.map((r: any) => String(r.contact_id));
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



export async function repoCreateClient(dto: CreateClientDTO, audit: AuditContext): Promise<{ client_id: string }> {
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

    await insertAuditLog(db, audit, {
      action: "CLIENT_CREATE",
      entity_type: "client",
      entity_id: clientId,
      details: {
        client_id: clientId,
        company_name: dto.company_name,
        status: dto.status,
        blocked: dto.blocked,
        contacts_count: Array.isArray(dto.contacts) ? dto.contacts.length : 0,
        payment_modes_count: Array.isArray(dto.payment_mode_ids) ? dto.payment_mode_ids.length : 0,
      },
    });

    await db.query('COMMIT');
    return { client_id: clientId };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

// EDIT CLIENT 

export async function repoUpdateClient(id: string, dto: CreateClientDTO, audit: AuditContext): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    // 1) Verrouiller le client + récupérer IDs liés (+ contact_id existant)
    const current = await db.query(
      `SELECT client_id,
              blocked,
              bill_address_id,
              delivery_address_id,
              bank_info_id,
              contact_id AS primary_contact_id
         FROM clients
        WHERE client_id = $1
        FOR UPDATE`,
      [id]
    );

    if (current.rows.length === 0) {
      const err = new Error("Client not found");
      (err as any).status = 404;
      throw err;
    }

    const {
      bill_address_id,
      delivery_address_id,
      bank_info_id,
      primary_contact_id,
      blocked: blocked_before,
    } = current.rows[0] as {
      bill_address_id: string | null;
      delivery_address_id: string | null;
      bank_info_id: string | null;
      primary_contact_id: string | null;
      blocked: boolean | null;
    };

    const wasBlocked = Boolean(blocked_before);

    // 2) Mise à jour Adresse de facturation
    if (bill_address_id) {
      await db.query(
        `UPDATE adresse_facturation
            SET street       = $1,
                house_number = $2,
                postal_code  = $3,
                city         = $4,
                country      = $5,
                name         = $6
          WHERE bill_address_id = $7`,
        [
          dto.bill_address.street,
          dto.bill_address.house_number ?? null,
          dto.bill_address.postal_code,
          dto.bill_address.city,
          dto.bill_address.country,
          dto.bill_address.name,
          bill_address_id,
        ]
      );
    }

    // 3) Mise à jour Adresse de livraison
    if (delivery_address_id) {
      await db.query(
        `UPDATE adresse_livraison
            SET street       = $1,
                house_number = $2,
                postal_code  = $3,
                city         = $4,
                country      = $5,
                name         = $6
          WHERE delivery_address_id = $7`,
        [
          dto.delivery_address.street,
          dto.delivery_address.house_number ?? null,
          dto.delivery_address.postal_code,
          dto.delivery_address.city,
          dto.delivery_address.country,
          dto.delivery_address.name,
          delivery_address_id,
        ]
      );
    }

    // 4) Banque : upsert + rattachement au client
    const newBankInfoId = await upsertBank(db, dto.bank);
    if (!bank_info_id || bank_info_id !== newBankInfoId) {
      await db.query(
        `UPDATE clients SET bank_info_id = $1 WHERE client_id = $2`,
        [newBankInfoId, id]
      );
    }

    // 5) Normalisation provided_documents_id
    const normalizedProvidedDocsId =
      dto.provided_documents_id && dto.provided_documents_id.trim() !== ""
        ? dto.provided_documents_id
        : null;

    const normalizedBillerId =
      typeof dto.biller_id === "string" && dto.biller_id.trim() !== "" ? dto.biller_id : null;

    // 6) Mise à jour des champs principaux du client
    await db.query(
      `
      UPDATE clients
         SET company_name          = $1,
              email                 = NULLIF($2,''),
              phone                 = NULLIF($3,''),
              website_url           = NULLIF($4,''),
              siret                 = NULLIF($5,''),
              vat_number            = NULLIF($6,''),
              naf_code              = NULLIF($7,''),
              status                = $8,
              blocked               = $9,
              reason                = NULLIF($10,''),
              creation_date         = COALESCE($11::timestamp, creation_date),
              biller_id             = $12,
              observations          = NULLIF($13,''),
              provided_documents_id = $14,
              quality_levels        = COALESCE($15::text[], '{}')
       WHERE client_id = $16
      `,
      [
        dto.company_name,
        dto.email ?? "",
        dto.phone ?? "",
        dto.website_url ?? "",
        dto.siret ?? "",
        dto.vat_number ?? "",
        dto.naf_code ?? "",
        dto.status,
        dto.blocked,
        dto.reason ?? "",
        dto.creation_date,
        normalizedBillerId,
        dto.observations ?? "",
        normalizedProvidedDocsId,
        dto.quality_levels ?? [],
        id,
      ]
    );

    // 7) Contacts : upsert en gardant les contact_id

    // 7.1 Récupérer les contacts existants pour ce client
    const existingContactIds = await fetchExistingContacts(db, id); // string[]

    const payloadContacts = Array.isArray(dto.contacts) ? dto.contacts : [];

    const usedContactIds = new Set<string>();
    const newContactIds: string[] = [];

    // 7.2 Upsert de chaque contact du payload
    for (const c of payloadContacts) {
      const cid = (c as any).contact_id as string | undefined;

      if (cid && existingContactIds.includes(cid)) {
        // 🔁 UPDATE contact existant
        await updateContact(db, cid, c);
        usedContactIds.add(cid);
      } else {
        // 🆕 INSERT nouveau contact
        const newId = await insertContact(db, c, id);
        newContactIds.push(newId);
        usedContactIds.add(newId);
        (c as any).contact_id = newId; // utile si on veut s’y référer pour le primary_contact
      }
    }

    // 7.3 Supprimer les contacts qui ne sont plus dans le payload
    const toDelete = existingContactIds.filter((cid: string) => !usedContactIds.has(cid));
    if (toDelete.length) {
      await db.query(
        `DELETE FROM contacts WHERE client_id = $1 AND contact_id = ANY($2::uuid[])`,
        [id, toDelete]
      );
    }

    // 8) Primary contact

    let finalPrimaryContactId: string | null = primary_contact_id;

    if (dto.primary_contact) {
      const pc = dto.primary_contact as any;
      if (pc.contact_id && usedContactIds.has(pc.contact_id)) {
        // 👉 Primary = un contact existant (ou nouvellement lié) du client
        finalPrimaryContactId = pc.contact_id;
      } else {
        // pas d'id ou pas dans la liste → on crée/maj un contact dédié
        if (primary_contact_id) {
          // update l’existant
          await updateContact(db, primary_contact_id, dto.primary_contact);
          finalPrimaryContactId = primary_contact_id;
        } else {
          // create nouveau
          const newPrimaryId = await insertPrimaryContact(db, dto.primary_contact, id);
          finalPrimaryContactId = newPrimaryId;
        }
      }
    } else {
      // pas de primary_contact dans le payload :
      // si on a déjà des contacts utilisés, on peut en prendre un
      if (!finalPrimaryContactId && usedContactIds.size > 0) {
        finalPrimaryContactId = Array.from(usedContactIds)[0];
      }
    }

    await db.query(
      `UPDATE clients SET contact_id = $1 WHERE client_id = $2`,
      [finalPrimaryContactId, id]
    );

    // 9) Modes de règlement : reset + relink
    await db.query(`DELETE FROM client_payment_modes WHERE client_id = $1`, [id]);
    await linkPaymentModes(db, id, dto.payment_mode_ids);

    const contactsAdded = newContactIds.length;
    const contactsDeleted = toDelete.length;
    const paymentModesCount = Array.isArray(dto.payment_mode_ids) ? dto.payment_mode_ids.length : 0;

    await insertAuditLog(db, audit, {
      action: "CLIENT_UPDATE",
      entity_type: "client",
      entity_id: id,
      details: {
        client_id: id,
        company_name: dto.company_name,
        status: dto.status,
        blocked: dto.blocked,
        payment_modes_count: paymentModesCount,
        contacts_added: contactsAdded,
        contacts_deleted: contactsDeleted,
      },
    });

    if (wasBlocked !== dto.blocked) {
      await insertAuditLog(db, audit, {
        action: dto.blocked ? "CLIENT_BLOCK" : "CLIENT_UNBLOCK",
        entity_type: "client",
        entity_id: id,
        details: {
          from: wasBlocked,
          to: dto.blocked,
          reason: dto.reason ?? null,
        },
      });
    }

    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

export async function repoDeleteClient(id: string, audit: AuditContext): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const currentRes = await db.query<{ client_id: string; company_name: string }>(
      `
        SELECT client_id::text AS client_id,
               company_name
          FROM clients
         WHERE client_id = $1
         FOR UPDATE
      `,
      [id]
    );

    const current = currentRes.rows[0];
    if (!current) {
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client not found");
    }

    // Break FK from clients.contact_id -> contacts.contact_id before deleting contacts.
    await db.query(`UPDATE clients SET contact_id = NULL WHERE client_id = $1`, [id]);

    await db.query(`DELETE FROM client_payment_modes WHERE client_id = $1`, [id]);
    await db.query(`DELETE FROM contacts WHERE client_id = $1`, [id]);

    await db.query(`DELETE FROM clients WHERE client_id = $1`, [id]);

    await insertAuditLog(db, audit, {
      action: "CLIENT_DELETE",
      entity_type: "client",
      entity_id: id,
      details: {
        client_id: id,
        company_name: current.company_name,
      },
    });

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    if (isPgForeignKeyViolation(err)) {
      throw new HttpError(409, "CLIENT_IN_USE", "Client is referenced and cannot be deleted");
    }
    throw err;
  } finally {
    db.release();
  }
}



