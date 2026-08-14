import { logger } from "../../../shared/observability/logger";
import { HttpError } from "../../../utils/httpError";
import { canonicalJson } from "../domain/finance-policy";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  ElectronicInvoiceProviderRegistry,
  classifyProviderFailure,
  normalizeElectronicInvoiceProviderEvent,
  parseDGFiPInvoiceStatusCode,
  sanitizedProviderError,
  sha256Hex,
  type ElectronicInvoiceFormat,
} from "./electronic-invoice.domain";
import {
  repoApplyElectronicInvoiceProviderEvent,
  repoClaimElectronicInvoice,
  repoGetElectronicInvoiceConnection,
  repoGetElectronicInvoiceState,
  repoQueueElectronicInvoice,
  repoRecordElectronicInvoiceFailure,
  repoRecordElectronicInvoiceSuccess,
} from "./electronic-invoice.repository";

export const electronicInvoiceProviderRegistry = new ElectronicInvoiceProviderRegistry();

function runtimeEnvironment(): "sandbox" | "production" {
  return process.env.NODE_ENV === "production" ? "production" : "sandbox";
}

function numericField(value: unknown, name: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[name];
  return typeof field === "number" && Number.isInteger(field) ? field : null;
}

function stringField(value: unknown, name: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[name];
  return typeof field === "string" ? field : null;
}

export async function svcElectronicInvoiceReadiness() {
  const environment = runtimeEnvironment();
  const connection = await repoGetElectronicInvoiceConnection(environment);
  const registeredAdapters = electronicInvoiceProviderRegistry.list();
  if (!connection) {
    return {
      ready: false,
      environment,
      reason: "NO_QUALIFIED_PROVIDER",
      message: "Aucune Plateforme Agréée réelle n'est qualifiée et activée pour cet environnement.",
      provider: null,
      registered_adapters: registeredAdapters,
    } as const;
  }
  try {
    const adapter = electronicInvoiceProviderRegistry.resolve(connection.adapterKey);
    const ready = adapter.environment === connection.environment;
    return {
      ready,
      environment,
      reason: ready ? null : "ADAPTER_ENVIRONMENT_MISMATCH",
      message: ready
        ? "Le connecteur est qualifié. Les statuts affichés proviendront exclusivement du prestataire."
        : "L'adaptateur chargé ne correspond pas à l'environnement qualifié en base.",
      provider: connection,
      registered_adapters: registeredAdapters,
    } as const;
  } catch {
    return {
      ready: false,
      environment,
      reason: "ADAPTER_NOT_DEPLOYED",
      message: "La configuration SQL existe mais l'adaptateur qualifié n'est pas présent dans cette version du service.",
      provider: connection,
      registered_adapters: registeredAdapters,
    } as const;
  }
}

export async function svcGetElectronicInvoice(invoiceId: number) {
  return {
    readiness: await svcElectronicInvoiceReadiness(),
    document: await repoGetElectronicInvoiceState(invoiceId),
  };
}

