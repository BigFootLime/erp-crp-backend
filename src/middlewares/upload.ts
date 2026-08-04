import { ensureImagesSubdir } from "../utils/imageStorage";
import { createSecureUpload } from "../shared/uploads/secure-upload";
import type { UploadUsage } from "../shared/uploads/upload-policy";

function splitSubdirectory(subdirectory?: string) {
  return (subdirectory ?? "")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function createImageUpload(subdirectory?: string, usage: Extract<UploadUsage, "image" | "tool-media"> = "image") {
  const finalDirectory = ensureImagesSubdir(...splitSubdirectory(subdirectory));
  return createSecureUpload(usage, { storage: { finalDirectory } });
}

export const upload = createImageUpload();
