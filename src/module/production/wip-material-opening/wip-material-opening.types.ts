import type { PoolClient } from "pg";
import type { WipMaterialCheckpointResolver, WipOpeningInput } from "../wip-opening/wip-opening.types";

export type WipMaterialOpeningState = "NONE_CONSUMED" | "PARTIAL" | "ALL_ALREADY_CONSUMED";

/**
 * A declared opening fact for one material requirement of the historical
 * technical version. It never creates stock, a reservation, a debit or a
 * production declaration.
 */
export type WipMaterialOpeningRequirementInput = {
  technicalPurchaseId: string;
  articleId: string;
  unit: string;
  quantityConsumed: number;
  /** Existing native lot, when the historical lot is still traceable in CERP. */
  physicalLotId?: string | null;
  /** Required for a consumed quantity if no native lot exists. */
  historicalTraceReference?: string | null;
  /** Immutable opening evidence: GED document/reference, not a local path. */
  evidenceReference: string;
  ownerClientId?: string | null;
  qualityStatus?: string | null;
  qualityEvidenceReference?: string | null;
  certificateReference?: string | null;
  /** Historical heat/coulée and category are required when no native lot remains. */
  heatReference?: string | null;
  materialCategory?: string | null;
};

export type WipMaterialOpeningInput = {
  openingStateId: string;
  batchId: string;
  rowId: string;
  articleId: string;
  pieceTechniqueId: string;
  historicalVersionId: string;
  physicalBatchReference: string;
  /** Physical cohort carried into the resumed OF; never the historical total. */
  quantityLaunched: number;
  materialState: WipMaterialOpeningState;
  requirements: WipMaterialOpeningRequirementInput[];
  actorId: number;
};

/** Preview input: no opening state exists before the native application transaction. */
export type WipMaterialOpeningInspectionInput = Omit<WipMaterialOpeningInput, "openingStateId" | "batchId" | "rowId" | "actorId">;

export type PreparedWipMaterialOpening = {
  requirementsHash: string;
  requiresMaterial: boolean;
  expectedRequirements: Array<{
    technicalPurchaseId: string;
    articleId: string;
    articleCode: string | null;
    unit: string;
    requiredQuantity: number;
    designation: string;
    phase: number | null;
    expectedOwnerClientId: string | null;
  }>;
};

export type ValidatedWipMaterialOpening = PreparedWipMaterialOpening & {
  checkpointId: string | null;
  materialState: WipMaterialOpeningState;
};

export type WipMaterialOpeningBinding = {
  checkpointId: string;
  ofId: number;
  boundNeedIds: string[];
};

export type WipMaterialOpeningProjection = {
  /** Null until normal material configuration creates the native need. */
  needId: string | null;
  /** Immutable technical purchase reference, available before native configuration. */
  sourceRef: string;
  consumed: number;
  origin: "CUTOVER_OPENING";
  checkpointId: string;
};

export type WipMaterialOpeningWriter = {
  prepareWipMaterialOpeningTx(tx: PoolClient, input: WipMaterialOpeningInput): Promise<PreparedWipMaterialOpening>;
  validateWipMaterialOpeningTx(tx: PoolClient, input: WipMaterialOpeningInput): Promise<ValidatedWipMaterialOpening>;
  resolveWipMaterialCheckpointTx: WipMaterialCheckpointResolver;
  bindWipMaterialOpeningTx(tx: PoolClient, input: WipOpeningInput, ofId: number): Promise<WipMaterialOpeningBinding>;
};
