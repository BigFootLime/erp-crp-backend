import { authoritativePdfFilename } from "./authoritative-document.filename";
import type { AuthoritativePdfCreationInput } from "./authoritative-document.types";
import { buildInternalCreationSnapshot } from "./internal-creation-snapshot";

/**
 * Server-side input only. This deliberately has no request DTO or upload fields:
 * a technical-piece creation snapshot is an internal GED record, not the
 * controlled technical dossier or a copy of a customer-supplied file.
 */
export type TechnicalPieceCreationSnapshotInput = Readonly<{
  id: string;
  code: string;
  designation: string;
  clientId: string | null;
  clientName: string | null;
  status: string;
  sourceRevision: string;
  actorUserId: number | null;
  articleId?: string | null;
  familyId?: string | null;
  pieceVersion?: number | null;
  planReference?: string | null;
  externalIndex?: string | null;
  internalVersion?: number | null;
  copiedFromCode?: string | null;
}>;

/** Builds the immutable PDF archive input from a server-read technical root. */
export function buildTechnicalPieceCreationSnapshotInput(
  input: TechnicalPieceCreationSnapshotInput
): AuthoritativePdfCreationInput {
  return {
    entityType: "piece-technique",
    entityId: input.id,
    documentKind: "TECHNICAL_PIECE_CREATION_SNAPSHOT",
    documentVersion: 1,
    renderVersion: "internal-creation-snapshot-v1",
    idempotencyKey: `piece-technique:${input.id}:creation:v1`,
    title: `Instantané de création — pièce technique ${input.code}`,
    originalName: authoritativePdfFilename(["piece-technique", input.code, "creation"]),
    sourceRevision: input.sourceRevision,
    sourceSnapshot: buildInternalCreationSnapshot({
      entityLabel: "Pièce technique",
      reference: input.code,
      summary: [
        { label: "Code", value: input.code },
        { label: "Désignation", value: input.designation },
        { label: "Client", value: input.clientName ?? input.clientId },
        { label: "Statut initial", value: input.status },
      ],
      sections: [{
        title: "Références techniques initiales",
        rows: [
          { label: "Version pièce", value: input.pieceVersion ?? 1 },
          { label: "Référence plan", value: input.planReference ?? null },
          { label: "Indice externe", value: input.externalIndex ?? null },
          { label: "Version interne", value: input.internalVersion ?? null },
          { label: "Article lié", value: input.articleId ?? null },
          { label: "Matière / famille", value: input.familyId ?? null },
          { label: "Copie de", value: input.copiedFromCode ?? null },
        ],
      }],
    }),
    actorUserId: input.actorUserId,
  };
}
