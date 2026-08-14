import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

export const DGFiP_EINVOICE_SPEC_VERSION = "DGFiP-FE-V3.2-2026-04-30" as const;

export const ELECTRONIC_INVOICE_FORMATS = ["UBL", "CII", "FACTUR_X"] as const;
export type ElectronicInvoiceFormat = (typeof ELECTRONIC_INVOICE_FORMATS)[number];

export const ELECTRONIC_INVOICE_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;
export type ElectronicInvoiceDirection = (typeof ELECTRONIC_INVOICE_DIRECTIONS)[number];

export const ELECTRONIC_INVOICE_DOCUMENT_TYPES = ["INVOICE", "CREDIT_NOTE"] as const;
export type ElectronicInvoiceDocumentType = (typeof ELECTRONIC_INVOICE_DOCUMENT_TYPES)[number];

export const DGFiP_INVOICE_STATUSES = {
  200: { label: "Déposée", mandatory: true },
  201: { label: "Émise par la plateforme", mandatory: false },
  202: { label: "Reçue par la plateforme", mandatory: false },
  203: { label: "Mise à disposition", mandatory: false },
  204: { label: "Prise en charge", mandatory: false },
  205: { label: "Approuvée", mandatory: false },
  206: { label: "Approuvée partiellement", mandatory: false },
  207: { label: "En litige", mandatory: false },
  208: { label: "Suspendue", mandatory: false },
  209: { label: "Complétée", mandatory: false },
  210: { label: "Refusée", mandatory: true },
  211: { label: "Paiement transmis", mandatory: false },
  212: { label: "Encaissée", mandatory: true },
  213: { label: "Rejetée", mandatory: true },
} as const;

export type DGFiPInvoiceStatusCode = keyof typeof DGFiP_INVOICE_STATUSES;

export const DGFiP_REJECTION_CODES = [
  "REJ_SEMAN",
  "REJ_UNI",
  "REJ_COH",
  "REJ_INC",
  "REJ_INEX",
  "REJ_RG",
  "REJ_HAB",
  "REJ_ENCAISSEMENT",
] as const;

export type DGFiPRejectionCode = (typeof DGFiP_REJECTION_CODES)[number];

export function parseDGFiPInvoiceStatusCode(value: unknown): DGFiPInvoiceStatusCode {
  const parsed = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !(parsed in DGFiP_INVOICE_STATUSES)) {
    throw new HttpError(
      422,
      "EINVOICE_STATUS_UNSUPPORTED",
      "Le prestataire a retourné un statut de facture électronique non reconnu."
    );
  }
  return parsed as DGFiPInvoiceStatusCode;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|secret|key|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL_REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
}

export function sanitizedProviderError(params: {
  code: unknown;
  message: unknown;
}): { code: string; message: string } {
  const code = typeof params.code === "string" && /^[A-Z0-9_.:-]{1,80}$/i.test(params.code)
    ? params.code
    : "PROVIDER_ERROR";
  const message = typeof params.message === "string"
    ? redactSensitiveText(params.message)
    : "Le prestataire a refusé ou interrompu le traitement.";
  return { code, message: message || "Le prestataire a refusé ou interrompu le traitement." };
}

export type RetryDecision = {
  retryable: boolean;
  reason: "RATE_LIMIT" | "TRANSIENT" | "TIMEOUT" | "PERMANENT";
  delaySeconds: number | null;
};

export function classifyProviderFailure(params: {
  httpStatus: number | null;
  attempt: number;
  retryAfterSeconds?: number | null;
}): RetryDecision {
  const attempt = Math.max(1, Math.min(12, Math.trunc(params.attempt)));
  const retryAfter = params.retryAfterSeconds == null
    ? null
    : Math.max(1, Math.min(3600, Math.trunc(params.retryAfterSeconds)));
  if (params.httpStatus === 429) {
    return { retryable: true, reason: "RATE_LIMIT", delaySeconds: retryAfter ?? Math.min(3600, 30 * 2 ** (attempt - 1)) };
  }
  if (params.httpStatus === null || params.httpStatus === 408 || params.httpStatus === 425) {
    return { retryable: true, reason: "TIMEOUT", delaySeconds: Math.min(3600, 30 * 2 ** (attempt - 1)) };
  }
  if (params.httpStatus >= 500) {
    return { retryable: true, reason: "TRANSIENT", delaySeconds: Math.min(3600, 30 * 2 ** (attempt - 1)) };
  }
  return { retryable: false, reason: "PERMANENT", delaySeconds: null };
}

