import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import {
  enqueueAppNotificationCreated,
  enqueueEntityChanged,
} from "../../../shared/realtime/realtime-outbox.service";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { getDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { authoritativePdfFilename } from "../../../shared/authoritative-documents/authoritative-document.filename";
import { queueCreationPdfArchive } from "../../../shared/authoritative-documents/authoritative-document.service";
import {
  repoApplyCommandeWorkflowMilestone,
  repoEnsureCommandeWorkflowCheckpoints,
} from "./commande-client.repository";
import { canActOnCommandeWorkflowCheckpoint } from "../domain/commande-client-rbac";
import { normalizeCommandeWorkflowStatus } from "../workflow/commande-client-workflow.definition";
import type { AppNotification } from "../../notifications/types/notifications.types";
import type {
  CommandeArDraft,
  CommandeArRecipientSuggestion,
  CommandeArSendResult,
} from "../types/commande-ar.types";

type DbQueryer = Pick<PoolClient, "query">;

export async function repoListCommandeArIds(commandeId: number): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM public.commande_ar_log WHERE commande_id = $1::bigint ORDER BY generated_at DESC`, [commandeId]
  );
  return result.rows.map((row) => row.id);
}

/** Resolves an opaque archive id only when it belongs to this customer order. */
export async function repoResolveCommandeArOfficialArchive(commandeId: number, archiveId: string): Promise<string | null> {
  const result = await pool.query<{ ar_id: string }>(
    `SELECT ar.id::text AS ar_id
       FROM public.authoritative_pdf_archives a
       JOIN public.commande_ar_log ar ON ar.id::text = a.source_snapshot->>'acknowledgement_id'
      WHERE a.id = $1::uuid AND a.entity_type = 'commande-client' AND a.entity_id = $2::text
        AND a.document_kind = 'CUSTOMER_ORDER_ACKNOWLEDGEMENT' AND ar.commande_id = $2::bigint`,
    [archiveId, commandeId]
  );
  return result.rows[0]?.ar_id ?? null;
}

/** Finds the immutable order-scoped issuance corresponding to a legacy AR draft. */
export async function repoFindCommandeArOfficialArchiveId(commandeId: number, arId: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT a.id::text AS id
       FROM public.authoritative_pdf_archives a
       JOIN public.authoritative_pdf_archive_outbox o ON o.archive_id = a.id
      WHERE a.entity_type = 'commande-client' AND a.entity_id = $1::text
        AND a.document_kind = 'CUSTOMER_ORDER_ACKNOWLEDGEMENT'
        AND a.source_snapshot->>'acknowledgement_id' = $2::text
        AND o.status = 'ARCHIVED'
      ORDER BY a.document_version DESC
      LIMIT 1`,
    [commandeId, arId]
  );
  return result.rows[0]?.id ?? null;
}

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
  updated_at: string;
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
  recipient_emails: string[];
  email_provider_id: string | null;
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

type CommandeArCheckpointAccess = {
  status: string;
  responsible_role: string;
  assigned_user_id: number | null;
};

function assertCommandeArCheckpointAccess(params: {
  checkpoint: CommandeArCheckpointAccess;
  user_id: number;
  user_role: string | null | undefined;
}): void {
  if (!canActOnCommandeWorkflowCheckpoint({
    user_id: params.user_id,
    user_role: params.user_role,
    responsible_role: params.checkpoint.responsible_role,
    assigned_user_id: params.checkpoint.assigned_user_id,
  })) {
    throw new HttpError(403, "COMMAND_CHECKPOINT_FORBIDDEN", "Ce checkpoint est attribué à un autre rôle ou utilisateur.");
  }
}

