import type { PoolClient } from "pg";

export type WipOpeningCheckpointStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
export type WipOpeningMaterialScope = "NONE" | "SINGLE_BATCH_VALIDATED";

export type WipOpeningCheckpointInput = {
  phase: number;
  status: WipOpeningCheckpointStatus;
  quantityGood: number;
  quantityScrap: number;
  quantityPendingControl: number;
  evidenceReference: string;
};

/**
 * Input is intentionally native-ID based.  The data-cutover adapter resolves
 * historical codes before it gets here; this writer never fuzzy-matches a
 * customer, article, technical version or operation.
 */
export type WipOpeningInput = {
  openingStateId: string;
  batchId: string;
  rowId: string;
  sourceSystem: string;
  operationKey: string;
  articleId: string;
  /**
   * All target identifiers are resolved server-side from the cutover
   * crosswalk. They are never free text entered by an operator.
   */
  affair: {
    type: "COMMANDE_CLIENT" | "BESOIN_INTERNE";
    id: string;
    /** Required by the native writer; optional at the crosswalk-preview boundary. */
    commandLineId?: string | null;
    /** Mandatory for a customer delivery; internal demand has no delivery affair. */
    deliveryAffairId?: string | null;
  };
  pieceTechniqueId: string;
  historicalVersionId: string;
  /** The still-physical cohort to continue in the new OF, never original total by default. */
  quantityLaunched: number;
  unit: string;
  historicalInitialQuantity?: number | null;
  physicalBatchReference: string;
  materialScope: WipOpeningMaterialScope;
  /** Required for material-bearing work; validated by the material adapter, not caller text. */
  materialCheckpointId?: string | null;
  materialEvidenceReference?: string | null;
  checkpoints: WipOpeningCheckpointInput[];
  actorId: number;
};

export type ValidatedWipMaterialCheckpoint = {
  requiresMaterial: boolean;
  checkpointId: string | null;
  physicalBatchReference: string | null;
};

export type WipMaterialCheckpointResolver = (
  tx: PoolClient,
  input: WipOpeningInput
) => Promise<ValidatedWipMaterialCheckpoint>;

export type WipOpeningResumeResult = {
  resumptionId: string;
  ofId: number;
  ofReference: string;
  operationIdsByPhase: Record<number, string>;
};

export type WipOpeningReadModel = {
  operationId: string;
  phase: number;
  status: WipOpeningCheckpointStatus;
  quantityGood: number;
  quantityScrap: number;
  quantityPendingControl: number;
  unit: string;
  origin: "CUTOVER_OPENING";
};
