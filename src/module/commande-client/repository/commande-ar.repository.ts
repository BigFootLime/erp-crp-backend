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
  repoEnsureCommandeWorkflowStatus,
} from "./commande-client.repository";
import { canActOnCommandeWorkflowCheckpoint } from "../domain/commande-client-rbac";
import { buildCommandeArContentSnapshot, isCommandeArSnapshotCurrent } from "../domain/commande-ar-fingerprint";
import { normalizeCommandeWorkflowStatus } from "../workflow/commande-client-workflow.definition";
import type { AppNotification } from "../../notifications/types/notifications.types";
import type {
  CommandeArDraft,
  CommandeArRecipientSuggestion,
  CommandeArSendResult,
} from "../types/commande-ar.types";

type DbQueryer = Pick<PoolClient, "query">;

export function formatCommandeArReference(seriesNumber: number, versionNumber: number): string {
  return `AR-${String(seriesNumber).padStart(8, "0")}-v${versionNumber}`;
}

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
  customer_reference: string | null;
  selected_contact_id: string | null;
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
  delai_client: string | null;
  delai_interne: string | null;
};

export type CommandeArAllocation = {
  id: string;
  commande_ligne_id: number;
  livraison_affaire_id: string;
  production_affaire_id: string | null;
  qty_ordered: number;
  qty_from_stock: number;
  qty_reserved: number;
  qty_to_produce: number;
  allocation_mode: string | null;
  updated_at: string | null;
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
  allocations: CommandeArAllocation[];
  contacts: CommandeArContact[];
};

