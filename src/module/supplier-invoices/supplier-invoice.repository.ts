import crypto from "node:crypto";

import type { PoolClient } from "pg";

import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";
import { repoInsertAuditLog } from "../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../audit-logs/validators/audit-logs.validators";
import { supplierInvoiceRequestHash, type SupplierInvoiceStatus } from "./supplier-invoice.domain";
import type {
  SupplierInvoiceListQuery,
  SupplierInvoiceIdentifyBody,
  SupplierInvoiceMatchBody,
  SupplierInvoiceReasonBody,
  SupplierInvoiceVersionBody,
} from "./supplier-invoice.validators";

type Queryer = Pick<PoolClient, "query">;

export type SupplierInvoiceActor = Readonly<{
  userId: number;
  role: string | null;
  ip: string | null;
  userAgent: string | null;
  path: string | null;
  pageKey: string | null;
  clientSessionId: string | null;
}>;

type LockedInvoice = {
  id: string;
  status: SupplierInvoiceStatus;
  row_version: number;
  fournisseur_id: string | null;
  issue_date: string;
  document_type: "INVOICE" | "CREDIT_NOTE";
  purchase_order_reference: string | null;
  legal_number: string;
  provider_code: string;
  provider_document_id: string;
};

type InvoiceLineRow = {
  id: string;
  position: number;
  provider_line_id: string;
  designation: string;
  quantity: number | null;
  unit_price: number | null;
  vat_rate: number | null;
  purchase_order_line_reference: string | null;
  article_buyer_reference: string | null;
  article_seller_reference: string | null;
};

type OrderLineRow = {
  id: string;
  position: number;
  reference_fournisseur: string | null;
  article_code: string | null;
  designation: string;
  quantity: number;
  qty_annulee: number;
  prix_unitaire_ht: number;
  remise_pct: number;
  tva_pct: number;
  receipt_line_ids: string[];
  received_quantity: number;
  policy_id: string | null;
  price_tolerance_pct: number | null;
  policy_scope_type: string | null;
  policy_scope_id: string | null;
  policy_valid_from: string | null;
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function ensureInstalled(queryer: Queryer = pool): Promise<void> {
  const result = await queryer.query<{ installed: boolean }>(
    `SELECT to_regclass('public.supplier_invoices') IS NOT NULL
         AND to_regclass('public.supplier_invoice_command_receipts') IS NOT NULL AS installed`
  );
  if (!result.rows[0]?.installed) {
    throw new HttpError(503, "SUPPLIER_INVOICES_NOT_INSTALLED", "Le patch #675 doit être appliqué avant d'utiliser les factures fournisseurs.");
  }
}

async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function audit(
  tx: Queryer,
  actor: SupplierInvoiceActor,
  action: string,
  invoiceId: string,
  details: Record<string, unknown>
): Promise<void> {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action,
    page_key: actor.pageKey,
    entity_type: "SUPPLIER_INVOICE",
    entity_id: invoiceId,
    path: actor.path,
    client_session_id: actor.clientSessionId,
    details,
  };
  await repoInsertAuditLog({
    user_id: actor.userId,
    body,
    ip: actor.ip,
    user_agent: actor.userAgent,
    device_type: null,
    os: null,
    browser: null,
    tx,
  });
}

