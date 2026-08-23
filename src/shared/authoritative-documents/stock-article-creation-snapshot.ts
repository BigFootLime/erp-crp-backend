import { authoritativePdfFilename } from "./authoritative-document.filename";
import type { AuthoritativePdfCreationInput } from "./authoritative-document.types";
import { buildInternalCreationSnapshot } from "./internal-creation-snapshot";

/** Narrow server-side grammar for root stock-article creation archives. */
export type StockArticleCreationSnapshotInput = Readonly<{
  id: string;
  code: string;
  designation: string;
  articleType: string;
  articleCategory: string;
  familyCode: string;
  unit: string | null;
  status: string;
  stockManaged: boolean;
  lotTracking: boolean;
  isActive: boolean;
  sourceRevision: string;
  actorUserId: number | null;
}>;

/** Builds a generic internal snapshot without exposing procurement notes or file paths. */
export function buildStockArticleCreationSnapshotInput(
  input: StockArticleCreationSnapshotInput
): AuthoritativePdfCreationInput {
  return {
    entityType: "stock-article",
    entityId: input.id,
    documentKind: "STOCK_ARTICLE_CREATION_SNAPSHOT",
    documentVersion: 1,
    renderVersion: "internal-creation-snapshot-v1",
    idempotencyKey: `stock-article:${input.id}:creation:v1`,
    title: `Instantané de création — article ${input.code}`,
    originalName: authoritativePdfFilename(["article", input.code, "creation"]),
    sourceRevision: input.sourceRevision,
    sourceSnapshot: buildInternalCreationSnapshot({
      entityLabel: "Article de stock",
      reference: input.code,
      summary: [
        { label: "Code", value: input.code },
        { label: "Désignation", value: input.designation },
        { label: "Catégorie", value: input.articleCategory },
        { label: "Statut initial", value: input.status },
      ],
      sections: [{
        title: "Classification initiale",
        rows: [
          { label: "Type", value: input.articleType },
          { label: "Famille", value: input.familyCode },
          { label: "Unité", value: input.unit },
          { label: "Gestion de stock", value: input.stockManaged ? "Oui" : "Non" },
          { label: "Suivi par lot", value: input.lotTracking ? "Oui" : "Non" },
          { label: "Actif", value: input.isActive ? "Oui" : "Non" },
        ],
      }],
    }),
    actorUserId: input.actorUserId,
  };
}
