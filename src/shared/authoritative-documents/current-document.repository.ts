import type { PoolClient } from "pg";
import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";
import { authoritativePdfFilename } from "./authoritative-document.filename";
import { repoFindAuthoritativePdfByIdempotency } from "./authoritative-document.repository";
import {
  canonicalJson,
  queueCreationPdfArchive,
  sha256Text,
} from "./authoritative-document.service";
import type { InternalCreationSnapshot } from "./internal-creation-snapshot";

export type CurrentDocumentSource = {
  snapshot: InternalCreationSnapshot;
  sourceRevision: string;
};
export const currentDocumentSource = (
  snapshot: InternalCreationSnapshot,
): CurrentDocumentSource => ({
  snapshot,
  sourceRevision: sha256Text(canonicalJson(snapshot)),
});

/** Fixed module-owned producer; never accepts document kinds or source values from HTTP. */
export async function queueCurrentDocument(params: {
  entityType: "piece-technique-version" | "ordre-fabrication";
  entityId: string;
  documentKind: "TECHNICAL_SHEET" | "OF_TRAVELER";
  renderVersion: string;
  title: string;
  filenamePrefix: string;
  idempotencyKey: string;
  actorUserId: number | null;
  input: { source_revision: string; reissue_reason?: string | null };
  loadSource: (tx: PoolClient) => Promise<CurrentDocumentSource>;
  audit: (tx: PoolClient, details: Record<string, unknown>) => Promise<void>;
}) {
  const tx = await pool.connect();
  let committing = false;
  try {
    await tx.query("BEGIN");
    // Serializes edition numbering, including retries from different browser tabs.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${params.entityType}:${params.entityId}:${params.documentKind}`,
    ]);
    const replay = await repoFindAuthoritativePdfByIdempotency(
      tx,
      params.idempotencyKey,
    );
    if (replay) {
      if (
        replay.entityType !== params.entityType ||
        replay.entityId !== params.entityId ||
        replay.documentKind !== params.documentKind ||
        replay.sourceRevision !== params.input.source_revision
      ) {
        throw new HttpError(
          409,
          "OFFICIAL_DOCUMENT_IDEMPOTENCY_CONFLICT",
          "Cette clé correspond à une autre édition PDF.",
        );
      }
      await params.audit(tx, { archive_id: replay.id, replayed: true });
      committing = true;
      await tx.query("COMMIT");
      return replay;
    }
    const source = await params.loadSource(tx);
    if (source.sourceRevision !== params.input.source_revision) {
      throw new HttpError(
        409,
        "OFFICIAL_DOCUMENT_SOURCE_REVISION_CONFLICT",
        "Les données ont changé. Rechargez le document avant de créer le PDF.",
      );
    }
    const editions = await tx.query<{ edition: number }>(
      `SELECT COALESCE(max(document_version),0)::int AS edition
      FROM public.authoritative_pdf_archives WHERE entity_type=$1 AND entity_id=$2 AND document_kind=$3`,
      [params.entityType, params.entityId, params.documentKind],
    );
    const edition = editions.rows[0].edition + 1;
    if (edition > 1 && !params.input.reissue_reason?.trim()) {
      throw new HttpError(
        422,
        "OFFICIAL_DOCUMENT_REISSUE_REASON_REQUIRED",
        "Indiquez le motif de cette nouvelle édition.",
      );
    }
    const archive = await queueCreationPdfArchive(tx, {
      entityType: params.entityType,
      entityId: params.entityId,
      documentKind: params.documentKind,
      documentVersion: edition,
      renderVersion: params.renderVersion,
      idempotencyKey: params.idempotencyKey,
      title: `${params.title} ${source.snapshot.reference}`,
      originalName: authoritativePdfFilename([
        params.filenamePrefix,
        source.snapshot.reference,
        `v${edition}`,
      ]),
      sourceRevision: source.sourceRevision,
      sourceSnapshot: source.snapshot,
      actorUserId: params.actorUserId,
    });
    await params.audit(tx, {
      archive_id: archive.id,
      edition,
      source_revision: source.sourceRevision,
      reissue_reason: params.input.reissue_reason?.trim() ?? null,
      replayed: false,
    });
    committing = true;
    await tx.query("COMMIT");
    return archive;
  } catch (error) {
    try {
      await tx.query("ROLLBACK");
    } catch {
      /* The caller must retain its retry key when commit is uncertain. */
    }
    if (committing)
      throw new HttpError(
        503,
        "OFFICIAL_DOCUMENT_COMMIT_UNCERTAIN",
        "La confirmation du dépôt a été interrompue. Réessayez avec la même clé.",
      );
    throw error;
  } finally {
    tx.release();
  }
}
