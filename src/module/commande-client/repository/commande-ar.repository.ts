import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoEnsureCommandeWorkflowStatus } from "./commande-client.repository";
import type { AppNotification } from "../../notifications/types/notifications.types";
import type {
  CommandeArDraft,
  CommandeArRecipientSuggestion,
  CommandeArSendResult,
} from "../types/commande-ar.types";

type DbQueryer = Pick<PoolClient, "query">;

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

type CommandeArHeader = {
  commande_id: number;
  numero: string;
  statut: string | null;
  date_commande: string;
  commentaire: string | null;
  total_ht: number;
  total_ttc: number;
  arc_edi: boolean;
  client_id: string | null;
  client_company_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  bill_name: string | null;
  bill_street: string | null;
  bill_house_number: string | null;
  bill_postal_code: string | null;
  bill_city: string | null;
  bill_country: string | null;
  deliv_name: string | null;
  deliv_street: string | null;
  deliv_house_number: string | null;
  deliv_postal_code: string | null;
  deliv_city: string | null;
  deliv_country: string | null;
};

type CommandeArLine = {
  id: number;
  designation: string;
  code_piece: string | null;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number;
  taux_tva: number | null;
  total_ttc: number;
};

type CommandeArContact = {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string | null;
  civility: string | null;
};

export type CommandeArGenerationData = {
  header: CommandeArHeader;
  lines: CommandeArLine[];
  contacts: CommandeArContact[];
};

export type CommandeArStoredDraft = {
  ar_id: string;
  commande_id: number;
  document_id: string;
  document_name: string;
  subject: string;
  body_text: string | null;
  generated_at: string;
  generated_by: number | null;
  status: "GENERATED" | "SENT" | "FAILED";
  sent_at: string | null;
  preview_path: string;
};

function cleanEmail(value: string | null | undefined): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length > 0 ? email : null;
}

function recipientKey(source: "CLIENT" | "CONTACT", email: string, contactId: string | null): string {
  return source === "CONTACT" && contactId ? `contact:${contactId}` : `${source.toLowerCase()}:${email}`;
}

