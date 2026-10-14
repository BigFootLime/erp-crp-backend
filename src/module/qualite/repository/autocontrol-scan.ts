import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../../utils/httpError";
import { resolveCerpStoragePath } from "../../../utils/cerpStorage";
import { scanUpload } from "../../../shared/uploads/upload-scanner";
import { qualityDocumentBaseDir } from "./qualite.repository";

export type AutocontrolScanFile = {
  storage_path: string; mime_type: string; size_bytes: string | number; sha256: string | null;
};

/** Read the committed file under the quality root, then scan those exact bytes. */
export async function verifyAutocontrolScanFile(file: AutocontrolScanFile, antivirus: boolean) {
  const size = Number(file.size_bytes);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 25 * 1024 * 1024
    || !file.sha256 || !/^[a-f0-9]{64}$/i.test(file.sha256)
    || !["application/pdf", "image/jpeg", "image/png"].includes(file.mime_type)) {
    throw new HttpError(422, "AUTOCONTROL_SCAN_FORMAT", "Joignez une fiche PDF, JPG ou PNG (25 Mo maximum).");
  }
  const root = await realpath(qualityDocumentBaseDir());
  const candidate = await realpath(resolveCerpStoragePath(file.storage_path, root)).catch(() => null);
  const relative = candidate ? path.relative(root, candidate) : "..";
  if (!candidate || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(409, "AUTOCONTROL_SCAN_UNAVAILABLE", "Le scan enregistré n’est plus disponible.");
  }
  const handle = await open(candidate, "r");
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size) throw new HttpError(409, "AUTOCONTROL_SCAN_CHANGED", "Le scan a changé : joignez à nouveau la fiche.");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== size || digest !== file.sha256.toLowerCase()) {
    throw new HttpError(409, "AUTOCONTROL_SCAN_CHANGED", "Le scan a changé : joignez à nouveau la fiche.");
  }
  if (antivirus) {
    const scan = await scanUpload({ buffer: bytes });
    if (scan.status !== "clean") throw new HttpError(scan.status === "infected" ? 422 : 503,
      "AUTOCONTROL_SCAN_UNVERIFIED", "Le scan doit être vérifié par l’antivirus avant validation.");
  }
  return digest;
}
