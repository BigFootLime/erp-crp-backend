import { z } from "zod";

import { HttpError } from "../../../../../utils/httpError";
import type { ElectronicInvoiceFormat } from "../../electronic-invoice.domain";

export const SUPER_PDP_API_CONTRACT_VERSION = "1.30.0.beta+notes-1.33.0.beta-2026-08-07" as const;
export const SUPER_PDP_PROVIDER_CODE = "super-pdp" as const;

const OFFICIAL_API_ORIGIN = "https://api.superpdp.tech";
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().int().positive().max(86_400).optional(),
}).passthrough();

const sessionSchema = z.object({
  client_id: z.string().min(1),
  created_at: z.string().datetime(),
  company_verification_status: z.string().min(1),
  user_identity_verification_status: z.string().min(1).optional(),
}).passthrough();

const providerEventSchema = z.object({
  id: z.coerce.number().int().positive(),
  invoice_id: z.coerce.number().int().positive(),
  status_code: z.string().min(1),
  status_text: z.string(),
  created_at: z.string().datetime(),
  details: z.array(z.object({
    reason: z.string().optional(),
  }).passthrough()).optional(),
  data: z.object({ reason: z.string().optional() }).passthrough().optional(),
}).passthrough();

const invoiceSchema = z.object({
  id: z.coerce.number().int().positive(),
  company_id: z.coerce.number().int().positive(),
  created_at: z.string().datetime(),
  direction: z.enum(["in", "out"]),
  external_id: z.string().max(36).optional(),
  events: z.array(providerEventSchema).optional(),
}).passthrough();

const invoiceListSchema = z.object({
  data: z.array(invoiceSchema),
  count: z.coerce.number().int().nonnegative(),
  has_before: z.boolean(),
  has_after: z.boolean(),
}).passthrough();

const eventListSchema = z.object({
  data: z.array(providerEventSchema),
  has_after: z.boolean(),
}).passthrough();

type ProviderInvoice = z.infer<typeof invoiceSchema>;
export type SuperPdpProviderEvent = z.infer<typeof providerEventSchema>;

export type SuperPdpEnvironment = "sandbox" | "production";
export type SuperPdpOAuthMode = "client_credentials" | "authorization_code";

export type SuperPdpClientConfiguration = {
  environment: SuperPdpEnvironment;
  baseUrl: string;
  oauthMode: SuperPdpOAuthMode;
  clientId: string | null;
  clientSecret: string | null;
  timeoutMs: number;
};

export type SuperPdpDiagnostic = {
  provider: typeof SUPER_PDP_PROVIDER_CODE;
  environment: SuperPdpEnvironment;
  configured: boolean;
  reachable: boolean;
  authenticated: boolean;
  company_verification_status: string | null;
  user_identity_verification_status: string | null;
  api_contract_version: typeof SUPER_PDP_API_CONTRACT_VERSION;
  checked_at: string;
  latency_ms: number;
  failure_code: string | null;
  message: string;
};

export class SuperPdpProviderError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(params: {
    code: string;
    message: string;
    httpStatus: number | null;
    retryAfterSeconds?: number | null;
  }) {
    super(params.message);
    this.name = "SuperPdpProviderError";
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
  }
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function explicitElectronicInvoiceEnvironment(env: NodeJS.ProcessEnv): SuperPdpEnvironment {
  const configured = env.EINVOICE_ENVIRONMENT?.trim().toLowerCase();
  if (configured === "sandbox" || configured === "production") return configured;
  if (env.EINVOICE_PROVIDER?.trim().toLowerCase() === SUPER_PDP_PROVIDER_CODE) {
    throw new Error("EINVOICE_ENVIRONMENT must be explicitly set to sandbox or production when SUPER PDP is enabled");
  }
  return env.NODE_ENV === "production" ? "production" : "sandbox";
}

function validateBaseUrl(raw: string, nodeEnvironment: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SUPER_PDP_BASE_URL is not a valid URL");
  }
  const isOfficial = parsed.origin === OFFICIAL_API_ORIGIN;
  const isLoopbackTest = nodeEnvironment === "test"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    && (parsed.protocol === "http:" || parsed.protocol === "https:");
  if ((!isOfficial && !isLoopbackTest) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SUPER_PDP_BASE_URL must target the official API origin");
  }
  return parsed.origin;
}