export async function svcQueueElectronicInvoice(params: {
  invoiceId: number;
  format: ElectronicInvoiceFormat;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) {
  const environment = runtimeEnvironment();
  const connection = await repoGetElectronicInvoiceConnection(environment);
  if (!connection) {
    throw new HttpError(
      503,
      "EINVOICE_PROVIDER_NOT_CONFIGURED",
      "Aucune Plateforme Agréée qualifiée n'est activée. Aucun envoi n'a été tenté."
    );
  }
  electronicInvoiceProviderRegistry.resolve(connection.adapterKey);
  return repoQueueElectronicInvoice({
    ...params,
    environment,
    idempotencyKeyRaw: params.idempotencyKey,
  });
}

export async function svcProcessNextElectronicInvoice(): Promise<boolean> {
  const environment = runtimeEnvironment();
  const claim = await repoClaimElectronicInvoice(environment);
  if (!claim) return false;
  const startedAt = new Date();
  try {
    const adapter = electronicInvoiceProviderRegistry.resolve(claim.providerAdapterKey);
    if (adapter.environment !== claim.environment) {
      throw new HttpError(503, "EINVOICE_ADAPTER_ENVIRONMENT_MISMATCH", "L'adaptateur ne correspond pas à l'environnement qualifié.");
    }
    const prepared = await adapter.prepare(claim.source, claim.state.format);
    if (prepared.format !== claim.state.format || !adapter.supportedFormats.includes(prepared.format)) {
      throw new HttpError(422, "EINVOICE_FORMATTER_CONTRACT_INVALID", "L'adaptateur a préparé un format non qualifié.");
    }
    const contentSha256 = sha256Hex(prepared.content);
    const receipt = await adapter.submit({
      localDocumentId: claim.state.id,
      invoiceId: claim.state.invoice_id,
      creditNoteId: claim.state.credit_note_id,
      documentType: claim.state.document_type,
      format: prepared.format,
      filename: prepared.filename,
      contentType: prepared.contentType,
      content: prepared.content,
      contentSha256,
      idempotencyKey: `cerp-einvoice-${claim.state.id}`,
      correlationId: claim.state.correlation_id,
      attachments: prepared.attachments,
    });
    receipt.statusCode = parseDGFiPInvoiceStatusCode(receipt.statusCode);
    await repoRecordElectronicInvoiceSuccess({
      documentId: claim.state.id,
      processingToken: claim.processingToken,
      receipt,
      contentSha256,
      startedAt,
      finishedAt: new Date(),
    });
    logger.info("electronic_invoice_submission_succeeded", {
      electronic_invoice_document_id: claim.state.id,
      provider_code: claim.state.provider_code,
      external_status_code: receipt.statusCode,
      correlation_id: claim.state.correlation_id,
    });
    return true;
  } catch (error) {
    const httpStatus = numericField(error, "httpStatus") ?? (error instanceof HttpError ? error.status : null);
    const retryAfterSeconds = numericField(error, "retryAfterSeconds");
    const decision = classifyProviderFailure({
      httpStatus,
      attempt: claim.state.retry_count + 1,
      retryAfterSeconds,
    });
    const safe = sanitizedProviderError({ code: stringField(error, "code"), message: error instanceof Error ? error.message : null });
    await repoRecordElectronicInvoiceFailure({
      documentId: claim.state.id,
      processingToken: claim.processingToken,
      errorCode: safe.code,
      errorMessage: safe.message,
      httpStatus,
      retryable: decision.retryable,
      delaySeconds: decision.delaySeconds,
      startedAt,
      finishedAt: new Date(),
    });
    logger.error("electronic_invoice_submission_failed", {
      electronic_invoice_document_id: claim.state.id,
      provider_code: claim.state.provider_code,
      failure_code: safe.code,
      retryable: decision.retryable,
      correlation_id: claim.state.correlation_id,
    });
    return true;
  }
}

export async function svcReconcileElectronicInvoice(params: {
  invoiceId: number;
  correlationId: string;
  requestId: string;
  actor: FinanceActorContext;
}) {
  const state = await repoGetElectronicInvoiceState(params.invoiceId);
  if (!state) throw new HttpError(404, "EINVOICE_DOCUMENT_NOT_FOUND", "Aucune transmission électronique n'existe pour cette facture.");
  if (!state.provider_document_id) {
    throw new HttpError(409, "EINVOICE_NOT_SUBMITTED", "La transmission est encore en file et ne peut pas être rapprochée.");
  }
  const connection = await repoGetElectronicInvoiceConnection(runtimeEnvironment());
  if (!connection || connection.providerCode !== state.provider_code) {
    throw new HttpError(503, "EINVOICE_PROVIDER_NOT_CONFIGURED", "La Plateforme Agréée du document n'est pas active.");
  }
  const adapter = electronicInvoiceProviderRegistry.resolve(connection.adapterKey);
  const event = normalizeElectronicInvoiceProviderEvent(
    await adapter.retrieve(state.provider_document_id, params.correlationId)
  );
  await repoApplyElectronicInvoiceProviderEvent({
    providerCode: state.provider_code,
    event,
    payloadSha256: sha256Hex(canonicalJson(event)),
    signatureVerified: null,
    correlationId: params.correlationId,
    requestId: params.requestId,
    actor: params.actor,
  });
  return repoGetElectronicInvoiceState(params.invoiceId);
}

export async function svcHandleElectronicInvoiceWebhook(params: {
  providerCode: string;
  body: Buffer;
  headers: Readonly<Record<string, string | undefined>>;
  correlationId: string;
  requestId: string;
}) {
  const connection = await repoGetElectronicInvoiceConnection(runtimeEnvironment());
  if (!connection || connection.providerCode !== params.providerCode) {
    throw new HttpError(404, "EINVOICE_PROVIDER_UNKNOWN", "Prestataire de facturation électronique inconnu.");
  }
  const adapter = electronicInvoiceProviderRegistry.resolve(connection.adapterKey);
  const event = normalizeElectronicInvoiceProviderEvent(
    await adapter.verifyAndParseWebhook({ body: params.body, headers: params.headers })
  );
  return repoApplyElectronicInvoiceProviderEvent({
    providerCode: params.providerCode,
    event,
    payloadSha256: sha256Hex(params.body),
    signatureVerified: true,
    correlationId: params.correlationId,
    requestId: params.requestId,
  });
}

export function startElectronicInvoiceMaintenance(): () => void {
  if (electronicInvoiceProviderRegistry.list().length === 0) return () => undefined;
  const configured = Number.parseInt(process.env.EINVOICE_JOB_INTERVAL_MS ?? "30000", 10);
  const intervalMs = Number.isSafeInteger(configured) && configured >= 5_000 ? configured : 30_000;
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (let processed = 0; processed < 25; processed += 1) {
        if (!(await svcProcessNextElectronicInvoice())) break;
      }
    } catch (error) {
      logger.error("electronic_invoice_worker_failed", {
        failure_code: stringField(error, "code") ?? "EINVOICE_WORKER_ERROR",
      });
    } finally {
      running = false;
    }
  };
  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