export async function repoAuthorizeCommandeArGeneration(params: {
  tx: DbQueryer;
  commande_id: number;
  user_id: number;
  user_role: string | null | undefined;
}): Promise<void> {
  const access = await params.tx.query<{
    raw_statut: string | null;
    checkpoint_status: string | null;
    responsible_role: string | null;
    assigned_user_id: number | null;
  }>(
    `
      SELECT
        st.nouveau_statut AS raw_statut,
        cp.status AS checkpoint_status,
        cp.responsible_role,
        cp.assigned_user_id::int AS assigned_user_id
      FROM public.commande_client cc
      LEFT JOIN LATERAL (
        SELECT ch.nouveau_statut
        FROM public.commande_historique ch
        WHERE ch.commande_id = cc.id
        ORDER BY ch.date_action DESC, ch.id DESC
        LIMIT 1
      ) st ON TRUE
      LEFT JOIN public.commande_client_workflow_checkpoint cp
        ON cp.commande_id = cc.id AND cp.checkpoint_code = 'ar_sent'
      WHERE cc.id = $1::bigint
      LIMIT 1
    `,
    [params.commande_id]
  );
  const row = access.rows[0];
  if (!row) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");

  const currentStatus = row.raw_statut === null ? "BROUILLON" : normalizeCommandeWorkflowStatus(row.raw_statut);
  if (!currentStatus) {
    throw new HttpError(
      409,
      "COMMAND_STATUS_HISTORY_INVALID",
      `Le dernier statut enregistré (${row.raw_statut}) est inconnu. Réparez l'historique avant la génération de l'AR.`
    );
  }
  if (!row.checkpoint_status || !row.responsible_role) {
    throw new HttpError(409, "COMMAND_CHECKPOINT_MISSING", "Le checkpoint d'envoi de l'AR est absent.");
  }

  assertCommandeArCheckpointAccess({
    checkpoint: {
      status: row.checkpoint_status,
      responsible_role: row.responsible_role,
      assigned_user_id: row.assigned_user_id,
    },
    user_id: params.user_id,
    user_role: params.user_role,
  });

  if (currentStatus !== "AR_PRET" || row.checkpoint_status !== "active") {
    throw new HttpError(
      409,
      "COMMAND_AR_GENERATION_NOT_ALLOWED",
      "L'AR ne peut être généré que lorsque son checkpoint d'envoi est actif."
    );
  }
}

