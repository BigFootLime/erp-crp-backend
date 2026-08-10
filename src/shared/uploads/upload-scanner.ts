import { spawn, spawnSync } from "node:child_process";

export type UploadScanStatus = "clean" | "infected" | "unavailable";
export type UploadScanMode = "off" | "monitor" | "enforce";

export type UploadScanInput = Readonly<{
  path?: string;
  buffer?: Buffer;
  signal?: AbortSignal;
}>;

export type UploadScanResult = Readonly<{
  status: UploadScanStatus;
  provider: string;
  reason?: string;
}>;

export interface UploadScanner {
  readonly name: string;
  scan(input: UploadScanInput): Promise<UploadScanResult>;
}

class UnavailableScanner implements UploadScanner {
  readonly name = "none";

  async scan(): Promise<UploadScanResult> {
    return { status: "unavailable", provider: this.name, reason: "scanner_non_configure" };
  }
}

/**
 * Optional ClamAV adapter. It is used only when explicitly configured. The
 * process is spawned without a shell and receives an application-generated
 * path, never a user-provided command fragment.
 */
class ClamDscanScanner implements UploadScanner {
  readonly name = "clamdscan";
  private readonly executable: string;

  constructor() {
    this.executable = process.env.CERP_UPLOAD_SCANNER_COMMAND?.trim() || "clamdscan";
  }

  async scan(input: UploadScanInput): Promise<UploadScanResult> {
    if (input.signal?.aborted) {
      return { status: "unavailable", provider: this.name, reason: "requete_annulee" };
    }
    if (!input.path && !input.buffer) {
      return { status: "unavailable", provider: this.name, reason: "contenu_absent" };
    }

    return await new Promise<UploadScanResult>((resolve) => {
        const args = input.path
          ? ["--fdpass", "--no-summary", "--", input.path]
          : ["--stream", "--no-summary", "-"];
        const child = spawn(this.executable, args, {
          shell: false,
          windowsHide: true,
          stdio: input.buffer ? ["pipe", "ignore", "ignore"] : "ignore",
        });
        let settled = false;
        let pendingTerminationResult: UploadScanResult | null = null;
        let escalationTimer: NodeJS.Timeout | null = null;
        let hardStopTimer: NodeJS.Timeout | null = null;
        let scanTimer: NodeJS.Timeout | null = null;

        const clearTimers = () => {
          if (scanTimer) clearTimeout(scanTimer);
          if (escalationTimer) clearTimeout(escalationTimer);
          if (hardStopTimer) clearTimeout(hardStopTimer);
        };
        const finish = (result: UploadScanResult) => {
          if (settled) return;
          settled = true;
          clearTimers();
          input.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const terminate = (result: UploadScanResult) => {
          if (settled || pendingTerminationResult) return;
          pendingTerminationResult = result;
          child.kill("SIGTERM");
          // Node maps supported signals to TerminateProcess on Windows. Retry
          // with SIGKILL after a short grace period everywhere for a bounded,
          // platform-independent cancellation path.
          escalationTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 250);
          hardStopTimer = setTimeout(() => finish(result), 2_000);
        };

        const onAbort = () => terminate({
          status: "unavailable",
          provider: this.name,
          reason: "requete_annulee",
        });

        child.once("error", () => finish({ status: "unavailable", provider: this.name, reason: "scanner_injoignable" }));
        child.once("exit", (code) => {
          if (pendingTerminationResult) finish(pendingTerminationResult);
          else if (code === 0) finish({ status: "clean", provider: this.name });
          else if (code === 1) finish({ status: "infected", provider: this.name, reason: "contenu_suspect" });
          else finish({ status: "unavailable", provider: this.name, reason: "scanner_en_erreur" });
        });
        input.signal?.addEventListener("abort", onAbort, { once: true });
        if (input.signal?.aborted) onAbort();
        if (input.buffer && child.stdin) {
          // EPIPE is expected when clamd rejects/exits while the bounded memory
          // payload is still being written. The child exit code remains the
          // authoritative scan result.
          child.stdin.on("error", () => undefined);
          child.stdin.end(input.buffer);
        }
        scanTimer = setTimeout(() => terminate({
          status: "unavailable",
          provider: this.name,
          reason: "delai_depasse",
        }), getUploadScannerTimeoutMs());
      });
  }
}

let scannerOverride: UploadScanner | null = null;

export function setUploadScannerForTests(scanner: UploadScanner | null): void {
  scannerOverride = scanner;
}

