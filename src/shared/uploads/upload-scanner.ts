import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureTmpStoragePath } from "../../utils/cerpStorage";

export type UploadScanStatus = "clean" | "infected" | "unavailable";
export type UploadScanMode = "off" | "monitor" | "enforce";

export type UploadScanInput = Readonly<{
  path?: string;
  buffer?: Buffer;
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
    const temporaryPath = input.path ? null : path.join(ensureTmpStoragePath("upload-scanner"), `${randomUUID()}.scan`);
    const scanPath = input.path ?? temporaryPath;
    if (!scanPath || (!input.path && !input.buffer)) {
      return { status: "unavailable", provider: this.name, reason: "contenu_absent" };
    }

    if (temporaryPath && input.buffer) await fs.writeFile(temporaryPath, input.buffer, { flag: "wx", mode: 0o600 });

    try {
      return await new Promise<UploadScanResult>((resolve) => {
        const child = spawn(this.executable, ["--no-summary", "--", scanPath], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        let settled = false;
        const finish = (result: UploadScanResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish({ status: "unavailable", provider: this.name, reason: "delai_depasse" });
        }, 30_000);
        child.once("error", () => finish({ status: "unavailable", provider: this.name, reason: "scanner_injoignable" }));
        child.once("exit", (code) => {
          if (code === 0) finish({ status: "clean", provider: this.name });
          else if (code === 1) finish({ status: "infected", provider: this.name, reason: "contenu_suspect" });
          else finish({ status: "unavailable", provider: this.name, reason: "scanner_en_erreur" });
        });
      });
    } finally {
      if (temporaryPath) await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

let scannerOverride: UploadScanner | null = null;

export function setUploadScannerForTests(scanner: UploadScanner | null): void {
  scannerOverride = scanner;
}

export function getUploadScanMode(): UploadScanMode {
  const configured = process.env.CERP_UPLOAD_SCAN_MODE?.trim().toLowerCase();
  if (!configured) return process.env.NODE_ENV === "production" ? "enforce" : "monitor";
  if (configured === "off" || configured === "monitor" || configured === "enforce") return configured;
  // An invalid security configuration must not silently disable scanning.
  return "enforce";
}

function configuredScanner(): UploadScanner {
  if (scannerOverride) return scannerOverride;
  const provider = process.env.CERP_UPLOAD_SCAN_PROVIDER?.trim().toLowerCase();
  if (provider === "clamdscan") return new ClamDscanScanner();
  return new UnavailableScanner();
}

export async function scanUpload(input: UploadScanInput): Promise<UploadScanResult & { mode: UploadScanMode }> {
  const mode = getUploadScanMode();
  if (mode === "off") return { status: "unavailable", provider: "disabled", reason: "scan_desactive", mode };
  const result = await configuredScanner().scan(input);
  return { ...result, mode };
}
