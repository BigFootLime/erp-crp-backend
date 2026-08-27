import crypto from "node:crypto";

import { logger } from "../../shared/observability/logger";
import { markJobFinished, markJobStarted } from "../../shared/observability/metrics";
import { runtimeElectronicInvoiceEnvironment } from "../facturation/electronic-invoicing/electronic-invoice.service";
import {
  loadSuperPdpConfiguration,
  SuperPdpClient,
  SuperPdpProviderError,
} from "../facturation/electronic-invoicing/providers/super-pdp/super-pdp.client";
import { archiveInboundSupplierInvoiceArtifact } from "./supplier-invoice-archive.service";
import {
  normalizeSuperPdpSupplierInvoice,
  supplierInvoiceContentSha256,
} from "./supplier-invoice.domain";
import {
  repoAdvanceInboundSyncCursor,
  repoClaimSupplierInvoiceProviderStatus,
  repoCompleteSupplierInvoiceProviderStatus,
  repoFailSupplierInvoiceProviderStatus,
  repoGetInboundSyncContext,
  repoInboundInvoiceArtifactsComplete,
  repoPersistInboundSupplierInvoice,
  repoRecordInboundSyncAttempt,
  repoRecordInboundSyncFailure,
  type SupplierInvoiceArtifactSeed,
} from "./supplier-invoice-inbound.repository";

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : null;
  return typeof code === "string" && /^[A-Z0-9_.:-]{1,120}$/i.test(code) ? code : "SUPPLIER_INVOICE_SYNC_FAILED";
}

function configuredClient(): SuperPdpClient {
  return new SuperPdpClient(loadSuperPdpConfiguration());
}

export async function syncInboundSupplierInvoicesOnce(limit = 100): Promise<number> {
  const context = await repoGetInboundSyncContext(runtimeElectronicInvoiceEnvironment());
  await repoRecordInboundSyncAttempt(context.providerCode);
  const client = configuredClient();
  let processed = 0;
  let cursor = context.lastProviderId;
  try {
    const page = await client.listIncomingInvoices({ startingAfterId: cursor, limit: Math.min(1000, Math.max(1, limit)) });
    for (const overview of page.data) {
      const providerInvoiceId = String(overview.id);
      const correlationId = crypto.randomUUID();
      const full = await client.retrieveInvoice(providerInvoiceId, correlationId);
      const normalized = normalizeSuperPdpSupplierInvoice(full.invoice);
      const [original, facturX] = await Promise.all([
        client.downloadInvoiceRepresentation(providerInvoiceId, "original", correlationId),
        client.downloadInvoiceRepresentation(providerInvoiceId, "factur-x", correlationId),
      ]);
      const artifactContents = new Map<string, Buffer>();
      const seeds: SupplierInvoiceArtifactSeed[] = [];
      const add = (
        kind: SupplierInvoiceArtifactSeed["kind"],
        providerKey: string,
        fileName: string,
        mimeType: string,
        content: Buffer
      ) => {
        const key = `${kind}:${providerKey}`;
        const snapshot = Buffer.from(content);
        artifactContents.set(key, snapshot);
        seeds.push({
          kind,
          providerKey,
          fileName,
          mimeType,
          contentSha256: supplierInvoiceContentSha256(snapshot),
          sizeBytes: snapshot.length,
        });
      };
      add("ORIGINAL", "", original.fileName, original.contentType, original.content);
      add("FACTUR_X", "", facturX.fileName, facturX.contentType, facturX.content);
      for (const attachment of normalized.attachments) {
        add("ATTACHMENT", attachment.providerKey, attachment.fileName, attachment.mimeType, attachment.content);
      }
      const persisted = await repoPersistInboundSupplierInvoice({
        providerCode: context.providerCode,
        correlationId,
        invoice: normalized,
        original: seeds.find((seed) => seed.kind === "ORIGINAL")!,
        artifacts: seeds,
      });
      for (const artifact of persisted.pendingArtifacts) {
        if (artifact.archived) continue;
        const content = artifactContents.get(`${artifact.kind}:${artifact.providerKey}`);
        if (!content) throw Object.assign(new Error("Inbound artifact content missing"), { code: "SUPPLIER_INVOICE_ARTIFACT_MISSING" });
        await archiveInboundSupplierInvoiceArtifact({
          artifactId: artifact.id,
          supplierInvoiceId: persisted.supplierInvoiceId,
          actorUserId: context.qualifiedBy,
          kind: artifact.kind,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          expectedSha256: artifact.contentSha256,
          content,
        });
      }
      if (!(await repoInboundInvoiceArtifactsComplete(persisted.supplierInvoiceId))) {
        throw Object.assign(new Error("Inbound artifacts are not durable"), { code: "SUPPLIER_INVOICE_ARCHIVE_INCOMPLETE" });
      }
      cursor = overview.id;
      await repoAdvanceInboundSyncCursor(context.providerCode, overview.id);
      processed += 1;
    }
    return processed;
  } catch (error) {
    await repoRecordInboundSyncFailure(context.providerCode, safeErrorCode(error));
    throw error;
  }
}

export async function flushSupplierInvoiceProviderStatusesOnce(limit = 25): Promise<number> {
  const client = configuredClient();
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const claimed = await repoClaimSupplierInvoiceProviderStatus();
    if (!claimed) break;
    try {
      const event = await client.createInvoiceEvent({
        providerDocumentId: claimed.providerDocumentId,
        statusCode: claimed.statusCode,
        details: claimed.details,
        correlationId: claimed.correlationId,
        idempotencyKey: claimed.id,
      });
      await repoCompleteSupplierInvoiceProviderStatus({
        id: claimed.id,
        processingToken: claimed.processingToken,
        providerEventId: String(event.id),
      });
      processed += 1;
    } catch (error) {
      await repoFailSupplierInvoiceProviderStatus({
        id: claimed.id,
        processingToken: claimed.processingToken,
        attemptCount: claimed.attemptCount,
        errorCode: safeErrorCode(error),
        retryAfterSeconds: error instanceof SuperPdpProviderError ? error.retryAfterSeconds : null,
      });
    }
  }
  return processed;
}

export function startSupplierInvoiceMaintenance(): () => void {
  if (process.env.EINVOICE_PROVIDER?.trim().toLowerCase() !== "super-pdp") return () => undefined;
  const configuration = loadSuperPdpConfiguration();
  if (!configuration.clientId || !configuration.clientSecret) return () => undefined;
  const configured = Number.parseInt(process.env.SUPPLIER_INVOICE_SYNC_INTERVAL_MS ?? "300000", 10);
  const syncIntervalMs = Number.isSafeInteger(configured) && configured >= 60_000 ? configured : 300_000;
  let nextSyncAt = 0;
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    markJobStarted("supplier_invoice_inbound");
    try {
      await flushSupplierInvoiceProviderStatusesOnce();
      if (Date.now() >= nextSyncAt) {
        await syncInboundSupplierInvoicesOnce();
        nextSyncAt = Date.now() + syncIntervalMs;
      }
      markJobFinished("supplier_invoice_inbound", true);
    } catch (error) {
      markJobFinished("supplier_invoice_inbound", false);
      logger.error("supplier_invoice_inbound_worker_failed", { failure_code: safeErrorCode(error) });
    } finally {
      running = false;
    }
  };
  void cycle();
  const timer = setInterval(() => void cycle(), Math.min(30_000, syncIntervalMs));
  timer.unref();
  return () => clearInterval(timer);
}
