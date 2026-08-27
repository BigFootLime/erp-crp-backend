import { HttpError } from "../../utils/httpError";
import { scanUpload } from "../../shared/uploads/upload-scanner";
import {
  repoAddLink,
  repoCreateDocumentWithVersion,
  repoGetGedBlobReferenceState,
  repoLockGedBlobSha256,
  repoLogAccess,
  repoUpsertBlob,
  withGedBlobSha256Coordination,
  withGedTransaction,
} from "../ged/repository/ged.repository";
import {
  cleanupOwnedVaultBlob,
  writeBlob,
  type VaultBlobOwnership,
} from "../ged/services/ged-vault.service";
import { supplierInvoiceContentSha256 } from "./supplier-invoice.domain";
import { repoMarkInboundArtifactScanFailure } from "./supplier-invoice-inbound.repository";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/xml",
  "text/xml",
  "image/png",
  "image/jpeg",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

function canonicalMimeType(input: string, content: Buffer): string {
  const normalized = input.split(";")[0]!.trim().toLowerCase();
  if (normalized === "application/octet-stream") {
    if (content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
    const prefix = content.subarray(0, Math.min(content.length, 256)).toString("utf8").trimStart();
    if (prefix.startsWith("<?xml") || prefix.startsWith("<")) return "application/xml";
  }
  return normalized;
}

export async function archiveInboundSupplierInvoiceArtifact(params: {
  artifactId: string;
  supplierInvoiceId: string;
  actorUserId: number;
  kind: "ORIGINAL" | "FACTUR_X" | "ATTACHMENT";
  fileName: string;
  mimeType: string;
  expectedSha256: string;
  content: Buffer;
}): Promise<{ documentId: string; versionId: string }> {
  const content = Buffer.from(params.content);
  const actualSha256 = supplierInvoiceContentSha256(content);
  if (actualSha256 !== params.expectedSha256) {
    throw new HttpError(409, "SUPPLIER_INVOICE_ARTIFACT_CHANGED", "La pièce fournisseur a changé après son téléchargement.");
  }
  const mimeType = canonicalMimeType(params.mimeType, content);
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    await repoMarkInboundArtifactScanFailure({
      artifactId: params.artifactId,
      status: "REJECTED",
      provider: "mime-policy",
    });
    throw new HttpError(415, "SUPPLIER_INVOICE_ARTIFACT_TYPE_REJECTED", "Le type de pièce jointe fournisseur n'est pas autorisé dans la GED.");
  }
  const scan = await scanUpload({ buffer: content });
  if (scan.status !== "clean") {
    await repoMarkInboundArtifactScanFailure({
      artifactId: params.artifactId,
      status: scan.status === "infected" ? "REJECTED" : "UNAVAILABLE",
      provider: scan.provider,
      signatureVersion: scan.signature_version,
    });
    throw new HttpError(
      scan.status === "infected" ? 422 : 503,
      scan.status === "infected" ? "SUPPLIER_INVOICE_ARTIFACT_INFECTED" : "SUPPLIER_INVOICE_SCANNER_UNAVAILABLE",
      scan.status === "infected"
        ? "La pièce fournisseur a été refusée par le contrôle antivirus."
        : "Le contrôle antivirus de la pièce fournisseur est indisponible."
    );
  }

  let ownership: VaultBlobOwnership | null = null;
  return withGedTransaction(async (tx) => {
    const artifact = await tx.query<{
      ged_document_id: string | null;
      ged_version_id: string | null;
      supplier_invoice_id: string;
    }>(
      `SELECT ged_document_id::text,ged_version_id::text,supplier_invoice_id::text
         FROM public.supplier_invoice_artifacts WHERE id=$1::uuid FOR UPDATE`,
      [params.artifactId]
    );
    const row = artifact.rows[0];
    if (!row || row.supplier_invoice_id !== params.supplierInvoiceId) {
      throw new HttpError(404, "SUPPLIER_INVOICE_ARTIFACT_NOT_FOUND", "Pièce fournisseur introuvable.");
    }
    if (row.ged_document_id && row.ged_version_id) {
      return { documentId: row.ged_document_id, versionId: row.ged_version_id };
    }
    await repoLockGedBlobSha256(tx, actualSha256);
    const written = await writeBlob(content);
    ownership = written.ownership;
    const blob = await repoUpsertBlob(tx, {
      sha256: written.sha256,
      size_bytes: written.size_bytes,
      mime_type: mimeType,
      storage_key: written.storage_key,
      created_by: params.actorUserId,
    });
    const created = await repoCreateDocumentWithVersion(tx, {
      class_key: "FACTURE_FOURNISSEUR",
      domain: "ACHATS",
      title: `${params.kind === "ORIGINAL" ? "Original" : params.kind === "FACTUR_X" ? "Lisible Factur-X" : "Pièce jointe"} — facture fournisseur`,
      description: "Document reçu par SUPER PDP et archivé automatiquement sans modification.",
      blob_id: blob.id,
      original_name: params.fileName,
      change_reason: "Réception électronique SUPER PDP",
      created_by: params.actorUserId,
    });
    await repoAddLink(tx, {
      document_id: created.document_id,
      entity_type: "SUPPLIER_INVOICE",
      entity_id: params.supplierInvoiceId,
      link_role: params.kind,
      created_by: params.actorUserId,
    });
    await tx.query(
      `UPDATE public.ged_document_versions
          SET status='APPLICABLE',published_at=now()
        WHERE id=$1::uuid`,
      [created.version_id]
    );
    await repoLogAccess(tx, {
      document_id: created.document_id,
      version_id: created.version_id,
      event_type: "UPLOAD",
      actor_id: params.actorUserId,
      details: {
        source: "SUPER_PDP_INBOUND",
        artifact_kind: params.kind,
        size_bytes: written.size_bytes,
        sha256: written.sha256,
        antivirus_provider: scan.provider,
        antivirus_signature_version: scan.signature_version ?? null,
      },
    });
    await tx.query(
      `UPDATE public.supplier_invoice_artifacts
          SET mime_type=$2,scan_status='CLEAN',scan_provider=$3,scan_signature_version=$4,
              ged_document_id=$5::uuid,ged_version_id=$6::uuid,archived_at=now()
        WHERE id=$1::uuid`,
      [params.artifactId,mimeType,scan.provider,scan.signature_version ?? null,created.document_id,created.version_id]
    );
    if (params.kind === "ORIGINAL") {
      await tx.query(
        `UPDATE public.einvoice_documents d
            SET content_storage_reference=$2,updated_at=now()
           FROM public.supplier_invoices si
          WHERE si.id=$1::uuid AND d.id=si.einvoice_document_id`,
        [params.supplierInvoiceId, `ged-version:${created.version_id}`]
      );
    }
    return { documentId: created.document_id, versionId: created.version_id };
  }, {
    afterConfirmedRollback: async () => {
      if (!ownership || ownership.kind === "deduplicated") return;
      await withGedBlobSha256Coordination(actualSha256, async (tx) => {
        const state = await repoGetGedBlobReferenceState(tx, actualSha256);
        if (!state.blob_present && state.reference_count === 0 && ownership) {
          await cleanupOwnedVaultBlob(ownership);
        }
      });
    },
  });
}
