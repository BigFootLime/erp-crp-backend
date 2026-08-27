import { logger } from "../../../shared/observability/logger";
import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  repoClaimEReporting,
  repoCompleteEReporting,
  repoCreateEReportingPayment,
  repoCreateEReportingTransaction,
  repoFailEReporting,
  repoListEReportingPeriods,
  repoObserveEReportingPeriods,
} from "./electronic-invoice-reporting.repository";
import type {
  EReportingPaymentBody,
  EReportingPeriodsQuery,
  EReportingTransactionBody,
} from "./electronic-invoice-reporting.validators";
import { repoGetElectronicInvoiceConnection } from "./electronic-invoice.repository";
import { runtimeElectronicInvoiceEnvironment } from "./electronic-invoice.service";
import { SuperPdpClient, SuperPdpProviderError, loadSuperPdpConfiguration } from "./providers/super-pdp/super-pdp.client";

function enabled(): boolean {
  const environment = runtimeElectronicInvoiceEnvironment();
  if (process.env.EINVOICE_EREPORTING_ENABLED !== "true") return false;
  return environment !== "production" || process.env.EINVOICE_PRODUCTION_EREPORTING_ENABLED === "true";
}

function reportingConfiguration() {
  const taxDueDateTypeCode = process.env.EINVOICE_EREPORTING_TAX_DUE_DATE_TYPE_CODE?.trim() ?? "";
  const businessProcessTypeId = process.env.EINVOICE_EREPORTING_BUSINESS_PROCESS_TYPE_ID?.trim() ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(taxDueDateTypeCode) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(businessProcessTypeId)) {
    throw new HttpError(
      503,
      "EREPORTING_TAX_CONFIGURATION_REQUIRED",
      "Le code d'exigibilité TVA et le processus e-reporting doivent être validés avec le cabinet comptable puis configurés explicitement."
    );
  }
  return { taxDueDateTypeCode, businessProcessTypeId };
}

function assertEnabled(): void {
  if (!enabled()) {
    throw new HttpError(503, "EREPORTING_DISABLED", "L'e-reporting est désactivé par feature flag pour cet environnement.");
  }
}

async function requiredConnection() {
  const connection = await repoGetElectronicInvoiceConnection(runtimeElectronicInvoiceEnvironment());
  if (!connection) {
    throw new HttpError(503, "EREPORTING_PROVIDER_NOT_CONFIGURED", "Aucune Plateforme Agréée active n'est configurée pour l'e-reporting.");
  }
  return connection;
}

export async function svcCreateEReportingTransaction(params: {
  body: EReportingTransactionBody;
  actor: FinanceActorContext;
  idempotencyKey: string;
}) {
  assertEnabled();
  const connection = await requiredConnection();
  return repoCreateEReportingTransaction({ ...params, configuration: reportingConfiguration(), providerCode: connection.providerCode });
}

export async function svcCreateEReportingPayment(params: {
  body: EReportingPaymentBody;
  actor: FinanceActorContext;
  idempotencyKey: string;
}) {
  assertEnabled();
  reportingConfiguration();
  const connection = await requiredConnection();
  return repoCreateEReportingPayment({ ...params, providerCode: connection.providerCode });
}

export async function svcListEReportingPeriods(query: EReportingPeriodsQuery) {
  const result = await repoListEReportingPeriods(query);
  let configurationReady = true;
  try {
    reportingConfiguration();
  } catch {
    configurationReady = false;
  }
  return {
    ...result,
    meta: {
      enabled: enabled(),
      configuration_ready: configurationReady,
      environment: runtimeElectronicInvoiceEnvironment(),
    },
  };
}

async function synchronizePeriods(): Promise<void> {
  if (!enabled()) return;
  reportingConfiguration();
  const connection = await repoGetElectronicInvoiceConnection(runtimeElectronicInvoiceEnvironment());
  if (!connection) return;
  const client = new SuperPdpClient(loadSuperPdpConfiguration());
  const periods: Record<string, unknown>[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < 100; page += 1) {
    const response = await client.listEReportingPeriods({ startingAfterId: cursor, limit: 100 });
    periods.push(...response.data);
    if (!response.has_more || response.data.length === 0) break;
    cursor = response.data[response.data.length - 1]!.id;
    if (page === 99) throw new Error("SUPERPDP e-reporting period pagination exceeded safety limit");
  }
  const observed = await repoObserveEReportingPeriods({ providerCode: connection.providerCode, periods });
  if (observed > 0) {
    logger.info("electronic_invoice_ereporting_periods_observed", { observed_count: observed });
  }
}

async function processOne(kind: "TRANSACTION" | "PAYMENT"): Promise<boolean> {
  if (!enabled()) return false;
  reportingConfiguration();
  const connection = await repoGetElectronicInvoiceConnection(runtimeElectronicInvoiceEnvironment());
  if (!connection) return false;
  const claim = await repoClaimEReporting(kind);
  if (!claim) return false;
  try {
    const client = new SuperPdpClient(loadSuperPdpConfiguration());
    const response = kind === "TRANSACTION"
      ? await client.createB2BIntInvoices({
          data: [claim.payload as Record<string, unknown>],
          correlationId: claim.id as string,
          idempotencyKey: `cerp-ereport-transaction-${claim.id}`,
        })
      : await client.createB2BIntPayments({
          data: [claim.payload as Record<string, unknown>],
          correlationId: claim.id as string,
          idempotencyKey: `cerp-ereport-payment-${claim.id}`,
        });
    const receipt = response[0]!;
    await repoCompleteEReporting({
      kind,
      id: String(claim.id),
      providerCode: connection.providerCode,
      providerItemId: String(receipt.id),
      payloadSha256: String(claim.payload_sha256),
      receipt,
    });
  } catch (error) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "EREPORTING_PROVIDER_FAILURE";
    const retryable = !(error instanceof SuperPdpProviderError)
      || error.httpStatus === null
      || error.httpStatus >= 500
      || [408, 409, 425, 429].includes(error.httpStatus);
    await repoFailEReporting(kind, String(claim.id), code, Number(claim.attempt_count), retryable);
    logger.error("electronic_invoice_ereporting_failed", { reporting_kind: kind, reporting_id: claim.id, failure_code: code });
  }
  return true;
}

export function startEReportingMaintenance(): () => void {
  if (!enabled()) return () => undefined;
  let running = false;
  let lastPeriodSynchronization = 0;
  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      if (Date.now() - lastPeriodSynchronization >= 5 * 60_000) {
        await synchronizePeriods();
        lastPeriodSynchronization = Date.now();
      }
      await processOne("TRANSACTION");
      await processOne("PAYMENT");
    })().catch((error) => {
        logger.error("electronic_invoice_ereporting_worker_failed", {
          failure_code: error instanceof Error ? error.name : "EREPORTING_WORKER_FAILED",
        });
      }).finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, 30_000);
  timer.unref();
  setImmediate(run);
  return () => clearInterval(timer);
}