export function getUploadScanMode(): UploadScanMode {
  const configured = process.env.CERP_UPLOAD_SCAN_MODE?.trim().toLowerCase();
  // Vitest can keep the historical monitor default so unrelated unit tests do
  // not need a ClamAV daemon. Every real runtime, including the Docker image
  // which currently uses NODE_ENV=development, fails closed.
  if (!configured) return process.env.NODE_ENV === "test" ? "monitor" : "enforce";
  if (configured === "off" || configured === "monitor" || configured === "enforce") return configured;
  // An invalid security configuration must not silently disable scanning.
  return "enforce";
}

export type UploadScannerConfiguration = Readonly<{
  mode: UploadScanMode;
  provider: "clamdscan" | "none";
  command: string | null;
  timeoutMs: number;
}>;

export type UploadScannerAvailabilityReason =
  | "provider_missing"
  | "command_unavailable"
  | "probe_timeout"
  | "probe_failed"
  | "daemon_unavailable"
  | "unexpected_version";

export type UploadScannerStartupConfiguration = UploadScannerConfiguration & Readonly<{
  ready: boolean;
  reason?: UploadScannerAvailabilityReason;
}>;

export class UploadScannerUnavailableError extends Error {
  readonly reason: UploadScannerAvailabilityReason;

  constructor(reason: UploadScannerAvailabilityReason, message: string) {
    super(message);
    this.name = "UploadScannerUnavailableError";
    this.reason = reason;
  }
}

const SCANNER_STARTUP_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_SCANNER_TIMEOUT_MS = 120_000;
const MIN_SCANNER_TIMEOUT_MS = 1_000;
const MAX_SCANNER_TIMEOUT_MS = 300_000;

function getUploadScannerTimeoutMs(): number {
  const value = Number(process.env.CERP_UPLOAD_SCANNER_TIMEOUT_MS ?? DEFAULT_SCANNER_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= MIN_SCANNER_TIMEOUT_MS && value <= MAX_SCANNER_TIMEOUT_MS
    ? value
    : DEFAULT_SCANNER_TIMEOUT_MS;
}

function assertClamdscanAvailable(command: string): void {
  // Test doubles use the UploadScanner override and must not require a binary
  // on the machine running Vitest. Real runtimes always perform this preflight.
  if (process.env.NODE_ENV === "test") return;

  const result = spawnSync(command, ["--version"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: SCANNER_STARTUP_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });

  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    const timedOut = errorCode === "ETIMEDOUT";
    const detail = timedOut ? "délai dépassé" : "commande introuvable ou inexécutable";
    throw new UploadScannerUnavailableError(
      timedOut ? "probe_timeout" : "command_unavailable",
      `Scanner ClamAV indisponible au démarrage (${detail}): ${command}`
    );
  }
  if (result.status !== 0) {
    throw new UploadScannerUnavailableError(
      "probe_failed",
      `Scanner ClamAV indisponible au démarrage (code ${result.status ?? "inconnu"}): ${command}`
    );
  }
  const versionOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/\b(?:ClamAV|clamdscan)\b/i.test(versionOutput)) {
    throw new UploadScannerUnavailableError(
      "unexpected_version",
      `Scanner ClamAV indisponible au démarrage (réponse de version inattendue): ${command}`
    );
  }

  const ping = spawnSync(command, ["--ping=1:1"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: SCANNER_STARTUP_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (ping.error || ping.status !== 0) {
    throw new UploadScannerUnavailableError(
      "daemon_unavailable",
      "Scanner ClamAV indisponible au démarrage (daemon ou signatures indisponibles)."
    );
  }
}

/**
 * Strict startup preflight. Deployment validation can use this assertion
 * directly. The application boot path wraps availability failures so the ERP
 * remains reachable while enforced uploads stay fail-closed.
 */
export function assertUploadScannerConfiguration(): UploadScannerConfiguration {
  const rawMode = process.env.CERP_UPLOAD_SCAN_MODE?.trim().toLowerCase();
  if (rawMode && rawMode !== "off" && rawMode !== "monitor" && rawMode !== "enforce") {
    throw new Error(`CERP_UPLOAD_SCAN_MODE invalide: ${rawMode}`);
  }
  if (process.env.NODE_ENV !== "test" && (rawMode === "off" || rawMode === "monitor")) {
    throw new Error(
      `CERP_UPLOAD_SCAN_MODE=${rawMode} interdit hors tests: enforce est obligatoire.`
    );
  }

  const mode = getUploadScanMode();
  const rawTimeout = process.env.CERP_UPLOAD_SCANNER_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const timeout = Number(rawTimeout);
    if (!Number.isSafeInteger(timeout) || timeout < MIN_SCANNER_TIMEOUT_MS || timeout > MAX_SCANNER_TIMEOUT_MS) {
      throw new Error(`CERP_UPLOAD_SCANNER_TIMEOUT_MS invalide: ${rawTimeout}`);
    }
  }
  const rawProvider = process.env.CERP_UPLOAD_SCAN_PROVIDER?.trim().toLowerCase();
  if (rawProvider && rawProvider !== "clamdscan") {
    throw new Error(`CERP_UPLOAD_SCAN_PROVIDER invalide: ${rawProvider}`);
  }
  if (mode === "enforce" && rawProvider !== "clamdscan") {
    throw new UploadScannerUnavailableError(
      "provider_missing",
      "CERP_UPLOAD_SCAN_PROVIDER=clamdscan est obligatoire en mode enforce."
    );
  }

  const command = rawProvider === "clamdscan"
    ? process.env.CERP_UPLOAD_SCANNER_COMMAND?.trim() || "clamdscan"
    : null;

  if (mode === "enforce" && command) assertClamdscanAvailable(command);

  return {
    mode,
    provider: rawProvider === "clamdscan" ? "clamdscan" : "none",
    command,
    timeoutMs: getUploadScannerTimeoutMs(),
  };
}

