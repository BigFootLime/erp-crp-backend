import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';

type Db = Pick<PoolClient, 'query'>;
type ExpectedPost = { movementId: string; batchId: string; type: 'IN' | 'OUT'; quantityMm: number; correctionOf?: string };
export type MaterialBarPostingOwner = Readonly<{ kind: 'RECEIPT' | 'DEBIT' | 'CORRECTION' }>;
const owners = new WeakMap<MaterialBarPostingOwner, { tx: Db; expected: ExpectedPost }>();

/** Internal capability issued only by the receipt/debit/correction preparers.
 * It is not an HTTP flag and cannot authorize another movement or transaction.
 * Deferred SQL checks still require the owner to finish geometry before COMMIT. */
export function createMaterialBarPostingOwner(tx: Db, kind: MaterialBarPostingOwner['kind'], expected: ExpectedPost): MaterialBarPostingOwner {
  const owner = Object.freeze({ kind });
  owners.set(owner, { tx, expected: { ...expected } });
  return owner;
}

export function consumeMaterialBarPostingOwner(tx: Db, owner: MaterialBarPostingOwner, posted: {
  id: string; batchId: string | null; type: string; quantity: number; reversalOf: string | null;
}) {
  const proof = owners.get(owner);
  if (!proof || proof.tx !== tx || proof.expected.movementId !== posted.id || proof.expected.batchId !== posted.batchId
    || proof.expected.type !== posted.type || !Number.isFinite(posted.quantity) || posted.quantity <= 0
    || proof.expected.quantityMm !== posted.quantity || (proof.expected.correctionOf ?? null) !== posted.reversalOf)
    throw new HttpError(409, 'MATERIAL_BAR_POST_OWNER_INVALID', 'Le parcours matière doit préparer cette sortie, réception ou correction dans sa transaction.');
  owners.delete(owner);
}