export type CommandeArStoredDraft = {
  ar_id: string;
  commande_id: number;
  document_id: string;
  document_name: string;
  reference: string;
  series_number: number;
  version_number: number;
  subject: string;
  body_text: string | null;
  generated_at: string;
  generated_by: number | null;
  status: "GENERATED" | "SENDING" | "SENT" | "FAILED";
  sent_at: string | null;
  send_started_at: string | null;
  recipient_emails: string[];
  recipient_contact_ids: string[];
  email_provider_id: string | null;
  content_fingerprint: string | null;
  content_snapshot: unknown | null;
  pdf_sha256: string | null;
  send_idempotency_key: string | null;
  send_payload_fingerprint: string | null;
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
  const seenEmails = new Set<string>();
  const selectedContactId = data.header.selected_contact_id;
  const push = (suggestion: CommandeArRecipientSuggestion) => {
    const normalizedEmail = suggestion.email.toLowerCase();
    if (seenEmails.has(normalizedEmail)) return;
    seenEmails.add(normalizedEmail);
    out.push(suggestion);
  };

  const orderedContacts = [...data.contacts].sort((left, right) => {
    const leftSelected = left.contact_id === selectedContactId ? 1 : 0;
    const rightSelected = right.contact_id === selectedContactId ? 1 : 0;
    return rightSelected - leftSelected;
  });
  for (const contact of orderedContacts) {
    const email = cleanEmail(contact.email);
    if (!email) continue;
    const key = recipientKey("CONTACT", email, contact.contact_id);
    const name = [contact.civility, contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
    push({
      key,
      email,
      label: `${name || "Contact"}${contact.role ? ` (${contact.role})` : ""} — ${email}`,
      source: "CONTACT",
      contact_id: contact.contact_id,
      contact_name: name || null,
      is_default: contact.contact_id === selectedContactId,
    });
  }

  const clientEmail = cleanEmail(data.header.client_email);
  if (clientEmail) {
    push({
      key: recipientKey("CLIENT", clientEmail, null),
      email: clientEmail,
      label: `${data.header.client_company_name ?? data.header.client_id ?? "Client"} — ${clientEmail}`,
      source: "CLIENT",
      contact_id: null,
      contact_name: null,
      is_default: !out.some((item) => item.is_default),
    });
  }
  if (!out.some((item) => item.is_default) && out[0]) out[0].is_default = true;

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
        cc.code_client AS customer_reference,
        cc.contact_id::text AS selected_contact_id,
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
    delai_client: string | null;
    delai_interne: string | null;
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
        ,cl.delai_client::text AS delai_client
        ,cl.delai_interne::text AS delai_interne
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

  const allocationsRes = await tx.query<CommandeArAllocation>(
    `
      SELECT cla.id::text AS id,
        cla.commande_ligne_id::int AS commande_ligne_id,
        cla.livraison_affaire_id::text AS livraison_affaire_id,
        cla.production_affaire_id::text AS production_affaire_id,
        cla.qty_ordered::float8 AS qty_ordered,
        cla.qty_from_stock::float8 AS qty_from_stock,
        cla.qty_reserved::float8 AS qty_reserved,
        cla.qty_to_produce::float8 AS qty_to_produce,
        cla.allocation_mode,
        cla.updated_at::text AS updated_at
      FROM public.commande_ligne_affaire_allocation cla
      WHERE cla.commande_id = $1
      ORDER BY cla.commande_ligne_id ASC, cla.livraison_affaire_id ASC, cla.id ASC
    `,
    [commandeId]
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
      delai_client: row.delai_client,
      delai_interne: row.delai_interne,
    })),
    allocations: allocationsRes.rows.map((row) => ({
      ...row,
      commande_ligne_id: toInt(row.commande_ligne_id, "allocation.commande_ligne_id"),
      qty_ordered: Number(row.qty_ordered),
      qty_from_stock: Number(row.qty_from_stock),
      qty_reserved: Number(row.qty_reserved),
      qty_to_produce: Number(row.qty_to_produce),
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
  pdf_factory?: (version: { reference: string; series_number: number; version_number: number }) => Promise<Buffer>;
  content_fingerprint?: string | null;
  content_snapshot?: unknown;
  force_new_version?: boolean;
  subject: string;
  body_text: string;
  subject_factory?: (version: { reference: string; series_number: number; version_number: number }) => string;
  body_text_factory?: (version: { reference: string; series_number: number; version_number: number }) => string;
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

    if (params.content_fingerprint && !params.force_new_version) {
      const reusable = await repoFindReusableCommandeArDraft({
        tx,
        commande_id: params.commande_id,
        content_fingerprint: params.content_fingerprint,
      });
      if (reusable) return reusable;
    }

    const version = await repoReserveCommandeArVersion({ tx, commande_id: params.commande_id });
    const documentName = `${version.reference}.pdf`;
    const pdfBuffer = params.pdf_factory ? await params.pdf_factory(version) : params.pdf_buffer;
    const pdfSha256 = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
    const subject = params.subject_factory ? params.subject_factory(version) : params.subject;
    const bodyText = params.body_text_factory ? params.body_text_factory(version) : params.body_text;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, pdfBuffer);

    await tx.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`,
      [documentId, documentName, "PDF"]
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
          ar_series_number,
          version_number,
          ar_reference,
          status,
          subject,
          body_text,
          generated_by,
          content_fingerprint,
          content_snapshot,
          pdf_sha256,
          payload
        )
        VALUES ($1::uuid, $2::bigint, $3::uuid, $4::bigint, $5::int, $6, 'GENERATED', $7, $8, $9::int, $10, $11::jsonb, $12, $13::jsonb)
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
        version.series_number,
        version.version_number,
        version.reference,
        subject,
        bodyText,
        params.user_id,
        params.content_fingerprint ?? null,
        JSON.stringify(params.content_snapshot ?? null),
        pdfSha256,
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
      // AR generation freezes the current business source; it must not mutate
      // the parent order and make its own fingerprint immediately obsolete.
      archivedSourceRevision = exists.rows[0].updated_at?.trim() ?? null;
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
        title: `Accusé de réception ${version.reference}`,
        originalName: authoritativePdfFilename([version.reference]),
        sourceRevision: archivedSourceRevision,
        sourceSnapshot: {
          ...params.official_source_snapshot,
          acknowledgement_id: arId,
          acknowledgement_number: version.reference,
        },
        // The reviewed working PDF is the legal issuance. Filing these exact
        // bytes prevents the background worker from rendering a subtly
        // different document (timestamps, customer reference, PDF metadata)
        // and guarantees that preview, GED archive and email attachment match.
        exactPdfBytes: pdfBuffer,
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
        document_name: documentName,
        reference: version.reference,
        series_number: version.series_number,
        version_number: version.version_number,
        subject,
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
      document_name: documentName,
      reference: version.reference,
      series_number: version.series_number,
      version_number: version.version_number,
      subject,
      body_text: bodyText,
      generated_at: row.generated_at,
      generated_by: row.generated_by,
      status: row.status,
      sent_at: row.sent_at,
      send_started_at: null,
      recipient_emails: [],
      recipient_contact_ids: [],
      email_provider_id: null,
      content_fingerprint: params.content_fingerprint ?? null,
      content_snapshot: params.content_snapshot ?? null,
      pdf_sha256: pdfSha256,
      send_idempotency_key: null,
      send_payload_fingerprint: null,
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
    reference: string;
    series_number: number;
    version_number: number;
    subject: string | null;
    body_text: string | null;
    generated_at: string;
    generated_by: number | null;
    status: "GENERATED" | "SENDING" | "SENT" | "FAILED";
    sent_at: string | null;
    send_started_at: string | null;
    recipient_emails: string[] | null;
    recipient_contact_ids: string[] | null;
    email_provider_id: string | null;
    content_fingerprint: string | null;
    content_snapshot: unknown | null;
    pdf_sha256: string | null;
    send_idempotency_key: string | null;
    send_payload_fingerprint: string | null;
  }>(
    `
      SELECT
        ar.id::text AS ar_id,
        ar.commande_id::int AS commande_id,
        ar.document_id::text AS document_id,
        dc.document_name,
        ar.ar_reference AS reference,
        ar.ar_series_number::int AS series_number,
        ar.version_number::int AS version_number,
        ar.subject,
        ar.body_text,
        ar.generated_at::text AS generated_at,
        ar.generated_by,
        ar.status::text AS status,
        ar.sent_at::text AS sent_at,
        ar.send_started_at::text AS send_started_at,
        ar.recipient_emails,
        ar.recipient_contact_ids::text[] AS recipient_contact_ids,
        ar.email_provider_id,
        ar.content_fingerprint,
        ar.content_snapshot,
        ar.pdf_sha256,
        ar.send_idempotency_key,
        ar.send_payload_fingerprint
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
    reference: row.reference,
    series_number: toInt(row.series_number, "ar_series_number"),
    version_number: toInt(row.version_number, "version_number"),
    subject: row.subject ?? "Accusé de réception",
    body_text: row.body_text,
    generated_at: row.generated_at,
    generated_by: row.generated_by,
    status: row.status,
    sent_at: row.sent_at,
    send_started_at: row.send_started_at,
    recipient_emails: row.recipient_emails ?? [],
    recipient_contact_ids: row.recipient_contact_ids ?? [],
    email_provider_id: row.email_provider_id,
    content_fingerprint: row.content_fingerprint,
    content_snapshot: row.content_snapshot,
    pdf_sha256: row.pdf_sha256,
    send_idempotency_key: row.send_idempotency_key,
    send_payload_fingerprint: row.send_payload_fingerprint,
    preview_path: `/commandes/${row.commande_id}/documents/${row.document_id}/file`,
  };
}

