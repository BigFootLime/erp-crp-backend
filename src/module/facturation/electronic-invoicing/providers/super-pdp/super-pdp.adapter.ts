import { HttpError } from "../../../../../utils/httpError";
import {
  parseDGFiPInvoiceStatusCode,
  type DGFiPInvoiceStatusCode,
  type ElectronicInvoiceFormat,
  type ElectronicInvoiceProviderAdapter,
  type ElectronicInvoiceProviderDiagnostic,
  type ElectronicInvoiceProviderEvent,
  type ElectronicInvoiceRetrieveContext,
  type ElectronicInvoiceSourceDocument,
  type ElectronicInvoiceSubmission,
  type ElectronicInvoiceSubmissionReceipt,
  type PreparedElectronicInvoiceDocument,
} from "../../electronic-invoice.domain";
import {
  SUPER_PDP_API_CONTRACT_VERSION,
  SUPER_PDP_PROVIDER_CODE,
  SuperPdpClient,
  SuperPdpProviderError,
  loadSuperPdpConfiguration,
  type SuperPdpProviderEvent,
} from "./super-pdp.client";
import { buildSuperPdpEn16931Invoice } from "./super-pdp.en16931";

const SUPPORTED_FORMATS = ["UBL", "CII", "FACTUR_X"] as const satisfies readonly ElectronicInvoiceFormat[];
const DIAGNOSTIC_CACHE_MS = 30_000;

function officialStatus(event: SuperPdpProviderEvent): DGFiPInvoiceStatusCode | null {
  const match = /^fr:(20\d|21[0-3])$/.exec(event.status_code.trim().toLowerCase());
  return match ? parseDGFiPInvoiceStatusCode(Number(match[1])) : null;
}

function orderedEvents(events: readonly SuperPdpProviderEvent[]): SuperPdpProviderEvent[] {
  return [...events].sort((left, right) => {
    const byDate = Date.parse(left.created_at) - Date.parse(right.created_at);
    return byDate === 0 ? left.id - right.id : byDate;
  });
}

function latestOfficialEvent(events: readonly SuperPdpProviderEvent[]): SuperPdpProviderEvent | null {
  return orderedEvents(events).filter((event) => officialStatus(event) !== null).at(-1) ?? null;
}

function rejectionDetails(event: SuperPdpProviderEvent): { code: string | null; message: string | null } {
  const reason = event.details?.find((detail) => detail.reason?.trim())?.reason?.trim()
    ?? event.data?.reason?.trim()
    ?? event.status_text.trim()
    ?? null;
  if (!reason) return { code: null, message: null };
  const rawCode = /^[A-Za-z0-9_.:-]{1,80}$/.test(reason) ? reason : null;
  return { code: rawCode, message: reason.slice(0, 500) };
}

function technicalFailure(events: readonly SuperPdpProviderEvent[]): SuperPdpProviderEvent | null {
  const terminal = new Set(["api:invalid", "api:rejected", "api:error", "fr:501", "ppf:rejected"]);
  return orderedEvents(events).filter((event) => terminal.has(event.status_code.trim().toLowerCase())).at(-1) ?? null;
}

function safeFilename(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "facture").slice(0, 120);
}

export class SuperPdpAdapter implements ElectronicInvoiceProviderAdapter {
  readonly code = SUPER_PDP_PROVIDER_CODE;
  readonly environment;
  readonly supportedFormats = SUPPORTED_FORMATS;
  private diagnosticCache: { expiresAt: number; value: ElectronicInvoiceProviderDiagnostic } | null = null;

  constructor(private readonly client: SuperPdpClient = new SuperPdpClient(loadSuperPdpConfiguration())) {
    this.environment = client.configuration.environment;
  }

  async prepare(
    source: ElectronicInvoiceSourceDocument,
    requestedFormat: ElectronicInvoiceFormat
  ): Promise<PreparedElectronicInvoiceDocument> {
    if (!this.supportedFormats.includes(requestedFormat)) {
      throw new HttpError(422, "EINVOICE_FORMAT_UNSUPPORTED", "Ce format n'est pas pris en charge par SUPER PDP.");
    }
    const content = await this.client.convert(buildSuperPdpEn16931Invoice(source), requestedFormat);
    const extension = requestedFormat === "FACTUR_X" ? "pdf" : "xml";
    return {
      format: requestedFormat,
      filename: `${safeFilename(source.legalNumber)}.${extension}`,
      contentType: requestedFormat === "FACTUR_X" ? "application/pdf" : "application/xml",
      content,
      attachments: [],
    };
  }