export function loadSuperPdpConfiguration(env: NodeJS.ProcessEnv = process.env): SuperPdpClientConfiguration {
  const configuredOAuthMode = env.SUPER_PDP_OAUTH_MODE?.trim().toLowerCase();
  if (configuredOAuthMode && configuredOAuthMode !== "client_credentials" && configuredOAuthMode !== "authorization_code") {
    throw new Error("SUPER_PDP_OAUTH_MODE must be client_credentials or authorization_code");
  }
  const oauthMode: SuperPdpOAuthMode = configuredOAuthMode === "authorization_code"
    ? "authorization_code"
    : "client_credentials";
  return {
    environment: explicitElectronicInvoiceEnvironment(env),
    baseUrl: validateBaseUrl(env.SUPER_PDP_BASE_URL?.trim() || OFFICIAL_API_ORIGIN, env.NODE_ENV),
    oauthMode,
    clientId: env.SUPER_PDP_CLIENT_ID?.trim() || null,
    clientSecret: env.SUPER_PDP_CLIENT_SECRET?.trim() || null,
    timeoutMs: boundedInteger(env.SUPER_PDP_TIMEOUT_MS, 15_000, 1_000, 60_000),
  };
}

export interface SuperPdpAccessTokenProvider {
  readonly mode: SuperPdpOAuthMode;
  configured(): boolean;
  accessToken(): Promise<string>;
}

export class SuperPdpClientCredentialsAccessTokenProvider implements SuperPdpAccessTokenProvider {
  readonly mode = "client_credentials" as const;
  private cached: { value: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly configuration: SuperPdpClientConfiguration,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  configured(): boolean {
    return Boolean(this.configuration.clientId && this.configuration.clientSecret);
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret } = this.configuration;
    if (!clientId || !clientSecret) {
      throw new SuperPdpProviderError({
        code: "SUPER_PDP_CREDENTIALS_MISSING",
        message: "Les identifiants SUPER PDP ne sont pas présents dans le coffre d'environnement.",
        httpStatus: null,
      });
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL("/oauth2/token", this.configuration.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
        signal: AbortSignal.timeout(this.configuration.timeoutMs),
      });
    } catch (error) {
      throw new SuperPdpProviderError({
        code: error instanceof Error && error.name === "TimeoutError" ? "SUPER_PDP_TIMEOUT" : "SUPER_PDP_NETWORK_ERROR",
        message: "L'authentification auprès de SUPER PDP a échoué.",
        httpStatus: null,
      });
    }
    const body = await boundedBody(response);
    if (!response.ok) {
      throw new SuperPdpProviderError({
        code: providerFailureCode(body, response.status),
        message: safeProviderFailureMessage(body, response.status),
        httpStatus: response.status,
        retryAfterSeconds: retryAfterSeconds(response),
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      value = null;
    }
    const parsed = tokenResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
      throw new SuperPdpProviderError({
        code: "SUPER_PDP_TOKEN_RESPONSE_INVALID",
        message: "La réponse OAuth de SUPER PDP est invalide.",
        httpStatus: 502,
      });
    }
    this.cached = {
      value: parsed.data.access_token,
      expiresAt: this.now() + (parsed.data.expires_in ?? 300) * 1000,
    };
    return parsed.data.access_token;
  }
}

class UnsupportedAuthorizationCodeAccessTokenProvider implements SuperPdpAccessTokenProvider {
  readonly mode = "authorization_code" as const;
  configured(): boolean { return false; }
  async accessToken(): Promise<string> {
    throw new SuperPdpProviderError({
      code: "SUPER_PDP_TENANT_VAULT_REQUIRED",
      message: "Le mode multi-entreprise exige un consentement OAuth et un coffre de jetons isolé par société.",
      httpStatus: null,
    });
  }
}

function responseRequestId(response: Response): string | null {
  const value = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return value && value.length <= 200 && !/[\r\n\t]/.test(value) ? value : null;
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(3600, parsed)) : null;
}

