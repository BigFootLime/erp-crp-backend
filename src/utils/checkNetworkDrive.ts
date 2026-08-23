import { checkOperationalMediaStorage } from "../module/operational-media/services/operational-media-health.service";

/**
 * Backwards-compatible startup probe. The old sentinel SVG made readiness
 * depend on arbitrary content; this checks the private media root itself.
 */
export async function checkNetworkDrive(): Promise<void> {
  const storage = await checkOperationalMediaStorage();
  if (!storage.ready) throw new Error(`OPERATIONAL_MEDIA_STORAGE_${storage.reason ?? "UNAVAILABLE"}`);
}
