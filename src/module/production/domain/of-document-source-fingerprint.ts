import type { OfDocumentPayload } from "./of-document";
import { hashSnapshot } from "./of-revision";

/** Preview and official edition differ in presentation metadata, not in the facts the user approves. */
export function ofDocumentSourceFingerprint(payload: OfDocumentPayload): string {
  const { generatedAt: _generatedAt, auteur: _auteur, documentStatut: _documentStatut, watermark: _watermark,
    sourceFingerprint: _sourceFingerprint, ...facts } = payload;
  return hashSnapshot(facts);
}
