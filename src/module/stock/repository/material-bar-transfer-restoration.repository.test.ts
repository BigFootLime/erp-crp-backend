import type { PoolClient, QueryArrayConfig, QueryArrayResult, QueryConfig, QueryConfigValues, QueryResult, QueryResultRow, Submittable } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { MaterialBarInventory } from './material-bar-inventory.repository';

const mocks = vi.hoisted(() => ({ readTrackedMaterialBarInventoryTx: vi.fn() }));

vi.mock('./material-bar-holds.repository', () => ({
  readTrackedMaterialBarInventoryTx: mocks.readTrackedMaterialBarInventoryTx,
}));

import { prepareMaterialBarRestorationTx } from './material-bar-transfer.repository';

const ids = {
  batch: '11111111-1111-4111-8111-111111111111',
  bar: '22222222-2222-4222-8222-222222222222',
  producer: '33333333-3333-4333-8333-333333333333',
  original: '44444444-4444-4444-8444-444444444444',
  replacement: '55555555-5555-4555-8555-555555555555',
};

function inventory(holds: MaterialBarInventory['holds']): MaterialBarInventory {
  return {
    batch: { id: ids.batch, levelId: '66666666-6666-4666-8666-666666666666', lotId: '77777777-7777-4777-8777-777777777777',
      lotCode: 'LOT-BAR', articleId: '88888888-8888-4888-8888-888888888888', articleCode: 'MAT-BAR', designation: 'Barre', unit: 'mm',
      physicalMm: 100, reservedMm: 35, movementCount: '1' },
    bars: [{ id: ids.bar, batchId: ids.batch, code: 'BAR-000001', lengthMm: 100, initialLengthMm: 100, version: 2, createdAt: '2026-11-16T00:00:00.000Z' }],
    holds,
    reservations: [{ id: ids.producer, batchId: ids.batch, remainingMm: 35, version: 1, ofId: 1, ofNumber: 'OF-1' }],
    revision: 1,
    version: 'inventory-version',
    status: 'CONFIRMED',
    warning: null,
  };
}

function transferProof(sourceReservationId = ids.original) {
  return {
    barId: ids.bar,
    version: 3,
    targetReservationId: ids.producer,
    targetMm: 35,
    transfers: [{ reservationId: sourceReservationId, quantityMm: 30 }],
    contextId: 'consolidation-1',
  };
}

class RestorationTransaction {
  constructor(private readonly proof: ReturnType<typeof transferProof>) {}

  query<T extends Submittable>(queryStream: T): T;
  query<R extends any[] = any[], I = any[]>(queryConfig: QueryArrayConfig<I>, values?: QueryConfigValues<I>): Promise<QueryArrayResult<R>>;
  query<R extends QueryResultRow = any, I = any>(queryConfig: QueryConfig<I>): Promise<QueryResult<R>>;
  query<R extends QueryResultRow = any, I = any[]>(queryTextOrConfig: string | QueryConfig<I>, values?: QueryConfigValues<I>): Promise<QueryResult<R>>;
  query<R extends any[] = any[], I = any[]>(queryConfig: QueryArrayConfig<I>, callback: (error: Error, result: QueryArrayResult<R>) => void): void;
  query<R extends QueryResultRow = any, I = any[]>(queryTextOrConfig: string | QueryConfig<I>, callback: (error: Error, result: QueryResult<R>) => void): void;
  query<R extends QueryResultRow = any, I = any[]>(queryText: string, values: QueryConfigValues<I>, callback: (error: Error, result: QueryResult<R>) => void): void;
  query(..._arguments: unknown[]): unknown {
    return Promise.resolve({ command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ after_state: this.proof }] });
  }
}

function transaction(proof = transferProof()): Pick<PoolClient, 'query'> {
  return new RestorationTransaction(proof);
}

const groups = [{ batchId: ids.batch, targetReservationId: ids.producer,
  sources: [{ reservationId: ids.original, quantityMm: 30 }] }];

describe('prepareMaterialBarRestorationTx', () => {
  it('validates the historical transfer IDs before mapping zero-before restoration holds to active replacements', async () => {
    mocks.readTrackedMaterialBarInventoryTx.mockResolvedValue(inventory([
      { barId: ids.bar, reservationId: ids.producer, remainingMm: 35 },
    ]));

    const plans = await prepareMaterialBarRestorationTx(transaction(), 'consolidation-1', groups,
      new Map([[ids.original, ids.replacement]]));

    expect(plans).toHaveLength(1);
    expect(plans[0].changes).toHaveLength(1);
    expect(plans[0].changes[0].assignments).toEqual([
      { reservationId: ids.producer, beforeMm: 35, afterMm: 0 },
      { reservationId: ids.replacement, beforeMm: 0, afterMm: 30 },
    ]);
    expect(plans[0].changes[0].assignments.reduce((sum, assignment) =>
      sum + assignment.afterMm - assignment.beforeMm, 0)).toBe(-5);
  });

  it('rejects a transfer proof rewritten with a replacement ID', async () => {
    mocks.readTrackedMaterialBarInventoryTx.mockResolvedValue(inventory([
      { barId: ids.bar, reservationId: ids.producer, remainingMm: 35 },
    ]));

    await expect(prepareMaterialBarRestorationTx(transaction(transferProof(ids.replacement)), 'consolidation-1', groups,
      new Map([[ids.original, ids.replacement]]))).rejects.toMatchObject({
      status: 409,
      code: 'MATERIAL_BAR_TRANSFER_CHANGED',
    });
  });

  it('rejects a positive old-source hold instead of inventing a zero-before restoration hold', async () => {
    mocks.readTrackedMaterialBarInventoryTx.mockResolvedValue(inventory([
      { barId: ids.bar, reservationId: ids.producer, remainingMm: 35 },
      { barId: ids.bar, reservationId: ids.original, remainingMm: 30 },
    ]));

    await expect(prepareMaterialBarRestorationTx(transaction(), 'consolidation-1', groups,
      new Map([[ids.original, ids.replacement]]))).rejects.toMatchObject({
      status: 409,
      code: 'MATERIAL_BAR_TRANSFER_CHANGED',
    });
  });
});