async function boundedBody(response: Response): Promise<Buffer> {
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(length) && length > MAX_RESPONSE_BYTES) {
    throw new SuperPdpProviderError({
      code: "SUPER_PDP_RESPONSE_TOO_LARGE",
      message: "La réponse SUPER PDP dépasse la limite de sécurité CERP+.",
      httpStatus: response.status,
    });
  }
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length > MAX_RESPONSE_BYTES) {
    throw new SuperPdpProviderError({
      code: "SUPER_PDP_RESPONSE_TOO_LARGE",
      message: "La réponse SUPER PDP dépasse la limite de sécurité CERP+.",
      httpStatus: response.status,
    });
  }
  return value;
}

function safeProviderFailureMessage(body: Buffer, status: number): string {
  if (body.length === 0) return `SUPER PDP a retourné HTTP ${status}.`;
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const message = [record.errorMessage, record.message, record.error_description]
        .find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
      if (typeof message === "string") return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    }
  } catch {
    // A provider HTML/proxy error must never be copied into logs or persistence.
  }
  return `SUPER PDP a retourné HTTP ${status}.`;
}

function providerFailureCode(body: Buffer, status: number): string {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const code = (value as Record<string, unknown>).errorCode;
      if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)) return `SUPER_PDP_${code}`;
    }
  } catch {
    // Fall through to the stable HTTP code.
  }
  return `SUPER_PDP_HTTP_${status}`;
}

function ensureContentSignature(format: ElectronicInvoiceFormat, content: Buffer): void {
  if (format === "FACTUR_X" && content.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new SuperPdpProviderError({
      code: "SUPER_PDP_CONVERSION_INVALID",
      message: "SUPER PDP n'a pas retourné un PDF Factur-X valide.",
      httpStatus: 502,
    });
  }
  if (format !== "FACTUR_X") {
    const prefix = content.subarray(0, Math.min(content.length, 4096)).toString("utf8");
    const marker = format === "UBL" ? /(?:<|:)Invoice\b/ : /CrossIndustryInvoice/;
    if (!marker.test(prefix)) {
      throw new SuperPdpProviderError({
        code: "SUPER_PDP_CONVERSION_INVALID",
        message: `SUPER PDP n'a pas retourné un document ${format} identifiable.`,
        httpStatus: 502,
      });
    }
  }
}

export class SuperPdpClient {
  private readonly tokenProvider: SuperPdpAccessTokenProvider;

  constructor(
    readonly configuration: SuperPdpClientConfiguration,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    tokenProvider?: SuperPdpAccessTokenProvider
  ) {
    this.tokenProvider = tokenProvider ?? (
      configuration.oauthMode === "client_credentials"
        ? new SuperPdpClientCredentialsAccessTokenProvider(configuration, fetcher, now)
        : new UnsupportedAuthorizationCodeAccessTokenProvider()
    );
  }

