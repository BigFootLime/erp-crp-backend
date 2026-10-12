import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import type { MaterialBarMovementCommand } from '../domain/material-bar-movement';
import { lockMaterialBarReceiptLotTx } from './material-bar-receipt.repository';
import { prepareMaterialBarMovementTx, applyMaterialBarMovementTx } from './material-bar-movement.repository';
import { prepareMaterialBarCompensationTx, applyMaterialBarCompensationTx } from './material-bar-compensation.repository';
import { consumeMaterialBarPostingOwner, type MaterialBarPostingOwner } from './material-bar-posting-owner';

type Db = Pick<PoolClient, 'query'>;
export type MaterialBarPostingScope = { enabled: boolean; required: boolean };

/** Resolve the article's canonical unit, not the unit typed on the movement.
 * Take material lot/reservation locks before movement posting locks stock. */
export async function lockMaterialBarPostingScopeTx(tx: Db, input: {
  articleId: string; lotIds: string[]; explicit: boolean;
}): Promise<MaterialBarPostingScope> {
  const article = (await tx.query<{ millimetres: boolean; required: boolean }>(`SELECT lower(trim(a.unite))='mm' AS millimetres,
    COALESCE(am.barre_a_decouper,false) AS required FROM public.articles a
    LEFT JOIN public.articles_matiere am ON am.article_id=a.id WHERE a.id=$1::uuid`, [input.articleId])).rows[0];
  if (!article) throw new HttpError(404, 'ARTICLE_NOT_FOUND', 'Article introuvable.');
  if (!article.millimetres) {
    if (input.explicit) throw new HttpError(422, 'MATERIAL_BAR_UNIT_REQUIRED', 'Le suivi des barres concerne les matières gérées en millimètres.');
    return { enabled: false, required: false };
  }
  const schema = (await tx.query<{ installed: boolean; ready: boolean }>(`SELECT
    to_regclass('public.stock_material_bar_inventories') IS NOT NULL AS installed,
    to_regprocedure('public.check_material_bar_stock_1246()') IS NOT NULL AS ready`)).rows[0];
  if ((!schema?.ready || !schema?.installed) && (schema?.installed || article.required || input.explicit))
    throw new HttpError(409, 'MATERIAL_BARS_NOT_INSTALLED', 'La mise à jour du suivi des barres doit précéder les mouvements de cette matière.');
  if (!schema?.installed) return { enabled: false, required: false };
  for (const lotId of [...new Set(input.lotIds)].sort()) await lockMaterialBarReceiptLotTx(tx, lotId);
  return { enabled: true, required: article.required };
}

export async function prepareMaterialBarPostingTx(tx: Db, input: {
  scope: MaterialBarPostingScope; movement: { id: string; batchId: string | null; type: string; quantity: number; reversalOf: string | null };
  destinationBatchId?: string | null; command?: MaterialBarMovementCommand; owner?: MaterialBarPostingOwner; externalTransaction: boolean;
}) {
  const { scope, movement, command, owner } = input;
  if (owner) {
    if (!scope.enabled || command || !input.externalTransaction)
      throw new HttpError(409, 'MATERIAL_BAR_POST_OWNER_INVALID', 'Le parcours matière doit terminer son mouvement dans une transaction unique.');
    consumeMaterialBarPostingOwner(tx, owner, movement);
    return null;
  }
  if (!scope.enabled) {
    if (command) throw new HttpError(422, 'MATERIAL_BAR_UNIT_REQUIRED', 'Ce mouvement ne permet pas le suivi des barres.');
    return null;
  }
  const batches = [movement.batchId, input.destinationBatchId].filter((id): id is string => !!id);
  const tracked = (await tx.query<{ tracked: boolean }>(`SELECT EXISTS(SELECT 1 FROM public.stock_material_bar_inventories
    WHERE stock_batch_id=ANY($1::uuid[])) AS tracked`, [batches])).rows[0]?.tracked;
  if (!scope.required && !tracked && !command) return null;
  if (!movement.batchId || (movement.type === 'TRANSFER' && !input.destinationBatchId))
    throw new HttpError(422, 'MATERIAL_BAR_BATCH_REQUIRED', 'Sélectionnez le lot et son emplacement avant de confirmer les barres.');
  if (movement.reversalOf) {
    if (command) throw new HttpError(422, 'MATERIAL_BAR_COMPENSATION_AUTOMATIC', 'Les barres à restituer sont reprises automatiquement du mouvement d’origine.');
    return prepareMaterialBarCompensationTx(tx, { movementId: movement.id, destinationBatchId: input.destinationBatchId ?? undefined });
  }
  if (!command) throw new HttpError(422, 'MATERIAL_BAR_MOVEMENT_REQUIRED', 'Sélectionnez les barres et leurs longueurs avant de comptabiliser ce mouvement.');
  return prepareMaterialBarMovementTx(tx, { movementId: movement.id, sourceBatchId: movement.batchId,
    destinationBatchId: input.destinationBatchId ?? undefined, command });
}

export async function applyMaterialBarPostingTx(tx: Db, prepared: NonNullable<Awaited<ReturnType<typeof prepareMaterialBarPostingTx>>>, actor: number) {
  if ('plan' in prepared) return applyMaterialBarMovementTx(tx, prepared, actor);
  return applyMaterialBarCompensationTx(tx, prepared, actor);
}