async function repoAuthorizeCommandeArReplay(params: {
  tx: DbQueryer;
  commande_id: number;
  user_id: number;
  user_role?: string | null;
}): Promise<void> {
  const access = await params.tx.query<{
    status: string;
    responsible_role: string;
    assigned_user_id: number | null;
  }>(
    `
      SELECT cp.status, cp.responsible_role, cp.assigned_user_id::int AS assigned_user_id
      FROM public.commande_client cc
      JOIN public.commande_client_workflow_checkpoint cp
        ON cp.commande_id = cc.id AND cp.checkpoint_code = 'ar_sent'
      WHERE cc.id = $1::bigint
      LIMIT 1
    `,
    [params.commande_id]
  );
  const checkpoint = access.rows[0];
  if (!checkpoint) throw new HttpError(409, "COMMAND_CHECKPOINT_MISSING", "Le checkpoint d'envoi de l'AR est absent.");
  assertCommandeArCheckpointAccess({ checkpoint, user_id: params.user_id, user_role: params.user_role });
}

export async function repoListCommandeArDrafts(params: {
  commande_id: number;
  tx?: DbQueryer;
}): Promise<CommandeArStoredDraft[]> {
  const db = params.tx ?? pool;
  const ids = await db.query<{ ar_id: string }>(
    `SELECT id::text AS ar_id FROM public.commande_ar_log WHERE commande_id = $1::bigint ORDER BY version_number DESC, generated_at DESC, id DESC`,
    [params.commande_id]
  );
  const drafts = await Promise.all(ids.rows.map((row) => repoGetCommandeArDraft({
    commande_id: params.commande_id,
    ar_id: row.ar_id,
    tx: db,
  })));
  return drafts.filter((draft): draft is CommandeArStoredDraft => draft !== null);
}

