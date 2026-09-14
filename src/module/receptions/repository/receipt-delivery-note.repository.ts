import type { PoolClient } from "pg";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import {
  getDocumentStoragePath,
  resolveCerpStoragePath,
} from "../../../utils/cerpStorage";

export async function assertDeliveryNoteTx(tx: PoolClient, receiptId: string) {
  const docs = (
    await tx.query<{
      id: string;
      storage_path: string;
      sha256: string;
      size_bytes: number;
    }>(
      `SELECT id::text,storage_path,sha256,size_bytes FROM public.reception_fournisseur_documents
    WHERE reception_id=$1::uuid AND removed_at IS NULL AND document_type='BON_LIVRAISON' FOR SHARE`,
      [receiptId],
    )
  ).rows;
  if (!docs.length)
    throw new HttpError(
      422,
      "RECEIPT_DELIVERY_NOTE_REQUIRED",
      "Ajoutez au moins une photo ou un document BL avant de valider la réception.",
    );
  for (const doc of docs) {
    const file = resolveCerpStoragePath(
      doc.storage_path,
      getDocumentStoragePath("receptions"),
    );
    let content: Buffer;
    try {
      content = await fs.readFile(file);
    } catch {
      throw new HttpError(
        409,
        "RECEIPT_DELIVERY_NOTE_UNAVAILABLE",
        "Le BL n’est pas enregistré correctement. Importez-le à nouveau avant validation.",
      );
    }
    if (
      content.byteLength !== Number(doc.size_bytes) ||
      !doc.sha256 ||
      createHash("sha256").update(content).digest("hex") !== doc.sha256
    )
      throw new HttpError(
        409,
        "RECEIPT_DELIVERY_NOTE_CHANGED",
        "L’intégrité du BL ne peut pas être confirmée. Importez-le à nouveau.",
      );
  }
  return docs.map((d) => d.id);
}
