import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getImagesRootPath } from "../../../utils/imageStorage";
import {
  getUploadScannerStartupConfiguration,
  probeUploadScannerHealth,
  type UploadScannerStartupConfiguration,
} from "../../../shared/uploads/upload-scanner";

export type OperationalMediaStorageHealth = Readonly<{
  ready: boolean;
  readable: boolean;
  writable: boolean;
  reason: "not_directory" | "not_readable" | "not_writable" | "unavailable" | null;
}>;

/**
 * Measures the private image root without exposing its physical path. Reads
 * and writes are reported separately so the UI never enables an upload merely
 * because historical previews remain readable.
 */
export async function checkOperationalMediaStorage(): Promise<OperationalMediaStorageHealth> {
  const root = getImagesRootPath();
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return { ready: false, readable: false, writable: false, reason: "not_directory" };
    }

    let readable = true;
    let writable = false;
    await fs.access(root, constants.R_OK).catch(() => { readable = false; });
    // Permission bits alone do not prove an NFS mount, quota, ACL or disk can
    // accept an upload. Use a unique 0600 probe, fsync it, then remove only
    // that exact file. A failed write leaves historical previews readable.
    if (readable) {
      const probePath = path.join(root, `.cerp-operational-media-probe-${randomUUID()}`);
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      let created = false;
      try {
        handle = await fs.open(probePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        created = true;
        await handle.writeFile(Buffer.from("cerp-operational-media-probe", "utf8"));
        await handle.sync();
        writable = true;
      } catch {
        writable = false;
      } finally {
        await handle?.close().catch(() => undefined);
        if (created) await fs.unlink(probePath).catch(() => undefined);
      }
    }
    return {
      ready: readable && writable,
      readable,
      writable,
      reason: !readable ? "not_readable" : !writable ? "not_writable" : null,
    };
  } catch {
    return { ready: false, readable: false, writable: false, reason: "unavailable" };
  }
}

export type OperationalMediaCapabilities = Readonly<{
  contract_version: 1;
  status: "available" | "degraded";
  authenticated_fetch_required: true;
  direct_img_src_supported: false;
  content_endpoint: "/api/v1/operational-media/:assetId/content";
  preview_supported: boolean;
  download_supported: boolean;
  upload_promotion_supported: boolean;
  storage: Readonly<{ ready: boolean; readable: boolean; writable: boolean; reason_code: string | null }>;
  antivirus: Readonly<{ ready: boolean; reason_code: string | null }>;
}>;

export async function collectOperationalMediaCapabilities(
  scannerStartup?: UploadScannerStartupConfiguration,
): Promise<OperationalMediaCapabilities> {
  const [storage, scanner] = await Promise.all([
    checkOperationalMediaStorage(),
    probeUploadScannerHealth(scannerStartup ?? getUploadScannerStartupConfiguration()),
  ]);
  const previewSupported = storage.readable;
  const uploadSupported = storage.ready && scanner.ready;
  return {
    contract_version: 1,
    status: previewSupported && uploadSupported ? "available" : "degraded",
    authenticated_fetch_required: true,
    direct_img_src_supported: false,
    content_endpoint: "/api/v1/operational-media/:assetId/content",
    preview_supported: previewSupported,
    download_supported: previewSupported,
    upload_promotion_supported: uploadSupported,
    storage: {
      ready: storage.ready,
      readable: storage.readable,
      writable: storage.writable,
      reason_code: storage.reason,
    },
    antivirus: {
      ready: scanner.ready,
      reason_code: scanner.ready ? null : scanner.reason ?? "not_ready",
    },
  };
}