export async function repoLoadCommandeArGenerationData(tx: DbQueryer, commandeId: number): Promise<CommandeArGenerationData | null> {
  type HeaderRow = Omit<CommandeArHeader, "commande_id"> & { commande_id: number };
  const headerRes = await tx.query<HeaderRow>(
    `
      SELECT
        cc.id::int AS commande_id,
        cc.numero,
        CASE COALESCE(st.nouveau_statut, 'BROUILLON')
          WHEN 'ENREGISTREE' THEN 'EN_ANALYSE'
          WHEN 'PLANIFIEE' THEN 'PLANNING_VALIDE'
          WHEN 'AR_ENVOYEE' THEN 'AR_ENVOYE'
          WHEN 'LIVREE' THEN 'LIVRE'
          ELSE COALESCE(st.nouveau_statut, 'BROUILLON')
        END AS statut,
        cc.date_commande::text AS date_commande,
        cc.updated_at::text AS updated_at,
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
  user_role: string | null | undefined;
  document_name: string;
  pdf_buffer: Buffer;
  subject: string;
  body_text: string;
  recipient_suggestions: CommandeArRecipientSuggestion[];
  /** Required by the production generator; optional only for legacy repository callers/tests. */
  official_source_snapshot?: Record<string, unknown>;
  official_request_idempotency_key?: string;
  /** Expected `commande_client.updated_at` supplied by the authoritative collection POST. */
  official_expected_source_revision?: string | null;
  official_reissue_reason?: string | null;
}): Promise<CommandeArStoredDraft> {
  const client = await pool.connect();
  const documentId = crypto.randomUUID();
  const arId = crypto.randomUUID();
  const filePath = path.resolve(getDocumentStoragePath(), `${documentId}.pdf`);

  try {
    return await withRealtimeOutboxTransaction(client, async (tx) => {
    const exists = await tx.query<{ id: number; updated_at: string }>(
      `SELECT id::int AS id, updated_at::text AS updated_at
         FROM public.commande_client WHERE id = $1 FOR UPDATE`,
      [params.commande_id]
    );
    if (!exists.rows[0]?.id) {
      throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    }

    // The PDF was rendered outside this transaction. Revalidate the status,
    // active checkpoint and actor after acquiring the command lock so a send
    // that committed in the meantime cannot be followed by a stale draft.
    await repoAuthorizeCommandeArGeneration({
      tx,
      commande_id: params.commande_id,
      user_id: params.user_id,
      user_role: params.user_role,
    });

    if (params.official_request_idempotency_key) {
      const replay = await tx.query<{ ar_id: string | null }>(
        `SELECT source_snapshot->>'acknowledgement_id' AS ar_id
           FROM public.authoritative_pdf_archives
          WHERE idempotency_key = $1 AND entity_type = 'commande-client' AND entity_id = $2::text
            AND document_kind = 'CUSTOMER_ORDER_ACKNOWLEDGEMENT'`,
        [params.official_request_idempotency_key, params.commande_id]
      );
      if (replay.rows[0]?.ar_id) {
        const existing = await repoGetCommandeArDraft({ commande_id: params.commande_id, ar_id: replay.rows[0].ar_id, tx });
        if (existing) return existing;
        throw new HttpError(409, "ACKNOWLEDGEMENT_IDEMPOTENCY_CONFLICT", "La clé d'idempotence ne peut pas être rapprochée.");
      }
    }

    // The renderer ran before this transaction so it would otherwise be able
    // to freeze an order that changed just before the write lock was acquired.
    // Check after the idempotency replay branch: a legitimate network retry
    // must return the original immutable acknowledgement.
    if (
      params.official_expected_source_revision &&
      exists.rows[0]?.updated_at !== params.official_expected_source_revision
    ) {
      throw new HttpError(409, "OFFICIAL_DOCUMENT_SOURCE_REVISION_CONFLICT", "La source du document a changé. Rechargez avant de générer.");
    }

    if (params.official_request_idempotency_key) {
      const prior = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM public.authoritative_pdf_archives
          WHERE entity_type = 'commande-client' AND entity_id = $1::text
            AND document_kind = 'CUSTOMER_ORDER_ACKNOWLEDGEMENT'`,
        [params.commande_id]
      );
      if (Number(prior.rows[0]?.count ?? 0) > 0 && !params.official_reissue_reason?.trim()) {
        throw new HttpError(422, "OFFICIAL_DOCUMENT_REISSUE_REASON_REQUIRED", "Un motif de réémission est requis.");
      }
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.pdf_buffer);

    await tx.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`,
      [documentId, params.document_name, "PDF"]
    );

    await tx.query(
      `INSERT INTO public.commande_documents (commande_id, document_id, type) VALUES ($1, $2, $3)`,
      [params.commande_id, documentId, "AR"]
    );

    const ins = await tx.query<{
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
    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create AR draft");

    // The AR is an externally shared document. Queue an immutable source
    // snapshot with this same business transaction; the worker files its
    // official rendition in GED before any send path may attach it.
    let archivedSourceRevision: string | null = null;
    let documentVersion: number | null = null;
    if (params.official_source_snapshot) {
      // Updating the parent first makes the stored revision exactly the token
      // returned by the order API after this acknowledgement is created.
      const revisionResult = await tx.query<{ source_revision: string | null }>(
        `UPDATE public.commande_client
            SET updated_at = now()
          WHERE id = $1
        RETURNING updated_at::text AS source_revision`,
        [params.commande_id]
      );
      archivedSourceRevision = revisionResult.rows[0]?.source_revision?.trim() ?? null;
      if (!archivedSourceRevision) throw new HttpError(409, "OFFICIAL_DOCUMENT_SOURCE_REVISION_UNAVAILABLE", "La révision source du document est indisponible.");
      const versionResult = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM public.authoritative_pdf_archives
          WHERE entity_type = 'commande-client' AND entity_id = $1::text
            AND document_kind = 'CUSTOMER_ORDER_ACKNOWLEDGEMENT'`,
        [params.commande_id]
      );
      documentVersion = Number(versionResult.rows[0]?.count ?? 0) + 1;
      await queueCreationPdfArchive(tx, {
        entityType: "commande-client",
        entityId: String(params.commande_id),
        documentKind: "CUSTOMER_ORDER_ACKNOWLEDGEMENT",
        documentVersion,
        renderVersion: "customer-ar-pdf-v1",
        idempotencyKey: params.official_request_idempotency_key ?? `commande-client:${params.commande_id}:acknowledgement:${documentVersion}:${arId}`,
        title: `Accusé de réception ${params.document_name.replace(/\.pdf$/i, "")}`,
        originalName: authoritativePdfFilename(["AR", String(params.commande_id), `v${documentVersion}`]),
        sourceRevision: archivedSourceRevision,
        sourceSnapshot: { ...params.official_source_snapshot, acknowledgement_id: arId },
        actorUserId: params.user_id,
      });
    } else {
      await tx.query(`UPDATE public.commande_client SET updated_at = now() WHERE id = $1`, [params.commande_id]);
    }

    await insertCommandeEvent(tx, {
      commande_id: params.commande_id,
      event_type: "AR_GENERATED",
      new_values: {
        ar_id: arId,
        document_id: documentId,
        document_name: params.document_name,
        subject: params.subject,
        source_revision: archivedSourceRevision,
        document_version: documentVersion,
        reissue_reason: params.official_reissue_reason?.trim() ?? null,
      },
      user_id: params.user_id,
    });

    await enqueueEntityChanged(
      tx,
      {
        entityType: "COMMANDE_CLIENT",
        entityId: String(params.commande_id),
        action: "updated",
        module: "commandes-clients",
        at: row.generated_at,
        invalidateKeys: ["commandes:list", `commandes:detail:${params.commande_id}`],
      },
      { deduplicationKey: `commande-ar:${arId}:generated` }
    );
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
      recipient_emails: [],
      email_provider_id: null,
      preview_path: `/commandes/${params.commande_id}/documents/${documentId}/file`,
    };
    });
  } catch (err) {
    if (!(err instanceof HttpError && err.code === "REALTIME_COMMIT_OUTCOME_UNKNOWN")) {
      try {
        await fs.unlink(filePath);
      } catch {
        // ignore cleanup errors
      }
    }
    throw err;
  }
}

