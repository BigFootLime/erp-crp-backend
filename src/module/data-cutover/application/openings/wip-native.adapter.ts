import type { PoolClient } from "pg";
import type { CutoverRow } from "../../types/data-cutover.types";
import type { CutoverTarget } from "./openings.contract";
import { prepareNativeWipInputTx } from "./wip-preparation.contract";
import { parseWipMaterialPayload } from "../../domain/wip-material-payload";
import { assertWipResumeTargetsTx, resumeWipOpeningTx } from "../../../production/wip-opening/wip-opening.repository";
import { bindWipMaterialOpeningTx, inspectWipMaterialDeclarationTx, resolveWipMaterialCheckpointTx, validateWipMaterialOpeningTx } from "../../../production/wip-material-opening/wip-material-opening.repository";

type NativeWipPreparation = {
  row: CutoverRow; article: CutoverTarget; affair: CutoverTarget; actorId: number;
  sourceSystem: string; operationKey: string;
};

/** Preview and posting perform the same business checks. No opening row,
 * material checkpoint, OF or stock fact is written by this inspection. */
export async function inspectNativeWipPreparationTx(tx: PoolClient, params: NativeWipPreparation) {
  const input = await prepareNativeWipInputTx(tx, params.row, { article: params.article, affair: params.affair }, params.actorId, params.sourceSystem, params.operationKey);
  await assertWipResumeTargetsTx(tx, input);
  const material = parseWipMaterialPayload(params.row.values.materialOpening);
  await inspectWipMaterialDeclarationTx(tx, { ...input, ...material });
  return { input, material };
}

/** Caller owns the transaction that created the opening and its native target.
 * A failure in any material/OF/binding step rolls back the whole operation. */
export async function resumeNativeWipPreparationTx(tx: PoolClient, params: NativeWipPreparation & { openingStateId: string }) {
  const { input, material } = await inspectNativeWipPreparationTx(tx, params);
  const checked = await validateWipMaterialOpeningTx(tx, { ...input, ...material, openingStateId: params.openingStateId });
  const nativeInput = {
    ...input, openingStateId: params.openingStateId,
    materialScope: checked.requiresMaterial ? "SINGLE_BATCH_VALIDATED" as const : "NONE" as const,
    materialCheckpointId: checked.checkpointId,
  };
  const result = await resumeWipOpeningTx(tx, nativeInput, { resolveMaterialCheckpoint: resolveWipMaterialCheckpointTx });
  await bindWipMaterialOpeningTx(tx, nativeInput, result.ofId);
  return result;
}