export async function repoFindReusableCommandeArDraft(params: {
  tx: DbQueryer;
  commande_id: number;
  content_fingerprint: string;
}): Promise<CommandeArStoredDraft | null> {
  const result = await params.tx.query<{ ar_id: string }>(
    `
      SELECT ar.id::text AS ar_id
      FROM public.commande_ar_log ar
      WHERE ar.commande_id = $1::bigint
        AND ar.status IN ('GENERATED', 'FAILED')
        AND ar.content_fingerprint = $2
      ORDER BY ar.version_number DESC
      LIMIT 1
      FOR UPDATE OF ar
    `,
    [params.commande_id, params.content_fingerprint]
  );
  const arId = result.rows[0]?.ar_id;
  return arId ? repoGetCommandeArDraft({ commande_id: params.commande_id, ar_id: arId, tx: params.tx }) : null;
}

export async function repoReserveCommandeArVersion(params: {
  tx: DbQueryer;
  commande_id: number;
}): Promise<{ series_number: number; version_number: number; reference: string }> {
  const current = await params.tx.query<{ series_number: number; next_version_number: number }>(
    `
      SELECT series_number::int AS series_number, next_version_number::int AS next_version_number
      FROM public.commande_ar_series
      WHERE commande_id = $1::bigint
      FOR UPDATE
    `,
    [params.commande_id]
  );
  let series = current.rows[0] ?? null;
  if (!series) {
    const inserted = await params.tx.query<{ series_number: number; next_version_number: number }>(
      `
        INSERT INTO public.commande_ar_series (commande_id, series_number, next_version_number)
        VALUES ($1::bigint, nextval('public.commande_ar_series_no_seq'), 1)
        ON CONFLICT (commande_id) DO NOTHING
        RETURNING series_number::int AS series_number, next_version_number::int AS next_version_number
      `,
      [params.commande_id]
    );
    series = inserted.rows[0] ?? null;
    if (!series) {
      const concurrent = await params.tx.query<{ series_number: number; next_version_number: number }>(
        `SELECT series_number::int AS series_number, next_version_number::int AS next_version_number FROM public.commande_ar_series WHERE commande_id = $1::bigint FOR UPDATE`,
        [params.commande_id]
      );
      series = concurrent.rows[0] ?? null;
    }
  }
  if (!series) throw new Error("Unable to allocate an AR series");
  const seriesNumber = toInt(series.series_number, "series_number");
  const versionNumber = toInt(series.next_version_number, "next_version_number");
  await params.tx.query(
    `UPDATE public.commande_ar_series SET next_version_number = $2::int, updated_at = now() WHERE commande_id = $1::bigint`,
    [params.commande_id, versionNumber + 1]
  );
  return {
    series_number: seriesNumber,
    version_number: versionNumber,
    reference: formatCommandeArReference(seriesNumber, versionNumber),
  };
}