export async function repoGetCommandeArDraft(params: {
  commande_id: number;
  ar_id: string;
  tx?: DbQueryer;
  for_update?: boolean;
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
    recipient_emails: string[] | null;
    email_provider_id: string | null;
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
        ar.sent_at::text AS sent_at,
        ar.recipient_emails,
        ar.email_provider_id
      FROM public.commande_ar_log ar
      JOIN public.documents_clients dc ON dc.id = ar.document_id
      WHERE ar.commande_id = $1::bigint
        AND ar.id = $2::uuid
      LIMIT 1
      ${params.for_update ? "FOR UPDATE OF ar" : ""}
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
    recipient_emails: row.recipient_emails ?? [],
    email_provider_id: row.email_provider_id,
    preview_path: `/commandes/${row.commande_id}/documents/${row.document_id}/file`,
  };
}

export async function repoMarkCommandeArFailed(params: {
  commande_id: number;
  ar_id: string;
  error_message: string;
  claim?: CommandeArSendClaim;
}): Promise<void> {
  const markFailed = async (db: DbQueryer) => {
    await db.query(
      `
        UPDATE public.commande_ar_log
        SET status = 'FAILED', error_message = $3
        WHERE commande_id = $1::bigint
          AND id = $2::uuid
          AND status <> 'SENT'
      `,
      [params.commande_id, params.ar_id, params.error_message]
    );
  };
  if (!params.claim) {
    await markFailed(pool);
    return;
  }
  await withRealtimeOutboxTransaction(
    params.claim.client,
    markFailed,
    { transactionAlreadyStarted: true }
  );
}

export type CommandeArSendClaim = {
  kind: "claimed";
  client: PoolClient;
  draft: CommandeArStoredDraft;
};

export type CommandeArSendClaimResult =
  | CommandeArSendClaim
  | { kind: "replay"; draft: CommandeArStoredDraft };

export async function repoClaimCommandeArSend(params: {
  commande_id: number;
  ar_id: string;
  user_id: number;
  user_role: string | null | undefined;
}): Promise<CommandeArSendClaimResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const header = await client.query<{ raw_statut: string | null }>(
      `
        SELECT st.nouveau_statut AS raw_statut
        FROM public.commande_client cc
        LEFT JOIN LATERAL (
          SELECT ch.nouveau_statut
          FROM public.commande_historique ch
          WHERE ch.commande_id = cc.id
          ORDER BY ch.date_action DESC, ch.id DESC
          LIMIT 1
        ) st ON TRUE
        WHERE cc.id = $1::bigint
        FOR UPDATE OF cc
      `,
      [params.commande_id]
    );
    if (!header.rows[0]) {
      throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    }

    const draft = await repoGetCommandeArDraft({
      commande_id: params.commande_id,
      ar_id: params.ar_id,
      tx: client,
      for_update: true,
    });
    if (!draft) {
      throw new HttpError(404, "COMMANDE_AR_NOT_FOUND", "Accusé de réception introuvable");
    }
    if (!(new Set(["GENERATED", "FAILED", "SENT"])).has(draft.status)) {
      throw new HttpError(
        409,
        "COMMAND_AR_STATUS_INVALID",
        `Le statut technique de l'AR (${String(draft.status)}) ne permet pas son envoi.`
      );
    }

    const rawStatus = header.rows[0].raw_statut;
    const currentStatus = rawStatus === null ? "BROUILLON" : normalizeCommandeWorkflowStatus(rawStatus);
    if (!currentStatus) {
      throw new HttpError(
        409,
        "COMMAND_STATUS_HISTORY_INVALID",
        `Le dernier statut enregistré (${rawStatus}) est inconnu. Réparez l'historique avant l'envoi de l'AR.`
      );
    }
    await repoEnsureCommandeWorkflowCheckpoints(client, params.commande_id, currentStatus);
    const checkpoint = await client.query<{
      status: string;
      responsible_role: string;
      assigned_user_id: number | null;
    }>(
      `
        SELECT status, responsible_role, assigned_user_id::int AS assigned_user_id
        FROM public.commande_client_workflow_checkpoint
        WHERE commande_id = $1::bigint
          AND checkpoint_code = 'ar_sent'
        FOR UPDATE
      `,
      [params.commande_id]
    );
    const activeCheckpoint = checkpoint.rows[0];
    if (!activeCheckpoint) {
      throw new HttpError(
        409,
        "COMMAND_CHECKPOINT_MISSING",
        "Le checkpoint d'envoi de l'AR est absent. Rechargez le workflow de la commande."
      );
    }
    assertCommandeArCheckpointAccess({ checkpoint: activeCheckpoint, user_id: params.user_id, user_role: params.user_role });
    if (draft.status === "SENT") {
      return withRealtimeOutboxTransaction(
        client,
        async () => ({ kind: "replay" as const, draft }),
        { transactionAlreadyStarted: true }
      );
    }
    if (currentStatus !== "AR_PRET") {
      throw new HttpError(
        409,
        "COMMAND_AR_SEND_NOT_ALLOWED",
        `L'AR ne peut être envoyé que depuis le statut AR_PRET (statut courant: ${currentStatus}).`
      );
    }
    if (activeCheckpoint.status !== "active") {
      throw new HttpError(
        409,
        "COMMAND_CHECKPOINT_NOT_ACTIVE",
        "Le checkpoint d'envoi de l'AR n'est pas actif. Rechargez le workflow de la commande."
      );
    }

    // The open transaction and row locks are the send claim. A concurrent call
    // waits here and observes SENT after commit, so it never invokes the provider.
    return { kind: "claimed", client, draft };
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    throw err;
  }
}

