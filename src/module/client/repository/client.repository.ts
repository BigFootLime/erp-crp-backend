// src/module/clients/repository/clients.repository.ts
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { CreateClientDTO, ClientPatchDTO } from "../validators/client.validators";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { generateClientCode } from "../../../shared/codes/code-generator.service";
import type { CreateClientContactInput, ClientContactRow } from "../services/client.service";
import type { DuplicateCheckDTO } from "../validators/client.validators";

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

const clientCodeExistsMessage = "Un client avec ce code existe déjà.";
const clientSiretExistsMessage = "Un client avec ce SIRET existe déjà.";

function getPgErrorInfo(err: unknown): { code: string | null; constraint: string | null } {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return {
    code: typeof e?.code === "string" ? e.code : null,
    constraint: typeof e?.constraint === "string" ? e.constraint : null,
  };
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

async function insertAddressFacturation(client: any, a: CreateClientDTO["bill_address"]) {
  const { rows } = await client.query(
    `INSERT INTO adresse_facturation (street,house_number,address_complement,postal_code,city,country,name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING bill_address_id`,
    [a.street, a.house_number ?? null, a.address_complement ?? null, a.postal_code, a.city, a.country, a.name]
  );
  return rows[0].bill_address_id as string;
}

/**
 * Duplicate guard on SIRET (14 digits = unique legal establishment id).
 * Application-level check inside the same transaction : legacy rows may hold
 * duplicates, so a DB unique index cannot be created yet (see patch verify
 * script). The race window left open is closed operationally by this check +
 * the audit trail; the unique index is the documented target once legacy data
 * is confirmed clean.
 */
async function ensureSiretAvailable(db: DbQueryer, siret: string | null | undefined, excludeClientId?: string) {
  const normalized = typeof siret === "string" ? siret.trim() : "";
  if (!normalized) return;

  const result = await db.query(
    `SELECT client_id::text AS client_id, company_name, client_code
       FROM clients
      WHERE siret = $1
      LIMIT 1`,
    [normalized]
  );
  const existing = (result.rows as Array<{ client_id: string; company_name: string; client_code: string | null }>)[0];
  if (existing && existing.client_id !== excludeClientId) {
    throw new HttpError(409, "CLIENT_SIRET_EXISTS", clientSiretExistsMessage, {
      client_id: existing.client_id,
      company_name: existing.company_name,
      client_code: existing.client_code,
    });
  }
}

async function insertAddressLivraison(client: any, a: CreateClientDTO["delivery_address"]) {
  const { rows } = await client.query(
    `INSERT INTO adresse_livraison (street,house_number,address_complement,postal_code,city,country,name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING delivery_address_id`,
    [a.street, a.house_number ?? null, a.address_complement ?? null, a.postal_code, a.city, a.country, a.name]
  );
  return rows[0].delivery_address_id as string;
}

async function upsertBank(client: any, bank: NonNullable<CreateClientDTO["bank"]>) {
  const { rows } = await client.query(
    `INSERT INTO informations_bancaires (iban,bic,name)
     VALUES ($1,$2,$3)
     ON CONFLICT (iban) DO UPDATE SET bic=EXCLUDED.bic, name=EXCLUDED.name
     RETURNING bank_info_id`,
    [bank.iban, bank.bic ?? null, bank.bank_name ?? null]
  );
  return rows[0].bank_info_id as string;
}

async function insertClient(
  db: any,
  dto: CreateClientDTO,
  billAddrId: string,
  delivAddrId: string,
  bankInfoId: string | null,
  clientCode: string
): Promise<string> {
  const normalizedProvidedDocsId =
    dto.provided_documents_id && dto.provided_documents_id.trim() !== ''
      ? dto.provided_documents_id
      : null;

  const normalizedBillerId =
    typeof dto.biller_id === "string" && dto.biller_id.trim() !== "" ? dto.biller_id : null;

  const q = `
  INSERT INTO clients (
    client_code,
    company_name, contact_id,
    email, phone, website_url,
    siret, vat_number, naf_code,
    status, blocked, reason, creation_date,
    biller_id,
     delivery_address_id, bill_address_id, bank_info_id,
    observations, provided_documents_id,
    quality_levels               
  ) VALUES (
    $1,$2,$3,
    NULLIF($4,''), NULLIF($5,''), NULLIF($6,''),
    NULLIF($7,''), NULLIF($8,''), NULLIF($9,''),
    $10, $11, NULLIF($12,''), COALESCE($13::timestamp, now()),
    $14,
    $15, $16, $17,
    NULLIF($18,''), $19,
    COALESCE($20::text[], '{}')   
  )
  RETURNING client_id
`;


 const { rows } = await db.query(q, [
  clientCode,
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

async function insertPrimaryContact(
  client: any,
  dto: NonNullable<CreateClientDTO["primary_contact"]>,
  clientId: string
) {
  const { rows } = await client.query(
    `INSERT INTO contacts (first_name,last_name,civility,role,phone_direct,phone_personal,email,client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING contact_id`,
    [
      dto.first_name,
      dto.last_name,
      dto.civility ?? null,
      dto.role ?? null,
      dto.phone_direct ?? null,
      dto.phone_personal ?? null,
      dto.email,
      clientId,
    ]
  );
  return rows[0].contact_id as string;
}

async function insertContact(db: any, c: NonNullable<CreateClientDTO["contacts"]>[number], clientId: string) {
  const { rows } = await db.query(
    `INSERT INTO contacts (first_name,last_name,civility,role,phone_direct,phone_personal,email,client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING contact_id`,
    [
      c.first_name,
      c.last_name,
      c.civility ?? null,
      c.role ?? null,
      c.phone_direct ?? null,
      c.phone_personal ?? null,
      c.email,
      clientId,
    ]
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
            phone_direct   = $5,
            phone_personal = $6,
            email          = $7
      WHERE contact_id = $8`,
    [
      c.first_name,
      c.last_name,
      c.civility ?? null,
      c.role ?? null,
      c.phone_direct ?? null,
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



export async function repoCreateClient(
  dto: CreateClientDTO,
  audit: AuditContext
): Promise<{ client_id: string; client_code: string }> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // Doublon légal : un même établissement (SIRET) ne peut pas donner deux fiches.
    await ensureSiretAvailable(db, dto.siret);

    // Code visible : exclusivement généré côté serveur, dans la transaction,
    // via la séquence non réutilisable de l'ADR-0013. Aucune valeur cliente
    // n'est acceptée (le contrôleur rejette toute tentative en amont).
    const clientCode = await generateClientCode(db);

    const billAddrId = await insertAddressFacturation(db, dto.bill_address);
    const delivAddrId = await insertAddressLivraison(db, dto.delivery_address);
    const bankInfoId = dto.bank ? await upsertBank(db, dto.bank) : null;

    // ✅ récupère l'ID généré par le trigger
    let clientId = "";
    try {
      clientId = await insertClient(db, dto, billAddrId, delivAddrId, bankInfoId, clientCode);
    } catch (err) {
      const { code, constraint } = getPgErrorInfo(err);
      if (code === "23505" && constraint === "clients_client_code_key") {
        throw new HttpError(409, "CLIENT_CODE_EXISTS", clientCodeExistsMessage);
      }
      throw err;
    }

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
        client_code: clientCode,
        company_name: dto.company_name,
        status: dto.status,
        blocked: dto.blocked,
        contacts_count: Array.isArray(dto.contacts) ? dto.contacts.length : 0,
        payment_modes_count: Array.isArray(dto.payment_mode_ids) ? dto.payment_mode_ids.length : 0,
      },
    });

    await db.query('COMMIT');
    return { client_id: clientId, client_code: clientCode };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

// EDIT CLIENT 

// PATCH partiel : ne met à jour QUE les champs réellement fournis. Un champ absent n'est
// jamais écrasé ni supprimé, et aucun contact existant n'est détruit par ce chemin.
// La liste des champs fournis (`fields`) vient du contrôleur (clés réellement présentes dans le body).
export async function repoPatchClient(
  id: string,
  patch: ClientPatchDTO,
  fields: ReadonlySet<string>,
  audit: AuditContext
): Promise<void> {
  const has = (k: string) => fields.has(k);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const current = await db.query(
      `SELECT client_id, bill_address_id, delivery_address_id, bank_info_id, contact_id AS primary_contact_id
         FROM clients WHERE client_id = $1 FOR UPDATE`,
      [id]
    );
    if (current.rows.length === 0) {
      const err = new Error("Client not found");
      (err as any).status = 404;
      throw err;
    }
    const { bill_address_id, delivery_address_id, bank_info_id, primary_contact_id } = current.rows[0] as {
      bill_address_id: string | null;
      delivery_address_id: string | null;
      bank_info_id: string | null;
      primary_contact_id: string | null;
    };

    // 1) Champs scalaires — SET dynamique, uniquement ceux fournis.
    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (sql: (ph: string) => string, value: unknown) => {
      vals.push(value);
      sets.push(sql(`$${vals.length}`));
    };
    if (has("company_name")) put((p) => `company_name = ${p}`, patch.company_name);
    if (has("email")) put((p) => `email = NULLIF(${p}, '')`, patch.email ?? "");
    if (has("phone")) put((p) => `phone = NULLIF(${p}, '')`, patch.phone ?? "");
    if (has("website_url")) put((p) => `website_url = NULLIF(${p}, '')`, patch.website_url ?? "");
    if (has("siret")) put((p) => `siret = NULLIF(${p}, '')`, patch.siret ?? "");
    if (has("vat_number")) put((p) => `vat_number = NULLIF(${p}, '')`, patch.vat_number ?? "");
    if (has("naf_code")) put((p) => `naf_code = NULLIF(${p}, '')`, patch.naf_code ?? "");
    if (has("status")) put((p) => `status = ${p}`, patch.status);
    if (has("blocked")) put((p) => `blocked = ${p}`, patch.blocked);
    if (has("reason")) put((p) => `reason = NULLIF(${p}, '')`, patch.reason ?? "");
    if (has("observations")) put((p) => `observations = NULLIF(${p}, '')`, patch.observations ?? "");
    if (has("biller_id")) {
      const biller = typeof patch.biller_id === "string" && patch.biller_id.trim() !== "" ? patch.biller_id : null;
      put((p) => `biller_id = ${p}`, biller);
    }
    if (has("provided_documents_id")) {
      const docs =
        typeof patch.provided_documents_id === "string" && patch.provided_documents_id.trim() !== ""
          ? patch.provided_documents_id
          : null;
      put((p) => `provided_documents_id = ${p}`, docs);
    }
    if (has("quality_levels")) put((p) => `quality_levels = ${p}::text[]`, patch.quality_levels ?? []);
    // client_code n'est jamais patchable : code visible immuable, généré serveur
    // (ADR-0013). Toute tentative est rejetée en amont par le contrôleur.

    if (has("siret")) {
      await ensureSiretAvailable(db, patch.siret, id);
    }

    if (sets.length > 0) {
      vals.push(id);
      try {
        await db.query(`UPDATE clients SET ${sets.join(", ")} WHERE client_id = $${vals.length}`, vals);
      } catch (err) {
        const { code, constraint } = getPgErrorInfo(err);
        if (code === "23505" && constraint === "clients_client_code_key") {
          throw new HttpError(409, "CLIENT_CODE_EXISTS", clientCodeExistsMessage);
        }
        throw err;
      }
    }

    // 2) Adresses — uniquement si fournies.
    if (has("bill_address") && patch.bill_address && bill_address_id) {
      const a = patch.bill_address;
      await db.query(
        `UPDATE adresse_facturation SET street=$1, house_number=$2, address_complement=$3, postal_code=$4, city=$5, country=$6, name=$7 WHERE bill_address_id=$8`,
        [a.street, a.house_number ?? null, a.address_complement ?? null, a.postal_code, a.city, a.country, a.name, bill_address_id]
      );
    }
    if (has("delivery_address") && patch.delivery_address && delivery_address_id) {
      const a = patch.delivery_address;
      await db.query(
        `UPDATE adresse_livraison SET street=$1, house_number=$2, address_complement=$3, postal_code=$4, city=$5, country=$6, name=$7 WHERE delivery_address_id=$8`,
        [a.street, a.house_number ?? null, a.address_complement ?? null, a.postal_code, a.city, a.country, a.name, delivery_address_id]
      );
    }

    // 3) Banque — uniquement si fournie.
    if (has("bank") && patch.bank) {
      const newBankInfoId = await upsertBank(db, patch.bank);
      if (!bank_info_id || bank_info_id !== newBankInfoId) {
        await db.query(`UPDATE clients SET bank_info_id = $1 WHERE client_id = $2`, [newBankInfoId, id]);
      }
    }

    // 4) Modes de règlement — uniquement si fournis (remplacement contrôlé).
    if (has("payment_mode_ids")) {
      await db.query(`DELETE FROM client_payment_modes WHERE client_id = $1`, [id]);
      for (const pid of patch.payment_mode_ids ?? []) {
        await db.query(
          `INSERT INTO client_payment_modes (client_id, payment_id) VALUES ($1,$2) ON CONFLICT (client_id,payment_id) DO NOTHING`,
          [id, pid]
        );
      }
    }

    // 5) Contacts — uniquement si fournis : upsert SANS supprimer les absents.
    if (has("contacts") && Array.isArray(patch.contacts) && patch.contacts.length > 0) {
      const existing = await fetchExistingContacts(db, id);
      for (const c of patch.contacts) {
        const cid = (c as { contact_id?: string }).contact_id;
        if (cid && existing.includes(cid)) await updateContact(db, cid, c);
        else await insertContact(db, c, id);
      }
    }

    // 6) Contact principal — uniquement si fourni.
    if (has("primary_contact") && patch.primary_contact) {
      if (primary_contact_id) {
        await updateContact(db, primary_contact_id, patch.primary_contact);
      } else {
        const newId = await insertPrimaryContact(db, patch.primary_contact, id);
        await db.query(`UPDATE clients SET contact_id = $1 WHERE client_id = $2`, [newId, id]);
      }
    }

    await insertAuditLog(db, audit, {
      action: "CLIENT_PATCH",
      entity_type: "client",
      entity_id: id,
      details: { fields: Array.from(fields) },
    });

    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

/**
 * « Suppression » d'un client = archivage logique (#162).
 * Aucune destruction physique : le client, ses contacts et ses modes de paiement
 * sont conservés pour la traçabilité industrielle et les obligations RGPD de
 * rétention contrôlée. Le client passe en status 'inactif' + blocked, et la
 * demande de suppression est auditée comme telle.
 */
export async function repoDeleteClient(id: string, audit: AuditContext): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const currentRes = await db.query<{ client_id: string; company_name: string; status: string }>(
      `
        SELECT client_id::text AS client_id,
               company_name,
               status::text AS status
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

    await db.query(`UPDATE clients SET status = 'inactif', blocked = true WHERE client_id = $1`, [id]);

    await insertAuditLog(db, audit, {
      action: "CLIENT_DELETE",
      entity_type: "client",
      entity_id: id,
      details: {
        client_id: id,
        company_name: current.company_name,
        mode: "logical_archive",
        from_status: current.status,
        to_status: "inactif",
      },
    });

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function repoArchiveClient(id: string, audit: AuditContext): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const beforeRes = await db.query<{ client_id: string; company_name: string; status: string }>(
      `
        SELECT client_id::text AS client_id,
               company_name,
               status::text AS status
          FROM clients
         WHERE client_id = $1
         FOR UPDATE
      `,
      [id]
    );
    const before = beforeRes.rows[0];
    if (!before) {
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client not found");
    }

    if (String(before.status).toLowerCase() !== "inactif") {
      await db.query(`UPDATE clients SET status = 'inactif' WHERE client_id = $1`, [id]);
    }

    await insertAuditLog(db, audit, {
      action: "CLIENT_ARCHIVE",
      entity_type: "client",
      entity_id: id,
      details: {
        client_id: id,
        company_name: before.company_name,
        from_status: before.status,
        to_status: "inactif",
      },
    });

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}




/**
 * Contact principal : le contact doit appartenir au client ciblé, et la
 * bascule (vérification + affectation + audit) se fait sous transaction avec
 * verrou FOR UPDATE — un contact d'un autre client ne peut jamais devenir
 * principal (#162, constat P0-3).
 */
export async function repoSetPrimaryContact(
  clientId: string,
  contactId: string,
  audit: AuditContext
): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const clientRes = await db.query<{ contact_id: string | null }>(
      `SELECT contact_id FROM clients WHERE client_id = $1 FOR UPDATE`,
      [clientId]
    );
    if (clientRes.rows.length === 0) {
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client not found");
    }
    const previousContactId = clientRes.rows[0]?.contact_id ?? null;

    const ownership = await db.query(
      `SELECT 1 FROM contacts WHERE contact_id = $1 AND client_id = $2 LIMIT 1`,
      [contactId, clientId]
    );
    if (ownership.rows.length === 0) {
      throw new HttpError(
        422,
        "CONTACT_NOT_OF_CLIENT",
        "Ce contact n'appartient pas à ce client."
      );
    }

    await db.query(`UPDATE clients SET contact_id = $1 WHERE client_id = $2`, [contactId, clientId]);

    await insertAuditLog(db, audit, {
      action: "CLIENT_PRIMARY_CONTACT_SET",
      entity_type: "client",
      entity_id: clientId,
      details: { contact_id: contactId, previous_contact_id: previousContactId },
    });

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/**
 * Création d'un contact + éventuelle promotion en principal, sous une seule
 * transaction (l'ancien chemin service faisait deux requêtes séparées hors
 * transaction : un échec de la seconde laissait un état incohérent).
 */
export async function repoCreateClientContact(
  clientId: string,
  input: CreateClientContactInput,
  audit: AuditContext
): Promise<ClientContactRow> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const clientRes = await db.query(
      `SELECT 1 FROM clients WHERE client_id = $1 FOR UPDATE`,
      [clientId]
    );
    if (clientRes.rows.length === 0) {
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client not found");
    }

    const { rows } = await db.query(
      `
      INSERT INTO contacts (first_name,last_name,civility,role,phone_direct,phone_personal,email,client_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING
        contact_id::text AS contact_id,
        first_name,
        last_name,
        email,
        phone_direct,
        phone_personal,
        role,
        civility
      `,
      [
        input.first_name,
        input.last_name,
        input.civility ?? null,
        input.role ?? null,
        input.phone_direct ?? null,
        input.phone_personal ?? null,
        input.email,
        clientId,
      ]
    );
    const row = rows[0] as Omit<ClientContactRow, "label">;

    if (input.set_primary) {
      await db.query(`UPDATE clients SET contact_id = $1 WHERE client_id = $2`, [row.contact_id, clientId]);
    }

    await insertAuditLog(db, audit, {
      action: "CLIENT_CONTACT_CREATE",
      entity_type: "client",
      entity_id: clientId,
      details: { contact_id: row.contact_id, set_primary: Boolean(input.set_primary) },
    });

    await db.query("COMMIT");
    return { ...row, label: `${row.first_name} ${row.last_name} — ${row.email}` };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/**
 * Recherche de doublons candidats (SIRET exact, TVA exacte, raison sociale
 * insensible à la casse). Lecture seule, réponse minimisée : identité et
 * critères correspondants uniquement — jamais de coordonnées ni de PII.
 */
export async function repoCheckDuplicates(criteria: DuplicateCheckDTO): Promise<
  Array<{
    client_id: string;
    client_code: string | null;
    company_name: string;
    status: string;
    matched_on: string[];
  }>
> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const push = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (criteria.siret) conditions.push(`c.siret = ${push(criteria.siret)}`);
  if (criteria.vat_number) conditions.push(`UPPER(c.vat_number) = UPPER(${push(criteria.vat_number)})`);
  if (criteria.company_name) conditions.push(`LOWER(c.company_name) = LOWER(${push(criteria.company_name)})`);
  if (conditions.length === 0) return [];

  let excludeSql = "";
  if (criteria.exclude_client_id) {
    excludeSql = ` AND c.client_id::text <> ${push(criteria.exclude_client_id)}`;
  }

  const { rows } = await pool.query(
    `
    SELECT
      c.client_id::text AS client_id,
      COALESCE(
        NULLIF(btrim(to_jsonb(c)->>'client_code'), ''),
        NULLIF(btrim(to_jsonb(c)->>'code_client'), '')
      ) AS client_code,
      c.company_name,
      c.status::text AS status,
      c.siret,
      c.vat_number
    FROM clients c
    WHERE (${conditions.join(" OR ")})${excludeSql}
    ORDER BY c.company_name ASC
    LIMIT 10
    `,
    params
  );

  return (rows as Array<{
    client_id: string;
    client_code: string | null;
    company_name: string;
    status: string;
    siret: string | null;
    vat_number: string | null;
  }>).map((r) => {
    const matched: string[] = [];
    if (criteria.siret && r.siret === criteria.siret) matched.push("siret");
    if (criteria.vat_number && (r.vat_number ?? "").toUpperCase() === criteria.vat_number.toUpperCase()) {
      matched.push("vat_number");
    }
    if (criteria.company_name && r.company_name.toLowerCase() === criteria.company_name.toLowerCase()) {
      matched.push("company_name");
    }
    return {
      client_id: r.client_id,
      client_code: r.client_code,
      company_name: r.company_name,
      status: r.status,
      matched_on: matched,
    };
  });
}