  async diagnose(): Promise<ElectronicInvoiceProviderDiagnostic> {
    const now = Date.now();
    if (this.diagnosticCache && this.diagnosticCache.expiresAt > now) return this.diagnosticCache.value;
    const diagnostic = await this.client.diagnose();
    const value: ElectronicInvoiceProviderDiagnostic = {
      configured: diagnostic.configured,
      reachable: diagnostic.reachable,
      authenticated: diagnostic.authenticated,
      companyVerificationStatus: diagnostic.company_verification_status,
      checkedAt: diagnostic.checked_at,
      latencyMs: diagnostic.latency_ms,
      failureCode: diagnostic.failure_code,
      message: diagnostic.message,
      contractVersion: diagnostic.api_contract_version,
    };
    this.diagnosticCache = { expiresAt: now + DIAGNOSTIC_CACHE_MS, value };
    return value;
  }

  async submit(submission: ElectronicInvoiceSubmission): Promise<ElectronicInvoiceSubmissionReceipt> {
    const result = await this.client.submit({
      localDocumentId: submission.localDocumentId,
      idempotencyKey: submission.idempotencyKey,
      correlationId: submission.correlationId,
      content: submission.content,
      contentType: submission.contentType,
    });
    const event = latestOfficialEvent(result.invoice.events ?? []);
    return {
      providerDocumentId: String(result.invoice.id),
      providerRequestId: result.requestId,
      acceptedAt: event?.created_at ?? result.invoice.created_at,
      statusCode: event ? officialStatus(event) : null,
      filingProofReference: null,
      filingProofSha256: null,
    };
  }

  async retrieve(
    providerDocumentId: string,
    correlationId: string,
    context: ElectronicInvoiceRetrieveContext
  ): Promise<ElectronicInvoiceProviderEvent> {
    const result = await this.client.retrieveInvoice(providerDocumentId, correlationId);
    const providerEvent = latestOfficialEvent(result.events);
    if (!providerEvent) {
      const failure = technicalFailure(result.events);
      if (failure) {
        throw new SuperPdpProviderError({
          code: `SUPER_PDP_${failure.status_code.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`,
          message: failure.status_text.trim().slice(0, 500) || "SUPER PDP a refusé le document avant dépôt officiel.",
          httpStatus: 422,
        });
      }
      throw new SuperPdpProviderError({
        code: "SUPER_PDP_STATUS_PENDING",
        message: "SUPER PDP traite encore le document ; aucun statut officiel DGFiP n'est disponible.",
        httpStatus: 409,
      });
    }
    const statusCode = officialStatus(providerEvent);
    if (statusCode === null) throw new Error("Latest official SUPER PDP event has no official status");
    const rejection = statusCode === 210 || statusCode === 213
      ? rejectionDetails(providerEvent)
      : { code: null, message: null };
    return {
      providerEventId: String(providerEvent.id),
      providerDocumentId,
      direction: context.direction,
      documentType: context.documentType,
      format: context.format,
      invoiceId: context.invoiceId,
      creditNoteId: context.creditNoteId,
      documentSha256: context.documentSha256,
      contentStorageReference: null,
      attachments: [],
      statusCode,
      occurredAt: providerEvent.created_at,
      rejectionCode: rejection.code,
      rejectionMessage: rejection.message,
      filingProofReference: null,
      filingProofSha256: null,
    };
  }

  async verifyAndParseWebhook(): Promise<ElectronicInvoiceProviderEvent> {
    throw new HttpError(
      501,
      "SUPER_PDP_SIGNED_WEBHOOK_NOT_QUALIFIED",
      "Les webhooks SUPER PDP restent désactivés tant que leur mécanisme d'authenticité n'est pas publié et qualifié ; utilisez le rapprochement authentifié."
    );
  }
}

export function createConfiguredSuperPdpAdapter(env: NodeJS.ProcessEnv = process.env): SuperPdpAdapter | null {
  if (env.EINVOICE_PROVIDER?.trim().toLowerCase() !== SUPER_PDP_PROVIDER_CODE) return null;
  const configuration = loadSuperPdpConfiguration(env);
  if (configuration.oauthMode === "authorization_code") {
    // Shared multi-company activation is intentionally blocked until the caller injects a tenant-scoped vault provider.
    return new SuperPdpAdapter(new SuperPdpClient(configuration));
  }
  return new SuperPdpAdapter(new SuperPdpClient(configuration));
}

export { SUPER_PDP_API_CONTRACT_VERSION };
