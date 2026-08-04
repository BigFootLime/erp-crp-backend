import { createSecureUpload } from "../shared/uploads/secure-upload";
import type { UploadUsage } from "../shared/uploads/upload-policy";

/**
 * Image middleware is deliberately staging-only. The subdirectory remains in
 * the public signature for legacy callers, but durable placement belongs to
 * the business transaction that persists the corresponding database path.
 */
export function createImageUpload(_subdirectory?: string, usage: Extract<UploadUsage, "image" | "tool-media"> = "image") {
  return createSecureUpload(usage, { storage: "staging" });
}

export const upload = createImageUpload();