export function buildCommandeArRecipientSuggestions(data: CommandeArGenerationData): CommandeArRecipientSuggestion[] {
  const out: CommandeArRecipientSuggestion[] = [];
  const seen = new Set<string>();

  const clientEmail = cleanEmail(data.header.client_email);
  if (clientEmail) {
    const key = recipientKey("CLIENT", clientEmail, null);
    seen.add(key);
    out.push({
      key,
      email: clientEmail,
      label: `${data.header.client_company_name ?? data.header.client_id ?? "Client"} — ${clientEmail}`,
      source: "CLIENT",
      contact_id: null,
      is_default: true,
    });
  }

  for (const contact of data.contacts) {
    const email = cleanEmail(contact.email);
    if (!email) continue;
    const key = recipientKey("CONTACT", email, contact.contact_id);
    if (seen.has(key)) continue;
    seen.add(key);

    const name = [contact.civility, contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
    out.push({
      key,
      email,
      label: `${name || "Contact"}${contact.role ? ` (${contact.role})` : ""} — ${email}`,
      source: "CONTACT",
      contact_id: contact.contact_id,
      is_default: out.length === 0,
    });
  }

  return out;
}

export async function repoLoadCommandeArGenerationData(tx: DbQueryer, commandeId: number): Promise<CommandeArGenerationData | null> {
  type HeaderRow = Omit<CommandeArHeader, "commande_id"> & { commande_id: number };
  const headerRes = await tx.query<HeaderRow>(
    `
      SELECT
        cc.id::int AS commande_id,
        cc.numero,
        COALESCE(st.nouveau_statut, 'ENREGISTREE') AS statut,
        cc.date_commande::text AS date_commande,
        cc.commentaire,
        cc.total_ht::float8 AS total_ht,
        cc.total_ttc::float8 AS total_ttc,
        cc.arc_edi,
        cc.client_id,
        c.company_name AS client_company_name,
        c.email AS client_email,
        c.phone AS client_phone,
        af.name AS bill_name,
        af.street AS bill_street,
        af.house_number AS bill_house_number,
        af.postal_code AS bill_postal_code,
        af.city AS bill_city,
        af.country AS bill_country,
        al.name AS deliv_name,
        al.street AS deliv_street,
        al.house_number AS deliv_house_number,
        al.postal_code AS deliv_postal_code,
        al.city AS deliv_city,
        al.country AS deliv_country
      FROM public.commande_client cc
      LEFT JOIN public.clients c ON c.client_id = cc.client_id
      LEFT JOIN public.adresse_facturation af ON af.bill_address_id = cc.adresse_facturation_id
      LEFT JOIN public.adresse_livraison al ON al.delivery_address_id = cc.destinataire_id
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM public.commande_historique ch
        WHERE ch.commande_id = cc.id
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) st ON TRUE
      WHERE cc.id = $1
      LIMIT 1
    `,
    [commandeId]
  );

  const header = headerRes.rows[0] ?? null;
  if (!header) return null;

  const linesRes = await tx.query<{
    id: number;
    designation: string;
    code_piece: string | null;
    quantite: number;
    unite: string | null;
    prix_unitaire_ht: number;
    taux_tva: number | null;
    total_ttc: number;
  }>(
    `
      SELECT
        cl.id::int AS id,
        cl.designation,
        cl.code_piece,
        cl.quantite::float8 AS quantite,
        cl.unite,
        cl.prix_unitaire_ht::float8 AS prix_unitaire_ht,
        cl.taux_tva::float8 AS taux_tva,
        cl.total_ttc::float8 AS total_ttc
      FROM public.commande_ligne cl
      WHERE cl.commande_id = $1
      ORDER BY cl.id ASC
    `,
    [commandeId]
  );

  const contactsRes = await tx.query<CommandeArContact>(
    `
      SELECT
        ct.contact_id::text AS contact_id,
        ct.first_name,
        ct.last_name,
        ct.email,
        ct.role,
        ct.civility
      FROM public.contacts ct
      WHERE ct.client_id = $1
      ORDER BY ct.last_name ASC, ct.first_name ASC, ct.contact_id ASC
    `,
    [header.client_id]
  );

  return {
    header,
    lines: linesRes.rows.map((row) => ({
      id: row.id,
      designation: row.designation,
      code_piece: row.code_piece,
      quantite: Number(row.quantite),
      unite: row.unite,
      prix_unitaire_ht: Number(row.prix_unitaire_ht),
      taux_tva: row.taux_tva === null ? null : Number(row.taux_tva),
      total_ttc: Number(row.total_ttc),
    })),
    contacts: contactsRes.rows,
  };
}

async function insertCommandeEvent(db: DbQueryer, params: {
  commande_id: number;
  event_type: string;
  old_values?: unknown | null;
  new_values?: unknown | null;
  user_id?: number | null;
}) {
  await db.query(
    `
      INSERT INTO public.commande_client_event_log (
        commande_id,
        event_type,
        old_values,
        new_values,
        user_id
      ) VALUES ($1,$2,$3,$4,$5)
    `,
    [
      params.commande_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.user_id ?? null,
    ]
  );
}

export async function repoCreateCommandeArDraft(params: {
  commande_id: number;
  user_id: number;
  document_name: string;
  pdf_buffer: Buffer;
  subject: string;
  body_text: string;
  recipient_suggestions: CommandeArRecipientSuggestion[];
}): Promise<CommandeArStoredDraft> {
  const client = await pool.connect();
  const documentId = crypto.randomUUID();
  const arId = crypto.randomUUID();
  const filePath = path.resolve("uploads/docs", `${documentId}.pdf`);

  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: number }>(
      `SELECT id::int AS id FROM public.commande_client WHERE id = $1 FOR UPDATE`,
      [params.commande_id]
    );
    if (!exists.rows[0]?.id) {
      throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.pdf_buffer);

    await client.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`,
      [documentId, params.document_name, "PDF"]
    );

    await client.query(
      `INSERT INTO public.commande_documents (commande_id, document_id, type) VALUES ($1, $2, $3)`,
      [params.commande_id, documentId, "AR"]
    );

    const ins = await client.query<{
      id: string;
      generated_at: string;
      generated_by: number | null;
      status: "GENERATED" | "SENT" | "FAILED";
      sent_at: string | null;
    }>(
      `
        INSERT INTO public.commande_ar_log (
          id,
          commande_id,
          document_id,
          status,
          subject,
          body_text,
          generated_by,
          payload
        )
        VALUES ($1::uuid, $2::bigint, $3::uuid, 'GENERATED', $4, $5, $6::int, $7::jsonb)
        RETURNING
          id::text AS id,
          generated_at::text AS generated_at,
          generated_by,
          status::text AS status,
          sent_at::text AS sent_at
      `,
      [
        arId,
        params.commande_id,
        documentId,
        params.subject,
        params.body_text,
        params.user_id,
        JSON.stringify({ recipient_suggestions: params.recipient_suggestions }),
      ]
    );

    await insertCommandeEvent(client, {
      commande_id: params.commande_id,
      event_type: "AR_GENERATED",
      new_values: {
        ar_id: arId,
        document_id: documentId,
        document_name: params.document_name,
        subject: params.subject,
      },
      user_id: params.user_id,
    });

    await client.query(`UPDATE public.commande_client SET updated_at = now() WHERE id = $1`, [params.commande_id]);
    await client.query("COMMIT");

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create AR draft");

    return {
      ar_id: row.id,
      commande_id: params.commande_id,
      document_id: documentId,
      document_name: params.document_name,
      subject: params.subject,
      body_text: params.body_text,
      generated_at: row.generated_at,
      generated_by: row.generated_by,
      status: row.status,
      sent_at: row.sent_at,
      preview_path: `/commandes/${params.commande_id}/documents/${documentId}/file`,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetCommandeArDraft(params: {
  commande_id: number;
  ar_id: string;
  tx?: DbQueryer;
}): Promise<CommandeArStoredDraft | null> {
  const db = params.tx ?? pool;
  const res = await db.query<{
    ar_id: string;
    commande_id: number;
    document_id: string;
    document_name: string;
    subject: string | null;
    body_text: string | null;
    generated_at: string;
    generated_by: number | null;
    status: "GENERATED" | "SENT" | "FAILED";
    sent_at: string | null;
  }>(
    `
      SELECT
        ar.id::text AS ar_id,
        ar.commande_id::int AS commande_id,
        ar.document_id::text AS document_id,
        dc.document_name,
        ar.subject,
        ar.body_text,
        ar.generated_at::text AS generated_at,
        ar.generated_by,
        ar.status::text AS status,
        ar.sent_at::text AS sent_at
      FROM public.commande_ar_log ar
      JOIN public.documents_clients dc ON dc.id = ar.document_id
      WHERE ar.commande_id = $1::bigint
        AND ar.id = $2::uuid
      LIMIT 1
    `,
    [params.commande_id, params.ar_id]
  );

  const row = res.rows[0] ?? null;
  if (!row) return null;

  return {
    ar_id: row.ar_id,
    commande_id: row.commande_id,
    document_id: row.document_id,
    document_name: row.document_name,
    subject: row.subject ?? "Accusé de réception",
    body_text: row.body_text,
    generated_at: row.generated_at,
    generated_by: row.generated_by,
    status: row.status,
    sent_at: row.sent_at,
    preview_path: `/commandes/${row.commande_id}/documents/${row.document_id}/file`,
  };
}

export async function repoMarkCommandeArFailed(params: {
  commande_id: number;
  ar_id: string;
  error_message: string;
}): Promise<void> {
  await pool.query(
    `
      UPDATE public.commande_ar_log
      SET status = 'FAILED', error_message = $3
      WHERE commande_id = $1::bigint
        AND id = $2::uuid
    `,
    [params.commande_id, params.ar_id, params.error_message]
  );
}

export async function repoFinalizeCommandeArSend(params: {
  commande_id: number;
  ar_id: string;
  sent_by: number;
  recipient_emails: string[];
  recipient_contact_ids: string[];
  email_provider_id: string | null;
  commentaire: string | null;
}): Promise<{ result: CommandeArSendResult; notifications: AppNotification[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const draft = await repoGetCommandeArDraft({ commande_id: params.commande_id, ar_id: params.ar_id, tx: client });
    if (!draft) {
      throw new HttpError(404, "COMMANDE_AR_NOT_FOUND", "Accusé de réception introuvable");
    }

    const updateRes = await client.query<{ sent_at: string }>(
      `
        UPDATE public.commande_ar_log
        SET
          status = 'SENT',
          recipient_emails = $3::text[],
          recipient_contact_ids = $4::uuid[],
          sent_at = now(),
          sent_by = $5::int,
          email_provider_id = $6,
          error_message = NULL
        WHERE id = $1::uuid
          AND commande_id = $2::bigint
        RETURNING sent_at::text AS sent_at
      `,
      [params.ar_id, params.commande_id, params.recipient_emails, params.recipient_contact_ids, params.sent_by, params.email_provider_id]
    );

    const statusOut = await repoEnsureCommandeWorkflowStatus({
      tx: client,
      commande_id: params.commande_id,
      nouveau_statut: "AR_ENVOYEE",
      commentaire: params.commentaire,
      user_id: params.sent_by,
    });

    await insertCommandeEvent(client, {
      commande_id: params.commande_id,
      event_type: "AR_SENT",
      new_values: {
        ar_id: params.ar_id,
        document_id: draft.document_id,
        recipient_emails: params.recipient_emails,
        email_provider_id: params.email_provider_id,
      },
      user_id: params.sent_by,
    });

    await client.query("COMMIT");

    return {
      result: {
        ar_id: draft.ar_id,
        commande_id: params.commande_id,
        document_id: draft.document_id,
        status: "AR_ENVOYEE",
        sent_at: updateRes.rows[0]?.sent_at ?? new Date().toISOString(),
        recipient_emails: params.recipient_emails,
        email_provider_id: params.email_provider_id,
      },
      notifications: statusOut.notifications,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