  private async request(path: string, init: RequestInit, authenticated: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("Authorization", `Bearer ${await this.tokenProvider.accessToken()}`);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.configuration.baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.configuration.timeoutMs),
      });
    } catch (error) {
      throw new SuperPdpProviderError({
        code: error instanceof Error && error.name === "TimeoutError" ? "SUPER_PDP_TIMEOUT" : "SUPER_PDP_NETWORK_ERROR",
        message: "La communication avec SUPER PDP a échoué.",
        httpStatus: null,
      });
    }
    if (!response.ok) {
      const body = await boundedBody(response);
      throw new SuperPdpProviderError({
        code: providerFailureCode(body, response.status),
        message: safeProviderFailureMessage(body, response.status),
        httpStatus: response.status,
        retryAfterSeconds: retryAfterSeconds(response),
      });
    }
    return response;
  }

  async diagnose(): Promise<SuperPdpDiagnostic> {
    const startedAt = this.now();
    const checkedAt = new Date(startedAt).toISOString();
    if (!this.tokenProvider.configured()) {
      return {
        provider: SUPER_PDP_PROVIDER_CODE,
        environment: this.configuration.environment,
        configured: false,
        reachable: false,
        authenticated: false,
        company_verification_status: null,
        user_identity_verification_status: null,
        api_contract_version: SUPER_PDP_API_CONTRACT_VERSION,
        checked_at: checkedAt,
        latency_ms: 0,
        failure_code: this.tokenProvider.mode === "authorization_code"
          ? "SUPER_PDP_TENANT_VAULT_REQUIRED"
          : "SUPER_PDP_CREDENTIALS_MISSING",
        message: this.tokenProvider.mode === "authorization_code"
          ? "Le consentement OAuth et le coffre de jetons isolé par société ne sont pas configurés."
          : "Ajoutez SUPER_PDP_CLIENT_ID et SUPER_PDP_CLIENT_SECRET dans le coffre du service.",
      };
    }
    try {
      const response = await this.request("/v1.beta/oauth2_sessions/me", { headers: { Accept: "application/json" } }, true);
      const parsed = sessionSchema.safeParse(JSON.parse((await boundedBody(response)).toString("utf8")) as unknown);
      if (!parsed.success) {
        throw new SuperPdpProviderError({
          code: "SUPER_PDP_SESSION_RESPONSE_INVALID",
          message: "La session SUPER PDP ne respecte pas le contrat attendu.",
          httpStatus: 502,
        });
      }
      const verified = parsed.data.company_verification_status === "verified";
      return {
        provider: SUPER_PDP_PROVIDER_CODE,
        environment: this.configuration.environment,
        configured: true,
        reachable: true,
        authenticated: true,
        company_verification_status: parsed.data.company_verification_status,
        user_identity_verification_status: parsed.data.user_identity_verification_status ?? null,
        api_contract_version: SUPER_PDP_API_CONTRACT_VERSION,
        checked_at: checkedAt,
        latency_ms: Math.max(0, this.now() - startedAt),
        failure_code: verified ? null : "SUPER_PDP_COMPANY_NOT_VERIFIED",
        message: verified
          ? "La session SUPER PDP est authentifiée et l'entreprise est vérifiée."
          : "La session est authentifiée, mais l'entreprise SUPER PDP n'est pas vérifiée.",
      };
    } catch (error) {
      const providerError = error instanceof SuperPdpProviderError
        ? error
        : new SuperPdpProviderError({ code: "SUPER_PDP_DIAGNOSTIC_FAILED", message: "Le diagnostic SUPER PDP a échoué.", httpStatus: null });
      return {
        provider: SUPER_PDP_PROVIDER_CODE,
        environment: this.configuration.environment,
        configured: true,
        reachable: providerError.httpStatus !== null,
        authenticated: false,
        company_verification_status: null,
        user_identity_verification_status: null,
        api_contract_version: SUPER_PDP_API_CONTRACT_VERSION,
        checked_at: checkedAt,
        latency_ms: Math.max(0, this.now() - startedAt),
        failure_code: providerError.code,
        message: providerError.message,
      };
    }
  }

  async convert(invoice: Readonly<Record<string, unknown>>, format: ElectronicInvoiceFormat): Promise<Buffer> {
    const providerFormat = format === "FACTUR_X" ? "factur-x" : format.toLowerCase();
    const response = await this.request(
      `/v1.beta/invoices/convert?from=en16931&to=${encodeURIComponent(providerFormat)}`,
      {
        method: "POST",
        headers: {
          Accept: format === "FACTUR_X" ? "application/pdf" : "application/xml",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invoice),
      },
      false
    );
    const content = await boundedBody(response);
    ensureContentSignature(format, content);
    return content;
  }

  private async findInvoiceByExternalId(externalId: string): Promise<ProviderInvoice | null> {
    let startingAfterId: number | null = null;
    const visited = new Set<number>();
    for (;;) {
      const query = new URLSearchParams({ order: "asc", limit: "1000" });
      if (startingAfterId !== null) query.set("starting_after_id", String(startingAfterId));
      const response = await this.request(`/v1.beta/invoices?${query.toString()}`, { headers: { Accept: "application/json" } }, true);
      const parsed = invoiceListSchema.safeParse(JSON.parse((await boundedBody(response)).toString("utf8")) as unknown);
      if (!parsed.success) {
        throw new SuperPdpProviderError({
          code: "SUPER_PDP_INVOICE_LIST_INVALID",
          message: "La liste de factures SUPER PDP est invalide.",
          httpStatus: 502,
        });
      }
      const found = parsed.data.data.find((invoice) => invoice.external_id === externalId);
      if (found) return found;
      const last = parsed.data.data.at(-1);
      if (!parsed.data.has_after || !last) return null;
      if (visited.has(last.id)) {
        throw new SuperPdpProviderError({
          code: "SUPER_PDP_INVOICE_PAGINATION_STALLED",
          message: "La pagination SUPER PDP ne progresse plus ; le dépôt est interrompu pour éviter un doublon.",
          httpStatus: 502,
        });
      }
      visited.add(last.id);
      startingAfterId = last.id;
    }
  }

  async submit(params: {
    localDocumentId: string;
    idempotencyKey: string;
    correlationId: string;
    content: Buffer;
    contentType: string;
  }): Promise<{ invoice: ProviderInvoice; requestId: string | null; replayed: boolean }> {
    const existing = await this.findInvoiceByExternalId(params.localDocumentId);
    if (existing) return { invoice: existing, requestId: null, replayed: true };
    const query = new URLSearchParams({ external_id: params.localDocumentId });
    const response = await this.request(`/v1.beta/invoices?${query.toString()}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": params.contentType,
        "Idempotency-Key": params.idempotencyKey,
        "Request-Id": params.correlationId,
      },
      body: Uint8Array.from(params.content).buffer,
    }, true);
    const parsed = invoiceSchema.safeParse(JSON.parse((await boundedBody(response)).toString("utf8")) as unknown);
    if (!parsed.success || parsed.data.external_id !== params.localDocumentId) {
      throw new SuperPdpProviderError({
        code: "SUPER_PDP_SUBMISSION_RESPONSE_INVALID",
        message: "La réponse de dépôt SUPER PDP ne correspond pas au document CERP+.",
        httpStatus: 502,
      });
    }
    return { invoice: parsed.data, requestId: responseRequestId(response), replayed: false };
  }

  async retrieveInvoice(providerDocumentId: string, correlationId: string): Promise<{
    invoice: ProviderInvoice;
    events: SuperPdpProviderEvent[];
  }> {
    if (!/^\d+$/.test(providerDocumentId)) {
      throw new HttpError(422, "SUPER_PDP_DOCUMENT_ID_INVALID", "L'identifiant de facture SUPER PDP est invalide.");
    }
    const response = await this.request(`/v1.beta/invoices/${providerDocumentId}?format=en16931`, {
      headers: { Accept: "application/json", "Request-Id": correlationId },
    }, true);
    const parsed = invoiceSchema.safeParse(JSON.parse((await boundedBody(response)).toString("utf8")) as unknown);
    if (!parsed.success || String(parsed.data.id) !== providerDocumentId) {
      throw new SuperPdpProviderError({
        code: "SUPER_PDP_INVOICE_RESPONSE_INVALID",
        message: "La réponse de lecture SUPER PDP est invalide.",
        httpStatus: 502,
      });
    }
    if (parsed.data.events && parsed.data.events.length > 0) {
      return { invoice: parsed.data, events: parsed.data.events };
    }
    const allEvents: SuperPdpProviderEvent[] = [];
    let startingAfterId: number | null = null;
    const visited = new Set<number>();
    for (;;) {
      const query = new URLSearchParams({ invoice_id: providerDocumentId, limit: "1000" });
      if (startingAfterId !== null) query.set("starting_after_id", String(startingAfterId));
      const eventsResponse = await this.request(`/v1.beta/invoice_events?${query.toString()}`, {
        headers: { Accept: "application/json", "Request-Id": correlationId },
      }, true);
      const events = eventListSchema.safeParse(JSON.parse((await boundedBody(eventsResponse)).toString("utf8")) as unknown);
      if (!events.success) {
        throw new SuperPdpProviderError({
          code: "SUPER_PDP_EVENT_LIST_INVALID",
          message: "La liste d'événements SUPER PDP est invalide.",
          httpStatus: 502,
        });
      }
      allEvents.push(...events.data.data);
      const last = events.data.data.at(-1);
      if (!events.data.has_after || !last) break;
      if (visited.has(last.id)) {
        throw new SuperPdpProviderError({
          code: "SUPER_PDP_EVENT_PAGINATION_STALLED",
          message: "La pagination des événements SUPER PDP ne progresse plus.",
          httpStatus: 502,
        });
      }
      visited.add(last.id);
      startingAfterId = last.id;
    }
    return { invoice: parsed.data, events: allEvents };
  }
}