export async function repoAbortCommandeArSendClaim(claim: CommandeArSendClaim): Promise<void> {
  try {
    await claim.client.query("ROLLBACK");
  } finally {
    claim.client.release();
  }
}

export async function repoFinalizeCommandeArSend(params: {
  claim: CommandeArSendClaim;
  commande_id: number;
  ar_id: string;
  sent_by: number;
  recipient_emails: string[];
  recipient_contact_ids: string[];
  email_provider_id: string | null;
  commentaire: string | null;
}): Promise<{ result: CommandeArSendResult; notifications: AppNotification[] }> {
  const client = params.claim.client;
  const draft = params.claim.draft;
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const updateRes = await tx.query<{ sent_at: string }>(
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
          AND status IN ('GENERATED', 'FAILED')
        RETURNING sent_at::text AS sent_at
      `,
      [params.ar_id, params.commande_id, params.recipient_emails, params.recipient_contact_ids, params.sent_by, params.email_provider_id]
    );
    if (!updateRes.rows[0]) {
      throw new HttpError(409, "COMMAND_AR_SEND_CLAIM_LOST", "La réservation d'envoi de l'AR n'est plus valide.");
    }

    const statusOut = await repoApplyCommandeWorkflowMilestone({
      tx,
      commande_id: params.commande_id,
      nouveau_statut: "AR_ENVOYE",
      cause: "ar_send",
      commentaire: params.commentaire,
      user_id: params.sent_by,
      completed_checkpoint_codes: ["ar_sent"],
      active_checkpoint_code: "production_launch",
    });

    await insertCommandeEvent(tx, {
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

    for (const notification of statusOut.notifications) {
      await enqueueAppNotificationCreated(
        tx,
        notification.user_id,
        notification,
        { deduplicationKey: `notification:${notification.id}` }
      );
    }
    const sentAt = updateRes.rows[0].sent_at;
    await enqueueEntityChanged(
      tx,
      {
        entityType: "COMMANDE_CLIENT",
        entityId: String(params.commande_id),
        action: "status_changed",
        module: "commandes-clients",
        at: sentAt,
        invalidateKeys: ["commandes:list", `commandes:detail:${params.commande_id}`],
      },
      { deduplicationKey: `commande-ar:${params.ar_id}:sent` }
    );

    return {
      result: {
        ar_id: draft.ar_id,
        commande_id: params.commande_id,
        document_id: draft.document_id,
        status: "AR_ENVOYE",
        sent_at: sentAt,
        recipient_emails: params.recipient_emails,
        email_provider_id: params.email_provider_id,
      },
      notifications: statusOut.notifications,
    };
  }, { transactionAlreadyStarted: true });
}