export function verifyHmacSha256Webhook(params: {
  body: Buffer;
  signatureHeader: string | undefined;
  secret: string;
  nowEpochSeconds?: number;
  toleranceSeconds?: number;
}): { timestamp: number; signature: string } {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(params.signatureHeader?.trim() ?? "");
  if (!match) {
    throw new HttpError(401, "EINVOICE_WEBHOOK_SIGNATURE_INVALID", "Signature de webhook invalide.");
  }
  const timestamp = Number.parseInt(match[1] ?? "", 10);
  const now = params.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = params.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    throw new HttpError(401, "EINVOICE_WEBHOOK_EXPIRED", "Webhook expiré ou horodatage invalide.");
  }
  const expected = crypto
    .createHmac("sha256", params.secret)
    .update(`${timestamp}.`)
    .update(params.body)
    .digest("hex");
  const received = match[2]?.toLowerCase() ?? "";
  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
  ) {
    throw new HttpError(401, "EINVOICE_WEBHOOK_SIGNATURE_INVALID", "Signature de webhook invalide.");
  }
  return { timestamp, signature: received };
}

export type ElectronicInvoiceProviderEvent = {
  providerEventId: string;
  providerDocumentId: string;
  direction: ElectronicInvoiceDirection;
  documentType: ElectronicInvoiceDocumentType;
  format: ElectronicInvoiceFormat;
  invoiceId: number | null;
  creditNoteId: number | null;
  documentSha256: string | null;
  contentStorageReference: string | null;
  attachments: ReadonlyArray<{
    filename: string;
    contentType: string;
    contentSha256: string;
    storageReference: string;
  }>;
  statusCode: DGFiPInvoiceStatusCode;
  occurredAt: string;
  rejectionCode: string | null;
  rejectionMessage: string | null;
  filingProofReference: string | null;
  filingProofSha256: string | null;
};

function boundedProviderIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\r\n\t]/.test(value)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", `Champ prestataire invalide : ${field}.`);
  }
  return value;
}

function storageReference(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\s?#&]/.test(value)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", `Référence de stockage invalide : ${field}.`);
  }
  return value;
}

function nullableSha256(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", `Empreinte invalide : ${field}.`);
  }
  return value;
}

function requiredSha256(value: unknown, field: string): string {
  const hash = nullableSha256(value, field);
  if (hash === null) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", `Empreinte absente : ${field}.`);
  }
  return hash;
}

function requiredStorageReference(value: unknown, field: string): string {
  const reference = storageReference(value, field);
  if (reference === null) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", `Référence de stockage absente : ${field}.`);
  }
  return reference;
}

export function normalizeElectronicInvoiceProviderEvent(
  event: ElectronicInvoiceProviderEvent
): ElectronicInvoiceProviderEvent {
  if (!ELECTRONIC_INVOICE_DIRECTIONS.includes(event.direction)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Direction prestataire invalide.");
  }
  if (!ELECTRONIC_INVOICE_DOCUMENT_TYPES.includes(event.documentType)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Type de document prestataire invalide.");
  }
  if (!ELECTRONIC_INVOICE_FORMATS.includes(event.format)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Format prestataire invalide.");
  }
  const occurredAt = new Date(event.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Horodatage prestataire invalide.");
  }
  if (event.rejectionCode !== null && !DGFiP_REJECTION_CODES.includes(event.rejectionCode as DGFiPRejectionCode)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Code de rejet DGFiP non reconnu.");
  }
  if ((event.statusCode === 210 || event.statusCode === 213) !== (event.rejectionCode !== null)) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Le statut de rejet et son code DGFiP sont incohérents.");
  }
  if (!Array.isArray(event.attachments) || event.attachments.length > 50) {
    throw new HttpError(422, "EINVOICE_PROVIDER_EVENT_INVALID", "Métadonnées de pièces jointes invalides.");
  }
  const attachments = event.attachments.map((attachment, index) => ({
    filename: boundedProviderIdentifier(attachment.filename, `attachments[${index}].filename`),
    contentType: boundedProviderIdentifier(attachment.contentType, `attachments[${index}].contentType`),
    contentSha256: requiredSha256(attachment.contentSha256, `attachments[${index}].contentSha256`),
    storageReference: requiredStorageReference(attachment.storageReference, `attachments[${index}].storageReference`),
  }));
  const rejection = event.rejectionMessage === null
    ? null
    : sanitizedProviderError({ code: event.rejectionCode, message: event.rejectionMessage }).message;
  return {
    ...event,
    providerEventId: boundedProviderIdentifier(event.providerEventId, "providerEventId"),
    providerDocumentId: boundedProviderIdentifier(event.providerDocumentId, "providerDocumentId"),
    documentSha256: nullableSha256(event.documentSha256, "documentSha256"),
    contentStorageReference: storageReference(event.contentStorageReference, "contentStorageReference"),
    attachments,
    statusCode: parseDGFiPInvoiceStatusCode(event.statusCode),
    occurredAt: occurredAt.toISOString(),
    rejectionMessage: rejection,
    filingProofReference: event.filingProofReference === null
      ? null
      : boundedProviderIdentifier(event.filingProofReference, "filingProofReference"),
    filingProofSha256: nullableSha256(event.filingProofSha256, "filingProofSha256"),
  };
}

