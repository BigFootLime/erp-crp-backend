/** Shared, server-side contract for an official generated PDF. */
export type AuthoritativePdfCreationInput = Readonly<{
  entityType: string;
  entityId: string;
  documentKind: string;
  /** Human-facing, monotonic archive edition number; independent of renderer implementation. */
  documentVersion: number;
  renderVersion: string;
  /** Stable producer key, e.g. `commande-client:42:creation:v1`. */
  idempotencyKey: string;
  title: string;
  originalName: string;
  /** Server-derived aggregate revision that a browser can round-trip on reissue. */
  sourceRevision: string;
  sourceSnapshot: Record<string, unknown>;
  actorUserId: number | null;
}>;

export type AuthoritativePdfArchiveRecord = AuthoritativePdfCreationInput & {
  id: string;
  /** Durable queue chronology; never inferred from PDF issuance time. */
  createdAt: string;
  snapshotSha256: string;
  pdfSha256: string | null;
  pdfSizeBytes: number | null;
  gedDocumentId: string | null;
  gedVersionId: string | null;
  archivedAt: string | null;
};

export type AuthoritativePdfProducer = (input: {
  archive: AuthoritativePdfArchiveRecord;
}) => Promise<Buffer>;

export type ArchiveQueueItem = {
  outboxId: string;
  /** Fresh UUID for this lease; prevents a reclaimed worker from finalizing a newer claim. */
  claimToken: string;
  archive: AuthoritativePdfArchiveRecord;
};