/**
 * Boot-time view of the scanner. Invalid configuration remains fatal, while a
 * missing/unusable executable produces a safe degraded state. In enforce mode
 * `scanUpload` still rejects every upload with UPLOAD_SCAN_UNAVAILABLE.
 */
export function getUploadScannerStartupConfiguration(): UploadScannerStartupConfiguration {
  try {
    return { ...assertUploadScannerConfiguration(), ready: true };
  } catch (error) {
    if (!(error instanceof UploadScannerUnavailableError)) throw error;

    const rawProvider = process.env.CERP_UPLOAD_SCAN_PROVIDER?.trim().toLowerCase();
    return {
      mode: getUploadScanMode(),
      provider: rawProvider === "clamdscan" ? "clamdscan" : "none",
      command: rawProvider === "clamdscan"
        ? process.env.CERP_UPLOAD_SCANNER_COMMAND?.trim() || "clamdscan"
        : null,
      timeoutMs: getUploadScannerTimeoutMs(),
      ready: false,
      reason: error.reason,
    };
  }
}

/** Non-blocking liveness probe used by readiness and supervision after startup. */
export async function probeUploadScannerHealth(
  startup = getUploadScannerStartupConfiguration()
): Promise<UploadScannerStartupConfiguration> {
  if (!startup.ready || startup.provider !== "clamdscan" || !startup.command) return startup;
  if (process.env.NODE_ENV === "test") return startup;

  return await new Promise((resolve) => {
    const child = spawn(startup.command as string, ["--ping=1:1"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (ready: boolean, reason?: UploadScannerAvailabilityReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...startup, ready, ...(reason ? { reason } : {}) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, "probe_timeout");
    }, SCANNER_STARTUP_PROBE_TIMEOUT_MS);
    child.once("error", () => finish(false, "command_unavailable"));
    child.once("exit", (code) => finish(code === 0, code === 0 ? undefined : "daemon_unavailable"));
  });
}

function configuredScanner(): UploadScanner {
  if (scannerOverride) return scannerOverride;
  const provider = process.env.CERP_UPLOAD_SCAN_PROVIDER?.trim().toLowerCase();
  if (provider === "clamdscan") return new ClamDscanScanner();
  return new UnavailableScanner();
}

export async function scanUpload(input: UploadScanInput): Promise<UploadScanResult & { mode: UploadScanMode }> {
  const mode = getUploadScanMode();
  const rawMode = process.env.CERP_UPLOAD_SCAN_MODE?.trim().toLowerCase();
  if (process.env.NODE_ENV !== "test" && (rawMode === "off" || rawMode === "monitor")) {
    // Defence in depth for code paths/tests that construct the Express app
    // without executing the boot preflight. A forbidden real-runtime mode can
    // never turn into an accepted upload.
    return {
      status: "unavailable",
      provider: "configuration",
      reason: "mode_interdit_hors_tests",
      mode: "enforce",
    };
  }
  if (mode === "off") return { status: "unavailable", provider: "disabled", reason: "scan_desactive", mode };
  const result = await configuredScanner().scan(input);
  return { ...result, mode };
}