async function readReceipt<T>(
  tx: Queryer,
  actor: SupplierInvoiceActor,
  idempotencyKey: string,
  commandType: string,
  invoiceId: string,
  requestHash: string
): Promise<T | null> {
  const result = await tx.query<{ command_type: string; supplier_invoice_id: string; request_hash: string; response_snapshot: T }>(
    `SELECT command_type,supplier_invoice_id::text,request_hash,response_snapshot
       FROM public.supplier_invoice_command_receipts
      WHERE actor_user_id=$1 AND idempotency_key=$2`,
    [actor.userId, idempotencyKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.command_type !== commandType || row.supplier_invoice_id !== invoiceId || row.request_hash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà été utilisée avec une autre commande.");
  }
  return row.response_snapshot;
}

async function saveReceipt(
  tx: Queryer,
  actor: SupplierInvoiceActor,
  idempotencyKey: string,
  commandType: string,
  invoiceId: string,
  requestHash: string,
  response: Record<string, unknown>
): Promise<void> {
  await tx.query(
    `INSERT INTO public.supplier_invoice_command_receipts(
       actor_user_id,idempotency_key,command_type,supplier_invoice_id,request_hash,response_snapshot
     ) VALUES ($1,$2,$3,$4::uuid,$5,$6::jsonb)`,
    [actor.userId,idempotencyKey,commandType,invoiceId,requestHash,JSON.stringify(response)]
  );
}

async function lockInvoice(tx: Queryer, invoiceId: string, expectedVersion: number): Promise<LockedInvoice> {
  const result = await tx.query<LockedInvoice>(
    `SELECT si.id::text,si.status,si.row_version,si.fournisseur_id::text,si.issue_date::text,
            si.document_type,si.purchase_order_reference,si.legal_number,d.provider_code,d.provider_document_id
       FROM public.supplier_invoices si
       JOIN public.einvoice_documents d ON d.id=si.einvoice_document_id
      WHERE si.id=$1::uuid FOR UPDATE OF si`,
    [invoiceId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "SUPPLIER_INVOICE_NOT_FOUND", "Facture fournisseur introuvable.");
  if (Number(row.row_version) !== expectedVersion) {
    throw new HttpError(409, "SUPPLIER_INVOICE_VERSION_CONFLICT", "La facture fournisseur a changé ; rechargez le dossier.");
  }
  return { ...row, row_version: Number(row.row_version) };
}

export async function repoIdentifySupplierInvoice(params: {
  invoiceId: string;
  body: SupplierInvoiceIdentifyBody;
  actor: SupplierInvoiceActor;
  idempotencyKey: string;
}) {
  return transaction(async (tx) => {
    await ensureInstalled(tx);
    const requestHash = supplierInvoiceRequestHash(params.body);
    const replay = await readReceipt<Record<string, unknown>>(tx,params.actor,params.idempotencyKey,"IDENTIFY",params.invoiceId,requestHash);
    if (replay) return replay;
    const invoice = await lockInvoice(tx,params.invoiceId,params.body.expected_version);
    if (invoice.status !== "RECEIVED") {
      throw new HttpError(409,"SUPPLIER_INVOICE_IDENTIFY_STATE","Seule une facture reçue non identifiée peut être qualifiée manuellement.");
    }
    const supplier = await tx.query<{ id: string }>(
      `SELECT id::text FROM public.fournisseurs WHERE id=$1::uuid AND actif=true FOR SHARE`,
      [params.body.fournisseur_id]
    );
    if (!supplier.rows[0]) throw new HttpError(422,"SUPPLIER_INVOICE_SUPPLIER_INVALID","Le fournisseur sélectionné est introuvable ou inactif.");
    const duplicate = await tx.query<{ id: string }>(
      `SELECT id::text FROM public.supplier_invoices
        WHERE fournisseur_id=$1::uuid AND legal_number=$2 AND document_type=$3 AND id<>$4::uuid
        LIMIT 1`,
      [params.body.fournisseur_id,invoice.legal_number,invoice.document_type,params.invoiceId]
    );
    if (duplicate.rows[0]) {
      throw new HttpError(409,"SUPPLIER_INVOICE_DUPLICATE_LEGAL_NUMBER","Une pièce du même fournisseur porte déjà ce numéro légal.");
    }
    await tx.query(
      `UPDATE public.supplier_invoices
          SET fournisseur_id=$2::uuid,status='IDENTIFIED',identification_error=NULL,identified_at=now(),
              row_version=row_version+1,updated_at=now()
        WHERE id=$1::uuid`,
      [params.invoiceId,params.body.fournisseur_id]
    );
    await tx.query(
      `INSERT INTO public.supplier_invoice_decisions(
         supplier_invoice_id,decision,from_status,to_status,snapshot,actor_user_id
       ) VALUES ($1::uuid,'IDENTIFIED','RECEIVED','IDENTIFIED',$2::jsonb,$3)`,
      [params.invoiceId,JSON.stringify({ source: "MANUAL", fournisseur_id: params.body.fournisseur_id }),params.actor.userId]
    );
    await tx.query(
      `INSERT INTO public.supplier_invoice_provider_status_outbox(
         supplier_invoice_id,provider_code,provider_document_id,status_code,correlation_id
       ) VALUES ($1::uuid,$2,$3,205,$4::uuid)`,
      [params.invoiceId,invoice.provider_code,invoice.provider_document_id,crypto.randomUUID()]
    );
    const response = { id: params.invoiceId,status: "IDENTIFIED",row_version: invoice.row_version + 1,fournisseur_id: params.body.fournisseur_id };
    await saveReceipt(tx,params.actor,params.idempotencyKey,"IDENTIFY",params.invoiceId,requestHash,response);
    await audit(tx,params.actor,"supplier-invoices.identify",params.invoiceId,{ before: "RECEIVED",after: "IDENTIFIED",fournisseur_id: params.body.fournisseur_id });
    return response;
  });
}

export async function repoListSupplierInvoices(query: SupplierInvoiceListQuery) {
  await ensureInstalled();
  const values: unknown[] = [];
  const where: string[] = ["1=1"];
  const push = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.status) where.push(`si.status=${push(query.status)}`);
  if (query.fournisseur_id) where.push(`si.fournisseur_id=${push(query.fournisseur_id)}::uuid`);
  if (query.search) {
    const p = push(`%${query.search.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(si.legal_number ILIKE ${p} ESCAPE '\\' OR f.nom ILIKE ${p} ESCAPE '\\' OR f.code ILIKE ${p} ESCAPE '\\')`);
  }
  const limit = push(query.limit);
  const offset = push(query.offset);
  const result = await pool.query(
    `SELECT si.id::text,si.document_type,si.legal_number,si.issue_date::text,si.payment_due_date::text,
            si.currency,si.total_with_vat::float8,si.amount_due::float8,si.status,si.identification_error,
            si.row_version,si.received_at::text,si.updated_at::text,si.fournisseur_id::text,
            f.code AS fournisseur_code,f.nom AS fournisseur_nom,count(*) OVER()::int AS total_count
       FROM public.supplier_invoices si
       LEFT JOIN public.fournisseurs f ON f.id=si.fournisseur_id
      WHERE ${where.join(" AND ")}
      ORDER BY si.received_at DESC,si.id DESC LIMIT ${limit} OFFSET ${offset}`,
    values
  );
  return { data: result.rows.map(({ total_count: _total, ...row }) => row), total: Number(result.rows[0]?.total_count ?? 0) };
}

export async function repoGetSupplierInvoice(invoiceId: string) {
  await ensureInstalled();
  const invoice = await pool.query(
    `SELECT si.*,si.id::text AS id,si.einvoice_document_id::text,si.fournisseur_id::text,
            si.issue_date::text,si.payment_due_date::text,si.received_at::text,si.identified_at::text,
            si.approved_at::text,si.accounting_exported_at::text,si.closed_at::text,
            si.created_at::text,si.updated_at::text,d.provider_code,d.provider_document_id,
            d.external_status_code,d.content_storage_reference,f.code AS fournisseur_code,f.nom AS fournisseur_nom,
            f.compte_tiers AS fournisseur_compte_tiers
       FROM public.supplier_invoices si
       JOIN public.einvoice_documents d ON d.id=si.einvoice_document_id
       LEFT JOIN public.fournisseurs f ON f.id=si.fournisseur_id
      WHERE si.id=$1::uuid`,
    [invoiceId]
  );
  if (!invoice.rows[0]) throw new HttpError(404, "SUPPLIER_INVOICE_NOT_FOUND", "Facture fournisseur introuvable.");
  const [lines, artifacts, matches, decisions] = await Promise.all([
    pool.query(
      `SELECT id::text,provider_line_id,position,designation,quantity::float8,unit_code,unit_price::float8,
              net_amount::float8,vat_category,vat_rate::float8,purchase_order_line_reference,
              article_buyer_reference,article_seller_reference
         FROM public.supplier_invoice_lines WHERE supplier_invoice_id=$1::uuid ORDER BY position`, [invoiceId]
    ),
    pool.query(
      `SELECT id::text,kind,provider_key,file_name,mime_type,content_sha256,size_bytes,scan_status,
              ged_document_id::text,ged_version_id::text,archived_at::text
         FROM public.supplier_invoice_artifacts WHERE supplier_invoice_id=$1::uuid ORDER BY kind,provider_key`, [invoiceId]
    ),
    pool.query(
      `SELECT mv.id::text,mv.version,mv.mode,mv.purchase_order_id::text,mv.outcome,mv.policy_snapshot,
              mv.summary,mv.manual_justification,mv.actor_user_id,mv.created_at::text,
              COALESCE(jsonb_agg(jsonb_build_object(
                'supplier_invoice_line_id',lm.supplier_invoice_line_id,'purchase_order_line_id',lm.purchase_order_line_id,
                'reception_line_ids',lm.reception_line_ids,'ordered_quantity',lm.ordered_quantity,
                'received_quantity',lm.received_quantity,'invoiced_quantity',lm.invoiced_quantity,
                'ordered_unit_price',lm.ordered_unit_price,'invoiced_unit_price',lm.invoiced_unit_price,
                'ordered_vat_rate',lm.ordered_vat_rate,'invoiced_vat_rate',lm.invoiced_vat_rate,
                'price_delta_pct',lm.price_delta_pct,'price_tolerance_pct',lm.price_tolerance_pct,
                'price_policy_id',lm.price_policy_id,'quantity_status',lm.quantity_status,
                'price_status',lm.price_status,'vat_status',lm.vat_status
              ) ORDER BY sil.position) FILTER(WHERE lm.id IS NOT NULL),'[]'::jsonb) AS lines
         FROM public.supplier_invoice_match_versions mv
         LEFT JOIN public.supplier_invoice_line_matches lm ON lm.match_version_id=mv.id
         LEFT JOIN public.supplier_invoice_lines sil ON sil.id=lm.supplier_invoice_line_id
        WHERE mv.supplier_invoice_id=$1::uuid GROUP BY mv.id ORDER BY mv.version DESC`, [invoiceId]
    ),
    pool.query(
      `SELECT id::text,decision,from_status,to_status,reason,snapshot,actor_user_id,created_at::text
         FROM public.supplier_invoice_decisions WHERE supplier_invoice_id=$1::uuid ORDER BY created_at,id`, [invoiceId]
    ),
  ]);
  return { ...invoice.rows[0], lines: lines.rows, artifacts: artifacts.rows, matches: matches.rows, decisions: decisions.rows };
}

async function loadInvoiceLines(tx: Queryer, invoiceId: string): Promise<InvoiceLineRow[]> {
  const result = await tx.query<InvoiceLineRow>(
    `SELECT id::text,position,provider_line_id,designation,quantity::float8,unit_price::float8,vat_rate::float8,
            purchase_order_line_reference,article_buyer_reference,article_seller_reference
       FROM public.supplier_invoice_lines WHERE supplier_invoice_id=$1::uuid ORDER BY position`,
    [invoiceId]
  );
  return result.rows.map((row) => ({
    ...row,
    position: Number(row.position),
    quantity: finite(row.quantity),
    unit_price: finite(row.unit_price),
    vat_rate: finite(row.vat_rate),
  }));
}

async function resolveOrderId(tx: Queryer, invoice: LockedInvoice, requested: string | null | undefined): Promise<string | null> {
  if (!invoice.fournisseur_id) return null;
  if (requested) {
    const exact = await tx.query<{ id: string }>(
      `SELECT id::text FROM public.commande_fournisseur
        WHERE id=$1::uuid AND fournisseur_id=$2::uuid AND statut<>'ANNULEE'`,
      [requested, invoice.fournisseur_id]
    );
    if (!exact.rows[0]) throw new HttpError(422, "SUPPLIER_INVOICE_ORDER_INVALID", "La commande choisie n'appartient pas au fournisseur de la facture.");
    return exact.rows[0].id;
  }
  if (!invoice.purchase_order_reference) return null;
  const result = await tx.query<{ id: string }>(
    `SELECT id::text FROM public.commande_fournisseur
      WHERE fournisseur_id=$1::uuid AND statut<>'ANNULEE'
        AND (code=$2 OR reference_fournisseur=$2)
      ORDER BY created_at DESC LIMIT 2`,
    [invoice.fournisseur_id, invoice.purchase_order_reference]
  );
  return result.rows.length === 1 ? result.rows[0]!.id : null;
}

async function loadOrderLines(tx: Queryer, orderId: string, supplierId: string, effectiveDate: string): Promise<OrderLineRow[]> {
  const result = await tx.query<OrderLineRow>(
    `SELECT l.id::text,l.position,l.reference_fournisseur,a.code AS article_code,l.designation,
            l.quantite::float8,l.qty_annulee::float8,l.prix_unitaire_ht::float8,l.remise_pct::float8,l.tva_pct::float8,
            COALESCE(r.receipt_line_ids,ARRAY[]::text[]) AS receipt_line_ids,COALESCE(r.received_quantity,0)::float8 AS received_quantity,
            policy.id::text AS policy_id,policy.price_tolerance_pct::float8,policy.scope_type AS policy_scope_type,
            policy.scope_id AS policy_scope_id,policy.valid_from::text AS policy_valid_from
       FROM public.commande_fournisseur_ligne l
       JOIN public.commande_fournisseur cf ON cf.id=l.commande_id AND cf.fournisseur_id=$2::uuid
       LEFT JOIN public.articles a ON a.id=l.article_id
       LEFT JOIN LATERAL (
         SELECT array_agg(rl.id::text ORDER BY rl.id) AS receipt_line_ids,sum(rl.qty_received) AS received_quantity
           FROM public.reception_fournisseur_lignes rl
           JOIN public.receptions_fournisseurs rf ON rf.id=rl.reception_id AND rf.status<>'CANCELLED'
          WHERE rl.commande_fournisseur_ligne_id=l.id
       ) r ON TRUE
       LEFT JOIN LATERAL (
         SELECT p.* FROM public.procurement_policy_versions p
          WHERE p.valid_from<=$3::date AND (
            (p.scope_type='ARTICLE' AND p.scope_id=l.article_id::text)
            OR (p.scope_type='SUPPLIER' AND p.scope_id=$2::text)
            OR (p.scope_type='FAMILY' AND p.scope_id=a.family_code)
            OR (p.scope_type='COMPANY' AND p.scope_id IS NULL)
          )
          ORDER BY CASE p.scope_type WHEN 'ARTICLE' THEN 1 WHEN 'SUPPLIER' THEN 2 WHEN 'FAMILY' THEN 3 ELSE 4 END,
                   p.valid_from DESC LIMIT 1
       ) policy ON TRUE
      WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE' ORDER BY l.position`,
    [orderId, supplierId, effectiveDate]
  );
  return result.rows.map((row) => ({
    ...row,
    position: Number(row.position),
    quantity: Number(row.quantity),
    qty_annulee: Number(row.qty_annulee),
    prix_unitaire_ht: Number(row.prix_unitaire_ht),
    remise_pct: Number(row.remise_pct),
    tva_pct: Number(row.tva_pct),
    received_quantity: Number(row.received_quantity),
    receipt_line_ids: Array.isArray(row.receipt_line_ids) ? row.receipt_line_ids : [],
    price_tolerance_pct: finite(row.price_tolerance_pct),
  }));
}

function pairOrderLine(line: InvoiceLineRow, orderLines: OrderLineRow[], used: Set<string>): OrderLineRow | null {
  const available = orderLines.filter((candidate) => !used.has(candidate.id));
  const reference = line.purchase_order_line_reference?.trim().toLowerCase() ?? null;
  const supplierReference = line.article_seller_reference?.trim().toLowerCase() ?? null;
  const buyerReference = line.article_buyer_reference?.trim().toLowerCase() ?? null;
  const priorities = [
    available.filter((candidate) => reference && [candidate.id, String(candidate.position), candidate.reference_fournisseur].some((value) => value?.toLowerCase() === reference)),
    available.filter((candidate) => supplierReference && candidate.reference_fournisseur?.toLowerCase() === supplierReference),
    available.filter((candidate) => buyerReference && candidate.article_code?.toLowerCase() === buyerReference),
    available.filter((candidate) => candidate.position === line.position),
  ];
  for (const candidates of priorities) if (candidates.length === 1) return candidates[0]!;
  return null;
}

export async function repoMatchSupplierInvoice(params: {
  invoiceId: string;
  body: SupplierInvoiceMatchBody;
  actor: SupplierInvoiceActor;
  idempotencyKey: string;
}) {
  return transaction(async (tx) => {
    await ensureInstalled(tx);
    const requestHash = supplierInvoiceRequestHash(params.body);
    const replay = await readReceipt<Record<string, unknown>>(tx, params.actor, params.idempotencyKey, "MATCH", params.invoiceId, requestHash);
    if (replay) return replay;
    const invoice = await lockInvoice(tx, params.invoiceId, params.body.expected_version);
    if (!invoice.fournisseur_id) throw new HttpError(422, "SUPPLIER_INVOICE_NOT_IDENTIFIED", "Identifiez le fournisseur avant le rapprochement.");
    if (!["IDENTIFIED", "MATCHED", "DISPUTED"].includes(invoice.status)) {
      throw new HttpError(409, "SUPPLIER_INVOICE_MATCH_STATE", "Le rapprochement n'est pas permis dans l'état actuel.");
    }
    const lines = await loadInvoiceLines(tx, params.invoiceId);
    const orderId = await resolveOrderId(tx, invoice, params.body.purchase_order_id);
    const orderLines = orderId ? await loadOrderLines(tx, orderId, invoice.fournisseur_id, invoice.issue_date) : [];
    const nextVersion = await tx.query<{ version: number }>(
      `SELECT COALESCE(max(version),0)+1 AS version FROM public.supplier_invoice_match_versions WHERE supplier_invoice_id=$1::uuid`,
      [params.invoiceId]
    );
    const used = new Set<string>();
    const matchedLines = lines.map((line) => {
      const orderLine = pairOrderLine(line, orderLines, used);
      if (orderLine) used.add(orderLine.id);
      if (params.body.mode === "MANUAL") {
        return { line, orderLine, quantityStatus: "MANUAL", priceStatus: "MANUAL", vatStatus: "MANUAL", priceDeltaPct: null } as const;
      }
      if (!orderLine) {
        return { line, orderLine: null, quantityStatus: "UNKNOWN", priceStatus: "UNQUALIFIED", vatStatus: "UNKNOWN", priceDeltaPct: null } as const;
      }
      const invoicedQuantity = line.quantity == null ? null : Math.abs(line.quantity);
      const expectedQuantity = Math.max(0, orderLine.quantity - orderLine.qty_annulee);
      const quantityStatus = invoicedQuantity == null
        ? "UNKNOWN"
        : Math.abs(invoicedQuantity - expectedQuantity) <= 0.000001 && Math.abs(invoicedQuantity - orderLine.received_quantity) <= 0.000001
          ? "EXACT"
          : invoicedQuantity <= orderLine.received_quantity + 0.000001 ? "WITHIN_RECEIPT" : "OVER_RECEIPT";
      const orderedPrice = orderLine.prix_unitaire_ht * (1 - orderLine.remise_pct / 100);
      const priceDeltaPct = line.unit_price == null || orderedPrice === 0
        ? null
        : Math.abs(line.unit_price - orderedPrice) / Math.abs(orderedPrice) * 100;
      const priceStatus = line.unit_price == null
        ? "UNQUALIFIED"
        : Math.abs(line.unit_price - orderedPrice) <= 0.000001
          ? "EXACT"
          : orderLine.price_tolerance_pct == null || priceDeltaPct == null
            ? "UNQUALIFIED"
            : priceDeltaPct <= orderLine.price_tolerance_pct + 0.000001 ? "WITHIN_TOLERANCE" : "OUTSIDE_TOLERANCE";
      const vatStatus = line.vat_rate == null ? "UNKNOWN" : Math.abs(line.vat_rate - orderLine.tva_pct) <= 0.000001 ? "EXACT" : "MISMATCH";
      return { line, orderLine, quantityStatus, priceStatus, vatStatus, priceDeltaPct } as const;
    });
    const automaticSuccess = orderId !== null && matchedLines.every((item) =>
      item.orderLine !== null
      && ["EXACT", "WITHIN_RECEIPT"].includes(item.quantityStatus)
      && ["EXACT", "WITHIN_TOLERANCE"].includes(item.priceStatus)
      && item.vatStatus === "EXACT"
    );
    const outcome = params.body.mode === "MANUAL" ? "MATCHED" : automaticSuccess ? "MATCHED" : orderId ? "VARIANCE" : "UNMATCHED";
    const policySnapshot = {
      effective_date: invoice.issue_date,
      explicit_no_default: true,
      policies: [...new Map(orderLines.filter((line) => line.policy_id).map((line) => [line.policy_id, {
        id: line.policy_id,
        scope_type: line.policy_scope_type,
        scope_id: line.policy_scope_id,
        valid_from: line.policy_valid_from,
        price_tolerance_pct: line.price_tolerance_pct,
      }])).values()],
    };
    const summary = {
      outcome,
      mode: params.body.mode,
      purchase_order_id: orderId,
      invoice_lines: lines.length,
      linked_lines: matchedLines.filter((line) => line.orderLine).length,
      exceptions: matchedLines.filter((line) =>
        !line.orderLine || !["EXACT", "WITHIN_RECEIPT", "MANUAL"].includes(line.quantityStatus)
        || !["EXACT", "WITHIN_TOLERANCE", "MANUAL"].includes(line.priceStatus)
        || !["EXACT", "MANUAL"].includes(line.vatStatus)
      ).length,
      manual_approval_required: true,
    };
    const version = Number(nextVersion.rows[0]!.version);
    const match = await tx.query<{ id: string }>(
      `INSERT INTO public.supplier_invoice_match_versions(
         supplier_invoice_id,version,mode,purchase_order_id,outcome,policy_snapshot,summary,manual_justification,actor_user_id
       ) VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING id::text`,
      [params.invoiceId,version,params.body.mode,orderId,outcome,JSON.stringify(policySnapshot),JSON.stringify(summary),params.body.manual_justification ?? null,params.actor.userId]
    );
    for (const item of matchedLines) {
      const orderLine = item.orderLine;
      const orderedPrice = orderLine ? orderLine.prix_unitaire_ht * (1 - orderLine.remise_pct / 100) : null;
      await tx.query(
        `INSERT INTO public.supplier_invoice_line_matches(
           match_version_id,supplier_invoice_line_id,purchase_order_line_id,reception_line_ids,
           ordered_quantity,received_quantity,invoiced_quantity,ordered_unit_price,invoiced_unit_price,
           ordered_vat_rate,invoiced_vat_rate,price_delta_pct,price_tolerance_pct,price_policy_id,
           quantity_status,price_status,vat_status
         ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15,$16,$17)`,
        [match.rows[0]!.id,item.line.id,orderLine?.id ?? null,orderLine?.receipt_line_ids ?? [],
          orderLine ? Math.max(0,orderLine.quantity-orderLine.qty_annulee) : null,orderLine?.received_quantity ?? null,
          item.line.quantity,orderedPrice,item.line.unit_price,orderLine?.tva_pct ?? null,item.line.vat_rate,
          item.priceDeltaPct,orderLine?.price_tolerance_pct ?? null,orderLine?.policy_id ?? null,
          item.quantityStatus,item.priceStatus,item.vatStatus]
      );
    }
    const toStatus = outcome === "MATCHED" ? "MATCHED" : "IDENTIFIED";
    await tx.query(
      `UPDATE public.supplier_invoices SET status=$2,match_summary=$3::jsonb,row_version=row_version+1,updated_at=now()
        WHERE id=$1::uuid`,
      [params.invoiceId,toStatus,JSON.stringify(summary)]
    );
    await tx.query(
      `INSERT INTO public.supplier_invoice_decisions(
         supplier_invoice_id,decision,from_status,to_status,reason,snapshot,actor_user_id
       ) VALUES ($1::uuid,'MATCHED',$2,$3,$4,$5::jsonb,$6)`,
      [params.invoiceId,invoice.status,toStatus,params.body.manual_justification ?? null,JSON.stringify({ match_version: version, ...summary }),params.actor.userId]
    );
    const response = { id: params.invoiceId, status: toStatus, row_version: invoice.row_version + 1, match_version: version, summary };
    await saveReceipt(tx,params.actor,params.idempotencyKey,"MATCH",params.invoiceId,requestHash,response);
    await audit(tx,params.actor,"supplier-invoices.match",params.invoiceId,{ before: invoice.status, after: toStatus, match_version: version, outcome });
    return response;
  });
}

async function transition(params: {
  invoiceId: string;
  body: SupplierInvoiceVersionBody | SupplierInvoiceReasonBody;
  actor: SupplierInvoiceActor;
  idempotencyKey: string;
  command: "REQUEST_APPROVAL" | "APPROVE" | "DISPUTE" | "REJECT";
}) {
  return transaction(async (tx) => {
    await ensureInstalled(tx);
    const requestHash = supplierInvoiceRequestHash(params.body);
    const replay = await readReceipt<Record<string, unknown>>(tx,params.actor,params.idempotencyKey,params.command,params.invoiceId,requestHash);
    if (replay) return replay;
    const invoice = await lockInvoice(tx,params.invoiceId,params.body.expected_version);
    const definitions = {
      REQUEST_APPROVAL: { allowed: ["MATCHED"], to: "PENDING_APPROVAL", decision: "APPROVAL_REQUESTED", statusCode: null },
      APPROVE: { allowed: ["PENDING_APPROVAL"], to: "APPROVED", decision: "APPROVED", statusCode: 206 },
      DISPUTE: { allowed: ["IDENTIFIED","MATCHED","PENDING_APPROVAL"], to: "DISPUTED", decision: "DISPUTED", statusCode: 211 },
      REJECT: { allowed: ["RECEIVED","IDENTIFIED","MATCHED","PENDING_APPROVAL","DISPUTED"], to: "REJECTED", decision: "REJECTED", statusCode: 208 },
    } as const;
    const definition = definitions[params.command];
    if (!(definition.allowed as readonly string[]).includes(invoice.status)) {
      throw new HttpError(409,"SUPPLIER_INVOICE_TRANSITION_INVALID","Cette décision n'est pas permise dans l'état actuel.");
    }
    if (params.command === "REQUEST_APPROVAL") {
      const archive = await tx.query<{ ready: boolean }>(
        `SELECT count(*)>0 AND bool_and(scan_status='CLEAN' AND ged_document_id IS NOT NULL) AS ready
           FROM public.supplier_invoice_artifacts WHERE supplier_invoice_id=$1::uuid`, [params.invoiceId]
      );
      if (archive.rows[0]?.ready !== true) throw new HttpError(409,"SUPPLIER_INVOICE_ARCHIVE_INCOMPLETE","Toutes les pièces doivent être contrôlées et archivées avant approbation.");
    }
    const reason = "reason" in params.body ? params.body.reason : null;
    await tx.query(
      `UPDATE public.supplier_invoices SET status=$2,row_version=row_version+1,updated_at=now(),
         approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END,
         approved_by=CASE WHEN $2='APPROVED' THEN $3 ELSE approved_by END
       WHERE id=$1::uuid`,
      [params.invoiceId,definition.to,params.actor.userId]
    );
    await tx.query(
      `INSERT INTO public.supplier_invoice_decisions(
         supplier_invoice_id,decision,from_status,to_status,reason,snapshot,actor_user_id
       ) VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb,$7)`,
      [params.invoiceId,definition.decision,invoice.status,definition.to,reason,JSON.stringify({ expected_version: params.body.expected_version }),params.actor.userId]
    );
    if (definition.statusCode) {
      await tx.query(
        `INSERT INTO public.supplier_invoice_provider_status_outbox(
           supplier_invoice_id,provider_code,provider_document_id,status_code,details,correlation_id
         ) VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::uuid)`,
        [params.invoiceId,invoice.provider_code,invoice.provider_document_id,definition.statusCode,
          JSON.stringify(reason ? [{ reason }] : []),crypto.randomUUID()]
      );
    }
    const response = { id: params.invoiceId, status: definition.to, row_version: invoice.row_version + 1 };
    await saveReceipt(tx,params.actor,params.idempotencyKey,params.command,params.invoiceId,requestHash,response);
    await audit(tx,params.actor,`supplier-invoices.${params.command.toLowerCase().replace("_","-")}`,params.invoiceId,{ before: invoice.status, after: definition.to, reason });
    return response;
  });
}

export const repoRequestSupplierInvoiceApproval = (params: Omit<Parameters<typeof transition>[0], "command">) => transition({ ...params, command: "REQUEST_APPROVAL" });
export const repoApproveSupplierInvoice = (params: Omit<Parameters<typeof transition>[0], "command">) => transition({ ...params, command: "APPROVE" });
export const repoDisputeSupplierInvoice = (params: Omit<Parameters<typeof transition>[0], "command">) => transition({ ...params, command: "DISPUTE" });
export const repoRejectSupplierInvoice = (params: Omit<Parameters<typeof transition>[0], "command">) => transition({ ...params, command: "REJECT" });