async function repoMarkCommandeArFailedLegacy(params: {
  commande_id: number;
  ar_id: string;
  error_message: string;
  claim?: LegacyCommandeArSendClaim;
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

type LegacyCommandeArSendClaim = {
  kind: "claimed";
  client: PoolClient;
  draft: CommandeArStoredDraft;
};

type LegacyCommandeArSendClaimResult =
  | LegacyCommandeArSendClaim
  | { kind: "replay"; draft: CommandeArStoredDraft };

async function repoClaimCommandeArSendLegacy(params: {
  commande_id: number;
  ar_id: string;
  user_id: number;
  user_role: string | null | undefined;
}): Promise<LegacyCommandeArSendClaimResult> {
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

async function repoAbortCommandeArSendClaimLegacy(claim: LegacyCommandeArSendClaim): Promise<void> {
  try {
    await claim.client.query("ROLLBACK");
  } finally {
    claim.client.release();
  }
}

async function repoFinalizeCommandeArSendLegacy(params: {
  claim: LegacyCommandeArSendClaim;
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

    const stockOnlyFlowRes = await tx.query<{ stock_only_flow: boolean }>(
      `
        SELECT COALESCE((metadata->>'stock_only_flow')::boolean, false) AS stock_only_flow
        FROM public.commande_client_workflow_checkpoint
        WHERE commande_id = $1::bigint
          AND checkpoint_code = 'ar_sent'
        LIMIT 1
      `,
      [params.commande_id]
    );
    const stockOnlyFlow = stockOnlyFlowRes.rows[0]?.stock_only_flow === true;

    const statusOut = await repoApplyCommandeWorkflowMilestone({
      tx,
      commande_id: params.commande_id,
      nouveau_statut: "AR_ENVOYE",
      cause: "ar_send",
      commentaire: params.commentaire,
      user_id: params.sent_by,
      completed_checkpoint_codes: ["ar_sent"],
      active_checkpoint_code: stockOnlyFlow ? "delivery" : "production_launch",
    });

    if (stockOnlyFlow) {
      // Le BL est préparé et réservé dès la revue, mais il ne devient
      // exploitable qu'après la preuve d'envoi de l'AR.
      await repoEnsureCommandeWorkflowStatus({
        tx,
        commande_id: params.commande_id,
        nouveau_statut: "PRET_LIVRAISON",
        cause: "ar_send",
        commentaire: "AR envoyé : livraison et sortie de stock désormais autorisées",
        user_id: params.sent_by,
      });
    }

    await insertCommandeEvent(tx, {
      commande_id: params.commande_id,
      event_type: "AR_SENT",
      new_values: {
        ar_id: params.ar_id,
        document_id: draft.document_id,
        recipient_emails: params.recipient_emails,
        email_provider_id: params.email_provider_id,
        stock_only_flow: stockOnlyFlow,
        workflow_status: stockOnlyFlow ? "PRET_LIVRAISON" : "AR_ENVOYE",
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
        reference: draft.reference,
        status: "AR_ENVOYE",
        sent_at: sentAt,
        recipient_emails: params.recipient_emails,
        email_provider_id: params.email_provider_id,
      },
      notifications: statusOut.notifications,
    };
  }, { transactionAlreadyStarted: true });
}

export type CommandeArRecipientContact = Pick<CommandeArContact, "contact_id" | "first_name" | "last_name" | "civility" | "email">;

export type CommandeArSendClaim =
  | { kind: "already_sent"; result: CommandeArSendResult }
  | {
      kind: "claimed";
      draft: CommandeArStoredDraft;
      lock_token: string;
      idempotency_key: string;
      contacts: CommandeArRecipientContact[];
    };

function normalizedEmails(values: string[]): string[] {
  return values.map((value) => value.trim().toLowerCase());
}

async function loadValidatedRecipientContacts(params: {
  tx: DbQueryer;
  client_id: string | null;
  recipient_emails: string[];
  recipient_contact_ids: string[];
}): Promise<CommandeArRecipientContact[]> {
  if (params.recipient_contact_ids.length === 0) return [];
  if (!params.client_id) throw new HttpError(422, "COMMANDE_AR_CONTACT_INVALID", "La commande ne possède pas de client associé");
  const contactsRes = await params.tx.query<CommandeArRecipientContact>(
    `
      SELECT ct.contact_id::text AS contact_id, ct.first_name, ct.last_name, ct.civility, ct.email
      FROM public.contacts ct
      WHERE ct.client_id = $1 AND ct.contact_id = ANY($2::uuid[])
      ORDER BY ct.contact_id ASC
    `,
    [params.client_id, params.recipient_contact_ids]
  );
  const byId = new Map(contactsRes.rows.map((contact) => [contact.contact_id, contact]));
  const recipientSet = new Set(normalizedEmails(params.recipient_emails));
  for (const contactId of params.recipient_contact_ids) {
    const contact = byId.get(contactId);
    const email = cleanEmail(contact?.email);
    if (!contact || !email || !recipientSet.has(email)) {
      throw new HttpError(
        422,
        "COMMANDE_AR_CONTACT_INVALID",
        "Chaque contact sélectionné doit appartenir au client de la commande et utiliser une adresse destinataire sélectionnée"
      );
    }
  }
  return params.recipient_contact_ids.map((id) => byId.get(id) as CommandeArRecipientContact);
}

export async function repoClaimCommandeArSend(params: {
  commande_id: number;
  ar_id: string;
  user_id: number;
  user_role?: string | null;
  recipient_emails: string[];
  recipient_contact_ids: string[];
  idempotency_key: string | null;
  payload_fingerprint: string;
}): Promise<CommandeArSendClaim> {
  const client = await pool.connect();
  let commitAttempted = false;
  let released = false;
  try {
    await client.query("BEGIN");
    const commande = await client.query<{ client_id: string | null }>(
      `SELECT client_id FROM public.commande_client WHERE id = $1::bigint FOR UPDATE`,
      [params.commande_id]
    );
    if (!commande.rows[0]) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    const draft = await repoGetCommandeArDraft({
      commande_id: params.commande_id,
      ar_id: params.ar_id,
      tx: client,
      for_update: true,
    });
    if (!draft) throw new HttpError(404, "COMMANDE_AR_NOT_FOUND", "Accusé de réception introuvable");
    if (draft.status === "SENT") {
      await repoAuthorizeCommandeArReplay({
        tx: client,
        commande_id: params.commande_id,
        user_id: params.user_id,
        user_role: params.user_role,
      });
      commitAttempted = true;
      await client.query("COMMIT");
      return {
        kind: "already_sent",
        result: {
          ar_id: draft.ar_id,
          commande_id: draft.commande_id,
          document_id: draft.document_id,
          reference: draft.reference,
          status: "AR_ENVOYE",
          sent_at: draft.sent_at ?? new Date().toISOString(),
          recipient_emails: draft.recipient_emails,
          email_provider_id: draft.email_provider_id,
          already_sent: true,
        },
      };
    }
    const currentData = await repoLoadCommandeArGenerationData(client, params.commande_id);
    if (!currentData) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    if (!isCommandeArSnapshotCurrent({
      storedSnapshot: draft.content_snapshot,
      storedFingerprint: draft.content_fingerprint,
      currentSnapshot: buildCommandeArContentSnapshot(currentData),
    })) {
      throw new HttpError(409, "COMMANDE_AR_OBSOLETE", "La commande a changé depuis la génération de cet accusé de réception.");
    }

    await repoAuthorizeCommandeArGeneration({
      tx: client,
      commande_id: params.commande_id,
      user_id: params.user_id,
      user_role: params.user_role,
    });

    if (draft.status === "SENDING") {
      const stale = await client.query<{ id: string }>(
        `
          UPDATE public.commande_ar_log
          SET status = 'FAILED',
              error_message = 'La tentative d''envoi précédente a expiré avant confirmation du fournisseur',
              send_lock_token = NULL
          WHERE id = $1::uuid AND commande_id = $2::bigint AND status = 'SENDING'
            AND (send_started_at IS NULL OR send_started_at <= now() - interval '5 minutes')
          RETURNING id::text AS id
        `,
        [params.ar_id, params.commande_id]
      );
      if (!stale.rows[0]) throw new HttpError(409, "COMMANDE_AR_SEND_IN_PROGRESS", "Cet accusé de réception est déjà en cours d'envoi");
      draft.status = "FAILED";
    }
    if (draft.status !== "GENERATED" && draft.status !== "FAILED") {
      throw new HttpError(409, "COMMANDE_AR_NOT_SENDABLE", "Cet accusé de réception ne peut pas être envoyé");
    }

    const requestedKey = params.idempotency_key?.trim() || null;
    if (draft.send_idempotency_key && requestedKey && draft.send_idempotency_key !== requestedKey) {
      throw new HttpError(409, "COMMANDE_AR_IDEMPOTENCY_KEY_MISMATCH", "La relance doit utiliser la même clé d'idempotence que la tentative initiale");
    }
    if (draft.send_payload_fingerprint && draft.send_payload_fingerprint !== params.payload_fingerprint) {
      throw new HttpError(409, "COMMANDE_AR_RETRY_PAYLOAD_MISMATCH", "La relance doit conserver les mêmes destinataires et le même message");
    }
    const contacts = await loadValidatedRecipientContacts({
      tx: client,
      client_id: commande.rows[0].client_id,
      recipient_emails: params.recipient_emails,
      recipient_contact_ids: params.recipient_contact_ids,
    });
    const lockToken = crypto.randomUUID();
    const idempotencyKey = draft.send_idempotency_key ?? requestedKey ?? `commande-ar:${draft.ar_id}`;
    const update = await client.query<{ send_attempt_count: number }>(
      `
        UPDATE public.commande_ar_log
        SET status = 'SENDING', send_attempt_count = COALESCE(send_attempt_count, 0) + 1,
            send_started_at = now(), send_lock_token = $3::uuid, send_idempotency_key = $4,
            send_payload_fingerprint = $5, error_message = NULL
        WHERE id = $1::uuid AND commande_id = $2::bigint AND status IN ('GENERATED', 'FAILED')
        RETURNING send_attempt_count::int AS send_attempt_count
      `,
      [params.ar_id, params.commande_id, lockToken, idempotencyKey, params.payload_fingerprint]
    );
    if (!update.rows[0]) throw new HttpError(409, "COMMANDE_AR_SEND_IN_PROGRESS", "Cet accusé de réception est déjà en cours d'envoi");
    await insertCommandeEvent(client, {
      commande_id: params.commande_id,
      event_type: "AR_SEND_ATTEMPT",
      new_values: {
        ar_id: params.ar_id,
        reference: draft.reference,
        attempt: update.rows[0].send_attempt_count,
        recipient_emails: normalizedEmails(params.recipient_emails),
        recipient_contact_ids: params.recipient_contact_ids,
        provider: "resend",
      },
      user_id: params.user_id,
    });
    commitAttempted = true;
    await client.query("COMMIT");
    return { kind: "claimed", draft, lock_token: lockToken, idempotency_key: idempotencyKey, contacts };
  } catch (error) {
    if (commitAttempted) {
      // The server may have committed even when the acknowledgement was lost.
      // Destroy this connection and never issue a misleading rollback after a
      // COMMIT attempt; a retry will observe SENT/SENDING under the row lock.
      client.release(true);
      released = true;
    } else {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

export async function repoMarkCommandeArFailed(params: {
  commande_id: number;
  ar_id: string;
  send_lock_token: string;
  error_message: string;
  user_id: number;
  provider_name?: string | null;
}): Promise<void> {
  const client = await pool.connect();
  await withRealtimeOutboxTransaction(client, async (tx) => {
    const update = await tx.query<{ id: string }>(
      `
        UPDATE public.commande_ar_log
        SET status = 'FAILED', error_message = left($4, 2000),
            provider_name = COALESCE($5, provider_name), send_lock_token = NULL
        WHERE id = $1::uuid AND commande_id = $2::bigint
          AND status = 'SENDING' AND send_lock_token = $3::uuid
        RETURNING id::text AS id
      `,
      [params.ar_id, params.commande_id, params.send_lock_token, params.error_message, params.provider_name ?? "resend"]
    );
    if (update.rows[0]) {
      await insertCommandeEvent(tx, {
        commande_id: params.commande_id,
        event_type: "AR_SEND_FAILED",
        new_values: { ar_id: params.ar_id, provider: params.provider_name ?? "resend", error_message: params.error_message.slice(0, 2000) },
        user_id: params.user_id,
      });
    }
  });
}

export async function repoFinalizeCommandeArSend(params: {
  commande_id: number;
  ar_id: string;
  send_lock_token: string;
  sent_by: number;
  recipient_emails: string[];
  recipient_contact_ids: string[];
  email_provider_id: string | null;
  provider_name: string;
  sent_email_subject: string;
  sent_email_text: string;
  sent_email_html: string;
  commentaire: string | null;
}): Promise<{ result: CommandeArSendResult; notifications: AppNotification[] }> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const draft = await repoGetCommandeArDraft({
      commande_id: params.commande_id,
      ar_id: params.ar_id,
      tx,
      for_update: true,
    });
    if (!draft) throw new HttpError(404, "COMMANDE_AR_NOT_FOUND", "Accusé de réception introuvable");
    if (draft.status === "SENT") {
      return {
        result: {
          ar_id: draft.ar_id,
          commande_id: draft.commande_id,
          document_id: draft.document_id,
          reference: draft.reference,
          status: "AR_ENVOYE",
          sent_at: draft.sent_at ?? new Date().toISOString(),
          recipient_emails: draft.recipient_emails,
          email_provider_id: draft.email_provider_id,
          already_sent: true,
        },
        notifications: [],
      };
    }
    const update = await tx.query<{ sent_at: string }>(
      `
        UPDATE public.commande_ar_log
        SET status = 'SENT', recipient_emails = $3::text[], recipient_contact_ids = $4::uuid[],
            sent_at = now(), sent_by = $5::int, email_provider_id = $6, provider_name = $7,
            sent_email_subject = $8, sent_email_text = $9, sent_email_html = $10,
            error_message = NULL, send_lock_token = NULL
        WHERE id = $1::uuid AND commande_id = $2::bigint
          AND status = 'SENDING' AND send_lock_token = $11::uuid
        RETURNING sent_at::text AS sent_at
      `,
      [params.ar_id, params.commande_id, normalizedEmails(params.recipient_emails), params.recipient_contact_ids,
        params.sent_by, params.email_provider_id, params.provider_name, params.sent_email_subject,
        params.sent_email_text, params.sent_email_html, params.send_lock_token]
    );
    const sentAt = update.rows[0]?.sent_at;
    if (!sentAt) throw new HttpError(409, "COMMANDE_AR_SEND_CLAIM_LOST", "La réservation d'envoi de l'AR a expiré");

    const stockOnlyFlowRes = await tx.query<{ stock_only_flow: boolean }>(
      `SELECT COALESCE((metadata->>'stock_only_flow')::boolean, false) AS stock_only_flow FROM public.commande_client_workflow_checkpoint WHERE commande_id = $1::bigint AND checkpoint_code = 'ar_sent' LIMIT 1`,
      [params.commande_id]
    );
    const stockOnlyFlow = stockOnlyFlowRes.rows[0]?.stock_only_flow === true;
    const statusOut = await repoApplyCommandeWorkflowMilestone({
      tx,
      commande_id: params.commande_id,
      nouveau_statut: "AR_ENVOYE",
      cause: "ar_send",
      commentaire: params.commentaire,
      user_id: params.sent_by,
      completed_checkpoint_codes: ["ar_sent"],
      active_checkpoint_code: stockOnlyFlow ? "delivery" : "production_launch",
    });
    if (stockOnlyFlow) {
      await repoEnsureCommandeWorkflowStatus({
        tx,
        commande_id: params.commande_id,
        nouveau_statut: "PRET_LIVRAISON",
        cause: "ar_send",
        commentaire: "AR envoyé : livraison et sortie de stock désormais autorisées",
        user_id: params.sent_by,
      });
    }
    await insertCommandeEvent(tx, {
      commande_id: params.commande_id,
      event_type: "AR_SENT",
      new_values: {
        ar_id: params.ar_id,
        document_id: draft.document_id,
        reference: draft.reference,
        recipient_emails: normalizedEmails(params.recipient_emails),
        recipient_contact_ids: params.recipient_contact_ids,
        provider: params.provider_name,
        email_provider_id: params.email_provider_id,
      },
      user_id: params.sent_by,
    });
    for (const notification of statusOut.notifications) {
      await enqueueAppNotificationCreated(tx, notification.user_id, notification, { deduplicationKey: `notification:${notification.id}` });
    }
    await enqueueEntityChanged(tx, {
      entityType: "COMMANDE_CLIENT",
      entityId: String(params.commande_id),
      action: "status_changed",
      module: "commandes-clients",
      at: sentAt,
      invalidateKeys: ["commandes:list", `commandes:detail:${params.commande_id}`],
    }, { deduplicationKey: `commande-ar:${params.ar_id}:sent` });
    return {
      result: {
        ar_id: draft.ar_id,
        commande_id: params.commande_id,
        document_id: draft.document_id,
        reference: draft.reference,
        status: "AR_ENVOYE",
        sent_at: sentAt,
        recipient_emails: normalizedEmails(params.recipient_emails),
        email_provider_id: params.email_provider_id,
      },
      notifications: statusOut.notifications,
    };
  });
}