export type ElectronicInvoiceSubmission = {
  localDocumentId: string;
  invoiceId: number | null;
  creditNoteId: number | null;
  documentType: ElectronicInvoiceDocumentType;
  format: ElectronicInvoiceFormat;
  filename: string;
  contentType: string;
  content: Buffer;
  contentSha256: string;
  idempotencyKey: string;
  correlationId: string;
  attachments: ReadonlyArray<{
    filename: string;
    contentType: string;
    contentSha256: string;
    storageReference: string;
  }>;
};

export type ElectronicInvoiceSourceDocument = {
  invoiceId: number | null;
  creditNoteId: number | null;
  documentType: ElectronicInvoiceDocumentType;
  legalNumber: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  issuerSnapshot: Readonly<Record<string, unknown>>;
  customerSnapshot: Readonly<Record<string, unknown>>;
  lines: ReadonlyArray<Readonly<Record<string, unknown>>>;
  totals: Readonly<{
    net: string;
    tax: string;
    gross: string;
  }>;
};

export type PreparedElectronicInvoiceDocument = {
  format: ElectronicInvoiceFormat;
  filename: string;
  contentType: string;
  content: Buffer;
  attachments: ElectronicInvoiceSubmission["attachments"];
};

export type ElectronicInvoiceSubmissionReceipt = {
  providerDocumentId: string;
  providerRequestId: string | null;
  acceptedAt: string;
  statusCode: DGFiPInvoiceStatusCode;
  filingProofReference: string | null;
  filingProofSha256: string | null;
};

export interface ElectronicInvoiceProviderAdapter {
  readonly code: string;
  readonly environment: "sandbox" | "production";
  readonly supportedFormats: readonly ElectronicInvoiceFormat[];
  prepare(
    source: ElectronicInvoiceSourceDocument,
    requestedFormat: ElectronicInvoiceFormat
  ): Promise<PreparedElectronicInvoiceDocument>;
  submit(submission: ElectronicInvoiceSubmission): Promise<ElectronicInvoiceSubmissionReceipt>;
  retrieve(providerDocumentId: string, correlationId: string): Promise<ElectronicInvoiceProviderEvent>;
  verifyAndParseWebhook(params: {
    body: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
  }): Promise<ElectronicInvoiceProviderEvent>;
}

export class ElectronicInvoiceProviderRegistry {
  private readonly adapters = new Map<string, ElectronicInvoiceProviderAdapter>();

  register(adapter: ElectronicInvoiceProviderAdapter): void {
    const code = adapter.code.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(code)) {
      throw new Error("Invalid electronic invoice provider code");
    }
    if (this.adapters.has(code)) throw new Error(`Duplicate electronic invoice provider: ${code}`);
    this.adapters.set(code, adapter);
  }

  resolve(code: string): ElectronicInvoiceProviderAdapter {
    const adapter = this.adapters.get(code.trim().toLowerCase());
    if (!adapter) {
      throw new HttpError(
        503,
        "EINVOICE_PROVIDER_NOT_CONFIGURED",
        "Aucune Plateforme Agréée réelle n'est configurée. Sélectionnez et qualifiez un prestataire avant tout envoi."
      );
    }
    return adapter;
  }

  list(): ReadonlyArray<Pick<ElectronicInvoiceProviderAdapter, "code" | "environment" | "supportedFormats">> {
    return [...this.adapters.values()].map(({ code, environment, supportedFormats }) => ({
      code,
      environment,
      supportedFormats,
    }));
  }
}
