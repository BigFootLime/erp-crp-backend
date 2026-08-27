import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { canonicalJson } from "../domain/finance-policy";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import type {
  EReportingPaymentBody,
  EReportingPeriodsQuery,
  EReportingTransactionBody,
} from "./electronic-invoice-reporting.validators";
import { sha256Hex } from "./electronic-invoice.domain";
import { EINVOICE_BILLING_FRAMES } from "./electronic-invoice-regulatory.domain";

type ReportingConfiguration = {
  taxDueDateTypeCode: string;
  businessProcessTypeId: string;
};

type ReportingSource = {
  sourceType: EReportingTransactionBody["source_type"];
  factureId: number | null;
  avoirId: number | null;
  supplierInvoiceId: string | null;
  companyRole: "SELLER" | "BUYER";
  transactionDate: string;
  partnerCountryCode: string;
  partnerIdentifier: string;
  documentNumber: string;
  documentType: "INVOICE" | "CREDIT_NOTE";
  currency: string;
  totalWithoutVat: string;
  totalVat: string;
  totalWithVat: string;
  vatBreakdown: Array<Record<string, unknown>>;
  sourceSnapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function countryCode(value: unknown): string {
  const raw = text(value)?.toUpperCase() ?? "";
  const aliases: Record<string, string> = {
    ALLEMAGNE: "DE", GERMANY: "DE", BELGIQUE: "BE", BELGIUM: "BE", ESPAGNE: "ES", SPAIN: "ES",
    ITALIE: "IT", ITALY: "IT", SUISSE: "CH", SWITZERLAND: "CH", "ROYAUME-UNI": "GB", "UNITED KINGDOM": "GB",
  };
  const normalized = /^[A-Z]{2}$/.test(raw) ? raw : aliases[raw];
  if (!normalized || normalized === "FR") {
    throw new HttpError(422, "EREPORTING_FOREIGN_COUNTRY_REQUIRED", "Le pays étranger ISO du partenaire doit être qualifié.");
  }
  return normalized;
}

function money(value: unknown, field: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(422, "EREPORTING_AMOUNT_INVALID", `Le montant ${field} est invalide.`);
  return number.toFixed(2);
}

function normalizeVatBreakdown(items: readonly Readonly<Record<string, unknown>>[]): Array<Record<string, unknown>> {
  const groups = new Map<string, { category: string; rate: string; taxableCents: number; taxCents: number }>();
  for (const item of items) {
    const rateValue = item.rate ?? item.vat_category_rate;
    const rateNumber = Number(rateValue);
    if (!Number.isFinite(rateNumber) || rateNumber < 0 || rateNumber > 100) {
      throw new HttpError(422, "EREPORTING_VAT_RATE_REQUIRED", "Chaque ventilation doit comporter un taux de TVA valide.");
    }
    const rate = Number(rateNumber.toFixed(4)).toString();
    const explicitCategory = text(item.category ?? item.vat_category_code)?.toUpperCase() ?? null;
    const category = explicitCategory ?? (rateNumber > 0 ? "S" : null);
    if (!category || !/^[A-Z]{1,3}$/.test(category)) {
      throw new HttpError(
        422,
        "EREPORTING_VAT_CATEGORY_REQUIRED",
        "La catégorie fiscale doit être explicitement qualifiée pour un taux nul ou exonéré."
      );
    }
    const taxable = Number(item.taxable_amount ?? item.vat_category_taxable_amount);
    const tax = Number(item.tax_amount ?? item.vat_category_tax_amount);
    if (!Number.isFinite(taxable) || !Number.isFinite(tax)) {
      throw new HttpError(422, "EREPORTING_VAT_AMOUNT_INVALID", "La ventilation TVA contient un montant invalide.");
    }
    const key = `${category}:${rate}`;
    const current = groups.get(key) ?? { category, rate, taxableCents: 0, taxCents: 0 };
    current.taxableCents += Math.round(taxable * 100);
    current.taxCents += Math.round(tax * 100);
    groups.set(key, current);
  }
  if (groups.size === 0) {
    throw new HttpError(422, "EREPORTING_VAT_BREAKDOWN_REQUIRED", "Une ventilation TVA est obligatoire pour l'e-reporting.");
  }
  return [...groups.values()].map((group) => ({
    category: group.category,
    rate: group.rate,
    taxable_amount: (group.taxableCents / 100).toFixed(2),
    tax_amount: (group.taxCents / 100).toFixed(2),
  }));
}

function transactionPayload(params: {
  direction: "in" | "out";
  number: string;
  issueDate: string;
  dueDate: string | null;
  documentType: "INVOICE" | "CREDIT_NOTE";
  currency: string;
  billingFrameCode: string;
  issuer: Record<string, unknown>;
  partner: Record<string, unknown>;
  partnerCountryCode: string;
  partnerIdentifier: string;
  totals: { net: string; tax: string };
  vatBreakdown: Array<Record<string, unknown>>;
  configuration: ReportingConfiguration;
}): Record<string, unknown> {
  const issuerCountry = text(params.issuer.country)?.toUpperCase() ?? "";
  if (!new Set(["FR", "FRANCE"]).has(issuerCountry)) {
    throw new HttpError(422, "EREPORTING_ISSUER_COUNTRY_INVALID", "L'entreprise déclarante doit être identifiée en France.");
  }
  const issuerSiren = text(params.issuer.siren) ?? text(params.issuer.siret)?.slice(0, 9) ?? "";
  if (!/^\d{9}$/.test(issuerSiren)) {
    throw new HttpError(422, "EREPORTING_ISSUER_SIREN_REQUIRED", "Le SIREN de l'entreprise déclarante est obligatoire.");
  }
  const frenchParty = {
    country: "FR",
    company_id: issuerSiren,
    company_id_scheme_id: "0002",
    ...(text(params.issuer.vat_number) ? { tax_registration_id: text(params.issuer.vat_number), tax_registration_id_qualifying_id: "VA" } : {}),
  };
  const partnerVat = text(params.partner.vat_number) ?? text(params.partner.vat_identifier);
  const foreignParty = {
    country: params.partnerCountryCode,
    company_id: params.partnerIdentifier,
    ...(partnerVat
      ? { tax_registration_id: partnerVat, tax_registration_id_qualifying_id: "VA" }
      : {}),
  };
  return {
    direction: params.direction,
    number: params.number,
    issue_date: params.issueDate,
    ...(params.dueDate ? { due_date: params.dueDate } : {}),
    type_code: params.documentType === "CREDIT_NOTE" ? "381" : "380",
    tax_due_date_type_code: params.configuration.taxDueDateTypeCode,
    notes: [],
    business_process: { id: params.billingFrameCode, type_id: params.configuration.businessProcessTypeId },
    seller: params.direction === "out" ? frenchParty : foreignParty,
    buyer: params.direction === "out" ? foreignParty : frenchParty,
    currency_code: params.currency,
    total: { currency_code: params.currency, tax_exclusive_amount: params.totals.net, tax_amount: params.totals.tax },
    tax_subtotals: params.vatBreakdown.map((item) => ({
      taxable_amount: money(item.taxable_amount, "base TVA"),
      tax_amount: money(item.tax_amount, "TVA"),
      tax_category: {
        code: String(item.category),
        percent: String(item.rate),
      },
    })),
  };
}

async function loadCustomerInvoice(
  client: PoolClient,
  sourceId: number,
  expectedVersion: number,
  configuration: ReportingConfiguration
): Promise<ReportingSource> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT f.*,f.date_emission::text,f.date_echeance::text
       FROM public.facture f WHERE f.id=$1 FOR UPDATE`, [sourceId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
  if (Number(row.row_version) !== expectedVersion) throw new HttpError(409, "EREPORTING_CONCURRENT_MODIFICATION", "La facture a changé.");
  if (row.document_status !== "ISSUED" || row.transaction_scope !== "FOREIGN_B2B") {
    throw new HttpError(422, "EREPORTING_SOURCE_NOT_ELIGIBLE", "La facture doit être émise et classée FOREIGN_B2B.");
  }
  const issuer = record(row.issuer_snapshot);
  const partner = record(row.client_snapshot);
  const address = record(partner.billing_address);
  const partnerCountryCode = countryCode(address.country);
  const partnerIdentifier = text(partner.vat_number) ?? text(partner.foreign_legal_identifier) ?? "";
  if (!partnerIdentifier) throw new HttpError(422, "EREPORTING_PARTNER_IDENTIFIER_REQUIRED", "L'identifiant légal étranger du client est obligatoire.");
  const lines = await client.query<Record<string, unknown>>(
    `SELECT taux_tva::text AS rate,SUM(total_ht)::text AS taxable_amount,
            SUM(total_ttc-total_ht)::text AS tax_amount
       FROM public.facture_ligne WHERE facture_id=$1 GROUP BY taux_tva ORDER BY taux_tva`, [sourceId]
  );
  const vatBreakdown = normalizeVatBreakdown(lines.rows);
  const payload = transactionPayload({
    direction: "out", number: String(row.numero), issueDate: String(row.date_emission),
    dueDate: row.date_echeance == null ? null : String(row.date_echeance), documentType: "INVOICE",
    currency: String(row.currency).toUpperCase(), billingFrameCode: String(row.billing_frame_code),
    issuer, partner, partnerCountryCode, partnerIdentifier,
    totals: { net: money(row.total_ht, "HT"), tax: money(row.total_tax, "TVA") }, vatBreakdown, configuration,
  });
  return {
    sourceType: "CUSTOMER_INVOICE", factureId: sourceId, avoirId: null, supplierInvoiceId: null,
    companyRole: "SELLER", transactionDate: String(row.date_emission), partnerCountryCode, partnerIdentifier,
    documentNumber: String(row.numero), documentType: "INVOICE", currency: String(row.currency).toUpperCase(),
    totalWithoutVat: money(row.total_ht, "HT"), totalVat: money(row.total_tax, "TVA"),
    totalWithVat: money(row.total_ttc, "TTC"), vatBreakdown,
    sourceSnapshot: { issuer, partner, regulatory: row.regulatory_snapshot, lines: lines.rows }, payload,
  };
}

async function loadCustomerCreditNote(
  client: PoolClient,
  sourceId: number,
  expectedVersion: number,
  configuration: ReportingConfiguration
): Promise<ReportingSource> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT a.*,a.date_emission::text FROM public.avoir a WHERE a.id=$1 FOR UPDATE`, [sourceId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir introuvable.");
  if (Number(row.row_version) !== expectedVersion) throw new HttpError(409, "EREPORTING_CONCURRENT_MODIFICATION", "L'avoir a changé.");
  if (row.statut !== "ISSUED" || row.transaction_scope !== "FOREIGN_B2B") {
    throw new HttpError(422, "EREPORTING_SOURCE_NOT_ELIGIBLE", "L'avoir doit être émis et classé FOREIGN_B2B.");
  }
  const immutable = record(row.immutable_snapshot);
  const issuer = record(row.issuer_snapshot);
  const partner = record(row.client_snapshot);
  const address = record(partner.billing_address);
  const totals = record(immutable.totals);
  const rawLines = Array.isArray(immutable.lines) ? immutable.lines.map(record) : [];
  const vatBreakdown = normalizeVatBreakdown(rawLines.map((line) => ({
    rate: line.tax_rate_percent, taxable_amount: line.total_ex_tax,
    tax_amount: Number(line.total_incl_tax) - Number(line.total_ex_tax),
  })));
  const partnerCountryCode = countryCode(address.country);
  const partnerIdentifier = text(partner.vat_number) ?? text(partner.foreign_legal_identifier) ?? "";
  if (!partnerIdentifier) throw new HttpError(422, "EREPORTING_PARTNER_IDENTIFIER_REQUIRED", "L'identifiant légal étranger du client est obligatoire.");
  const payload = transactionPayload({
    direction: "out", number: String(row.numero), issueDate: String(row.date_emission), dueDate: null,
    documentType: "CREDIT_NOTE", currency: String(row.currency).toUpperCase(),
    billingFrameCode: String(row.billing_frame_code), issuer, partner, partnerCountryCode, partnerIdentifier,
    totals: { net: money(totals.total_ex_tax, "HT"), tax: money(totals.total_tax, "TVA") },
    vatBreakdown, configuration,
  });
  return {
    sourceType: "CUSTOMER_CREDIT_NOTE", factureId: null, avoirId: sourceId, supplierInvoiceId: null,
    companyRole: "SELLER", transactionDate: String(row.date_emission), partnerCountryCode, partnerIdentifier,
    documentNumber: String(row.numero), documentType: "CREDIT_NOTE", currency: String(row.currency).toUpperCase(),
    totalWithoutVat: money(totals.total_ex_tax, "HT"), totalVat: money(totals.total_tax, "TVA"),
    totalWithVat: money(totals.total_incl_tax, "TTC"), vatBreakdown,
    sourceSnapshot: { issuer, partner, regulatory: row.regulatory_snapshot, immutable }, payload,
  };
}

async function loadSupplierInvoice(
  client: PoolClient,
  sourceId: string,
  expectedVersion: number,
  configuration: ReportingConfiguration
): Promise<ReportingSource> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT si.* FROM public.supplier_invoices si WHERE si.id=$1::uuid FOR UPDATE`, [sourceId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "SUPPLIER_INVOICE_NOT_FOUND", "Facture fournisseur introuvable.");
  if (Number(row.row_version) !== expectedVersion) throw new HttpError(409, "EREPORTING_CONCURRENT_MODIFICATION", "La facture fournisseur a changé.");
  if (!["APPROVED", "ACCOUNTING_EXPORTED", "CLOSED"].includes(String(row.status))) {
    throw new HttpError(422, "EREPORTING_SOURCE_NOT_ELIGIBLE", "La facture fournisseur doit être approuvée avant e-reporting.");
  }
  const seller = record(row.seller_snapshot);
  const sellerAddress = record(seller.postal_address);
  const buyer = record(row.buyer_snapshot);
  const partnerCountryCode = countryCode(sellerAddress.country_code ?? sellerAddress.country);
  const legal = record(seller.legal_registration_identifier);
  const partnerIdentifier = text(seller.vat_identifier) ?? text(legal.value) ?? "";
  if (!partnerIdentifier) throw new HttpError(422, "EREPORTING_PARTNER_IDENTIFIER_REQUIRED", "L'identifiant légal étranger du fournisseur est obligatoire.");
  const vatBreakdown = normalizeVatBreakdown(
    Array.isArray(row.vat_breakdown) ? row.vat_breakdown.map(record) : []
  );
  const sourceSnapshot = record(row.source_snapshot);
  const processControl = record(sourceSnapshot.process_control);
  const billingFrameCode = text(processControl.business_process_type);
  if (!billingFrameCode || !Object.prototype.hasOwnProperty.call(EINVOICE_BILLING_FRAMES, billingFrameCode)) {
    throw new HttpError(
      422,
      "EREPORTING_BILLING_FRAME_REQUIRED",
      "Le cadre de facturation BT-23 reçu du fournisseur doit être qualifié avant e-reporting."
    );
  }
  const buyerLegal = record(buyer.legal_registration_identifier);
  const issuer = {
    country: "FR",
    siren: text(buyer.siren) ?? text(buyerLegal.value)?.replace(/\D/g, "").slice(0, 9),
    vat_number: buyer.vat_identifier,
  };
  const payload = transactionPayload({
    direction: "in", number: String(row.legal_number), issueDate: String(row.issue_date).slice(0, 10), dueDate: null,
    documentType: row.document_type === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
    currency: String(row.currency), billingFrameCode, issuer, partner: seller,
    partnerCountryCode, partnerIdentifier,
    totals: { net: money(row.total_without_vat, "HT"), tax: money(row.total_vat, "TVA") },
    vatBreakdown, configuration,
  });
  return {
    sourceType: "SUPPLIER_INVOICE", factureId: null, avoirId: null, supplierInvoiceId: sourceId,
    companyRole: "BUYER", transactionDate: String(row.issue_date).slice(0, 10), partnerCountryCode, partnerIdentifier,
    documentNumber: String(row.legal_number), documentType: row.document_type === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
    currency: String(row.currency), totalWithoutVat: money(row.total_without_vat, "HT"),
    totalVat: money(row.total_vat, "TVA"), totalWithVat: money(row.total_with_vat, "TTC"),
    vatBreakdown, sourceSnapshot: { seller, buyer, source: sourceSnapshot }, payload,
  };
}

async function existingCommand(client: PoolClient, actorId: number, key: string, requestHash: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ereport:${actorId}:${key}`]);
  const result = await client.query<{ request_hash: string; result_payload: Record<string, unknown> }>(
    `SELECT request_hash,result_payload FROM public.einvoice_reporting_command_receipts
      WHERE actor_user_id=$1 AND idempotency_key=$2`, [actorId, key]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a déjà été utilisée avec un autre contenu.");
  return row.result_payload;
}

function validKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 200) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key est obligatoire.");
  return key;
}

export async function repoCreateEReportingTransaction(params: {
  body: EReportingTransactionBody;
  actor: FinanceActorContext;
  idempotencyKey: string;
  configuration: ReportingConfiguration;
  providerCode: string;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const key = validKey(params.idempotencyKey);
    const requestHash = sha256Hex(canonicalJson(params.body));
    const replay = await existingCommand(client, params.actor.userId, key, requestHash);
    if (replay) { await client.query("COMMIT"); return { ...replay, idempotent_replay: true }; }
    const source = params.body.source_type === "CUSTOMER_INVOICE"
      ? await loadCustomerInvoice(client, Number(params.body.source_id), params.body.expected_version, params.configuration)
      : params.body.source_type === "CUSTOMER_CREDIT_NOTE"
        ? await loadCustomerCreditNote(client, Number(params.body.source_id), params.body.expected_version, params.configuration)
        : await loadSupplierInvoice(client, String(params.body.source_id), params.body.expected_version, params.configuration);
    const payloadSha256 = sha256Hex(canonicalJson(source.payload));
    const period = await client.query<{ id: string }>(
      `SELECT id::text FROM public.einvoice_reporting_periods
        WHERE reporting_kind='TRANSACTION' AND company_role=$1 AND provider_code=$2
          AND $3::date BETWEEN period_start AND period_end
        ORDER BY period_start DESC LIMIT 1`,
      [source.companyRole, params.providerCode, source.transactionDate]
    );
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO public.einvoice_reporting_transactions(
         period_id,source_type,facture_id,avoir_id,supplier_invoice_id,company_role,transaction_date,
         partner_country_code,partner_identifier,document_number,document_type,currency,
         total_without_vat,total_vat,total_with_vat,vat_breakdown,source_snapshot,payload,payload_sha256,created_by
       ) VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20)
       ON CONFLICT DO NOTHING RETURNING id::text,status,row_version,created_at::text`,
      [period.rows[0]?.id ?? null,source.sourceType,source.factureId,source.avoirId,source.supplierInvoiceId,source.companyRole,source.transactionDate,
       source.partnerCountryCode,source.partnerIdentifier,source.documentNumber,source.documentType,source.currency,
       source.totalWithoutVat,source.totalVat,source.totalWithVat,JSON.stringify(source.vatBreakdown),
       JSON.stringify(source.sourceSnapshot),JSON.stringify(source.payload),payloadSha256,params.actor.userId]
    );
    const row = inserted.rows[0];
    if (!row) throw new HttpError(409, "EREPORTING_SOURCE_ALREADY_REGISTERED", "Cette source possède déjà un e-reporting initial.");
    const response = { ...row, source_type: source.sourceType, payload_sha256: payloadSha256 };
    await client.query(
      `INSERT INTO public.einvoice_reporting_command_receipts(actor_user_id,idempotency_key,command_type,request_hash,result_payload)
       VALUES ($1,$2,'REPORT_TRANSACTION',$3,$4::jsonb)`,
      [params.actor.userId,key,requestHash,JSON.stringify(response)]
    );
    await client.query("COMMIT");
    return { ...response, idempotent_replay: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function repoCreateEReportingPayment(params: {
  body: EReportingPaymentBody;
  actor: FinanceActorContext;
  idempotencyKey: string;
  providerCode: string;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const key = validKey(params.idempotencyKey);
    const requestHash = sha256Hex(canonicalJson(params.body));
    const replay = await existingCommand(client, params.actor.userId, key, requestHash);
    if (replay) { await client.query("COMMIT"); return { ...replay, idempotent_replay: true }; }
    const result = await client.query<Record<string, unknown>>(
      `SELECT p.row_version,p.date_paiement::text,p.currency,p.status,pa.amount_ttc::text,
              f.numero,f.date_emission::text,f.transaction_scope,f.operation_category,f.immutable_snapshot
         FROM public.paiement p
         JOIN public.paiement_allocations pa ON pa.paiement_id=p.id AND pa.facture_id=$2
         JOIN public.facture f ON f.id=pa.facture_id
        WHERE p.id=$1 FOR UPDATE OF p,f`, [params.body.paiement_id, params.body.facture_id]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "EREPORTING_PAYMENT_ALLOCATION_NOT_FOUND", "Affectation de paiement introuvable.");
    if (Number(row.row_version) !== params.body.expected_version) throw new HttpError(409, "EREPORTING_CONCURRENT_MODIFICATION", "Le paiement a changé.");
    if (row.status === "REVERSED" || row.transaction_scope !== "FOREIGN_B2B" || row.operation_category !== "SERVICES") {
      throw new HttpError(422, "EREPORTING_PAYMENT_NOT_ELIGIBLE", "Seuls les encaissements non annulés de prestations étrangères explicitement qualifiées sont déclarables.");
    }
    const snapshot = record(row.immutable_snapshot);
    const rawLines = Array.isArray(snapshot.lines) ? snapshot.lines.map(record) : [];
    const grossByRate = new Map<string, number>();
    for (const line of rawLines) {
      const rateValue = line.vat_rate ?? line.tax_rate_percent;
      const rateNumber = Number(rateValue);
      const grossNumber = Number(line.total_incl_tax);
      if (!Number.isFinite(rateNumber) || rateNumber < 0 || rateNumber > 100 || !Number.isFinite(grossNumber)) {
        throw new HttpError(422, "EREPORTING_PAYMENT_VAT_BREAKDOWN_INVALID", "La facture ne permet pas de ventiler l'encaissement par taux de TVA.");
      }
      const rate = Number(rateNumber.toFixed(4)).toString();
      grossByRate.set(rate, (grossByRate.get(rate) ?? 0) + Math.round(grossNumber * 100));
    }
    const grossTotalCents = [...grossByRate.values()].reduce((sum, cents) => sum + cents, 0);
    const allocatedCents = Math.round(Number(row.amount_ttc) * 100);
    if (grossTotalCents <= 0 || allocatedCents <= 0 || allocatedCents > grossTotalCents) {
      throw new HttpError(422, "EREPORTING_PAYMENT_AMOUNT_INVALID", "La ventilation du paiement est invalide.");
    }
    const rates = [...grossByRate.entries()];
    let remaining = allocatedCents;
    const subtotals = rates.map(([rate, grossCents], index) => {
      const cents = index === rates.length - 1
        ? remaining
        : Math.round(allocatedCents * grossCents / grossTotalCents);
      remaining -= cents;
      return { tax_percent: rate, amount: (cents / 100).toFixed(2), currency_code: String(row.currency) };
    });
    const payload = {
      invoice_number: String(row.numero), payment_date: String(row.date_paiement), subtotals,
    };
    const payloadSha256 = sha256Hex(canonicalJson(payload));
    const period = await client.query<{ id: string }>(
      `SELECT id::text FROM public.einvoice_reporting_periods
        WHERE reporting_kind='PAYMENT' AND company_role='SELLER' AND provider_code=$1
          AND $2::date BETWEEN period_start AND period_end
        ORDER BY period_start DESC LIMIT 1`,
      [params.providerCode, row.date_paiement]
    );
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO public.einvoice_reporting_payments(
         period_id,paiement_id,facture_id,payment_date,currency,allocated_amount,vat_breakdown,
         source_snapshot,payload,payload_sha256,created_by
       ) VALUES ($1::uuid,$2,$3,$4::date,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
       ON CONFLICT DO NOTHING RETURNING id::text,status,row_version,created_at::text`,
      [period.rows[0]?.id ?? null,params.body.paiement_id,params.body.facture_id,row.date_paiement,row.currency,row.amount_ttc,
       JSON.stringify(subtotals),JSON.stringify({ payment: row, invoice: snapshot }),JSON.stringify(payload),
       payloadSha256,params.actor.userId]
    );
    const created = inserted.rows[0];
    if (!created) throw new HttpError(409, "EREPORTING_PAYMENT_ALREADY_REGISTERED", "Ce paiement possède déjà un e-reporting initial.");
    const response = { ...created, payload_sha256: payloadSha256 };
    await client.query(
      `INSERT INTO public.einvoice_reporting_command_receipts(actor_user_id,idempotency_key,command_type,request_hash,result_payload)
       VALUES ($1,$2,'REPORT_PAYMENT',$3,$4::jsonb)`,
      [params.actor.userId,key,requestHash,JSON.stringify(response)]
    );
    await client.query("COMMIT");
    return { ...response, idempotent_replay: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function repoListEReportingPeriods(query: EReportingPeriodsQuery) {
  const values: unknown[] = [];
  const where: string[] = ["1=1"];
  if (query.kind) { values.push(query.kind); where.push(`reporting_kind=$${values.length}`); }
  if (query.role) { values.push(query.role); where.push(`company_role=$${values.length}`); }
  values.push(query.limit);
  const result = await pool.query(
    `SELECT period.id::text,period.reporting_kind,period.company_role,period.period_start::text,period.period_end::text,period.status,
            period.provider_code,period.provider_reporting_id,period.row_version,period.last_submitted_at::text,period.updated_at::text,
            CASE WHEN period.reporting_kind='TRANSACTION' THEN (SELECT count(*)::int FROM public.einvoice_reporting_transactions item WHERE item.period_id=period.id AND item.status IN ('PENDING','SENDING'))
                 ELSE (SELECT count(*)::int FROM public.einvoice_reporting_payments item WHERE item.period_id=period.id AND item.status IN ('PENDING','SENDING')) END AS pending_count,
            CASE WHEN period.reporting_kind='TRANSACTION' THEN (SELECT count(*)::int FROM public.einvoice_reporting_transactions item WHERE item.period_id=period.id AND item.status='SENT')
                 ELSE (SELECT count(*)::int FROM public.einvoice_reporting_payments item WHERE item.period_id=period.id AND item.status='SENT') END AS sent_count,
            CASE WHEN period.reporting_kind='TRANSACTION' THEN (SELECT count(*)::int FROM public.einvoice_reporting_transactions item WHERE item.period_id=period.id AND item.status='REJECTED')
                 ELSE (SELECT count(*)::int FROM public.einvoice_reporting_payments item WHERE item.period_id=period.id AND item.status='REJECTED') END AS rejected_count
       FROM public.einvoice_reporting_periods period WHERE ${where.join(" AND ")}
       ORDER BY period_start DESC,reporting_kind,company_role LIMIT $${values.length}`,
    values
  );
  return { data: result.rows };
}

export async function repoObserveEReportingPeriods(params: {
  providerCode: string;
  periods: readonly Readonly<Record<string, unknown>>[];
}): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let observed = 0;
    for (const providerPeriod of params.periods) {
      const providerId = String(providerPeriod.id ?? "");
      const kind = providerPeriod.kind === "transaction" ? "TRANSACTION"
        : providerPeriod.kind === "payment" ? "PAYMENT" : null;
      const role = providerPeriod.role_code === "SE" ? "SELLER"
        : providerPeriod.role_code === "BY" ? "BUYER" : null;
      const start = text(providerPeriod.start_period);
      const end = text(providerPeriod.end_period);
      if (!providerId || !kind || !role || !start || !end) {
        throw new Error("SUPERPDP returned an incomplete e-reporting period");
      }
      const period = await client.query<{ id: string }>(
        `INSERT INTO public.einvoice_reporting_periods(
           reporting_kind,company_role,period_start,period_end,provider_code,provider_reporting_id
         ) VALUES ($1,$2,$3::date,$4::date,$5,$6)
         ON CONFLICT (reporting_kind,company_role,period_start,period_end,provider_code)
         DO UPDATE SET provider_reporting_id=EXCLUDED.provider_reporting_id,
                       row_version=CASE
                         WHEN public.einvoice_reporting_periods.provider_reporting_id IS DISTINCT FROM EXCLUDED.provider_reporting_id
                         THEN public.einvoice_reporting_periods.row_version+1
                         ELSE public.einvoice_reporting_periods.row_version
                       END,
                       updated_at=CASE
                         WHEN public.einvoice_reporting_periods.provider_reporting_id IS DISTINCT FROM EXCLUDED.provider_reporting_id
                         THEN now()
                         ELSE public.einvoice_reporting_periods.updated_at
                       END
         RETURNING id::text`,
        [kind, role, start, end, params.providerCode, providerId]
      );
      const payloadSha256 = sha256Hex(canonicalJson(providerPeriod));
      if (kind === "TRANSACTION") {
        await client.query(
          `UPDATE public.einvoice_reporting_transactions
              SET period_id=$1::uuid,row_version=row_version+1,updated_at=now()
            WHERE period_id IS NULL AND company_role=$2
              AND transaction_date BETWEEN $3::date AND $4::date`,
          [period.rows[0]!.id, role, start, end]
        );
      } else if (role === "SELLER") {
        await client.query(
          `UPDATE public.einvoice_reporting_payments
              SET period_id=$1::uuid,row_version=row_version+1,updated_at=now()
            WHERE period_id IS NULL AND payment_date BETWEEN $2::date AND $3::date`,
          [period.rows[0]!.id, start, end]
        );
      }
      const receipt = await client.query(
        `INSERT INTO public.einvoice_reporting_receipts(
           reporting_kind,period_id,provider_code,provider_receipt_id,outcome,payload_sha256,receipt,occurred_at
         ) VALUES ('PERIOD',$1::uuid,$2,$3,'OBSERVED',$4,$5::jsonb,now())
         ON CONFLICT (reporting_kind,provider_code,payload_sha256) DO NOTHING`,
        [period.rows[0]!.id, params.providerCode, providerId, payloadSha256, JSON.stringify(providerPeriod)]
      );
      observed += receipt.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return observed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoClaimEReporting(kind: "TRANSACTION" | "PAYMENT") {
  const table = kind === "TRANSACTION" ? "einvoice_reporting_transactions" : "einvoice_reporting_payments";
  const result = await pool.query<Record<string, unknown>>(
    `WITH candidate AS (
       SELECT id FROM public.${table}
        WHERE ((status IN ('PENDING','REJECTED') AND next_attempt_at<=now())
           OR (status='SENDING' AND updated_at<now()-interval '15 minutes'))
        ORDER BY next_attempt_at NULLS FIRST,created_at FOR UPDATE SKIP LOCKED LIMIT 1
     ) UPDATE public.${table} t SET status='SENDING',attempt_count=attempt_count+1,updated_at=now(),next_attempt_at=NULL
       FROM candidate WHERE t.id=candidate.id RETURNING t.id::text,t.payload,t.payload_sha256,t.attempt_count`
  );
  return result.rows[0] ?? null;
}

export async function repoCompleteEReporting(params: {
  kind: "TRANSACTION" | "PAYMENT";
  id: string;
  providerCode: string;
  providerItemId: string;
  payloadSha256: string;
  receipt: Record<string, unknown>;
}) {
  const table = params.kind === "TRANSACTION" ? "einvoice_reporting_transactions" : "einvoice_reporting_payments";
  const foreignKey = params.kind === "TRANSACTION" ? "transaction_id" : "payment_id";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(`UPDATE public.${table} SET status='SENT',provider_item_id=$2,updated_at=now(),last_error_code=NULL WHERE id=$1::uuid AND status='SENDING'`, [params.id,params.providerItemId]);
    if (updated.rowCount !== 1) {
      throw new Error(`E-reporting ${params.kind} ${params.id} is not in SENDING state`);
    }
    await client.query(
      `INSERT INTO public.einvoice_reporting_receipts(reporting_kind,${foreignKey},provider_code,provider_receipt_id,outcome,payload_sha256,receipt,occurred_at)
       VALUES ($1,$2::uuid,$3,$4,'ACCEPTED',$5,$6::jsonb,now())`,
      [params.kind,params.id,params.providerCode,params.providerItemId,params.payloadSha256,JSON.stringify(params.receipt)]
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function repoFailEReporting(kind: "TRANSACTION" | "PAYMENT", id: string, code: string, attempt: number, retryable: boolean) {
  const table = kind === "TRANSACTION" ? "einvoice_reporting_transactions" : "einvoice_reporting_payments";
  const delay = Math.min(3600, 30 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
  await pool.query(
    `UPDATE public.${table} SET status='REJECTED',last_error_code=$2,
            next_attempt_at=CASE WHEN $4::boolean THEN now()+make_interval(secs=>$3) ELSE NULL END,
            updated_at=now()
      WHERE id=$1::uuid AND status='SENDING'`, [id,code.slice(0,120),delay,retryable]
  );
}
