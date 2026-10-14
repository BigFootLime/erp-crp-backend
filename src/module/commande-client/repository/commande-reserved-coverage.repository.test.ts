import { describe, expect, it, vi } from 'vitest';
import { readFullyReservedCommandeCoverage } from './commande-reserved-coverage.repository';

const lines = [{ commande_ligne_id: 205, article_id: 'article-axe', qty_ordered: 12 }];
const reservation = { commande_ligne_id: 205, article_id: 'article-axe', quantity: 12, stock_scope: 'NEW',
  stock_level_id: 'level-axe', physical_reserved: 12, usable_physical: 20, lot_released: true };
function db(rows: unknown[]) { return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows })) }; }

describe('already owned stock coverage', () => {
  it('counts the twelve owned units even though the free pool has only eight left', async () => {
    const tx = db([reservation]);
    await expect(readFullyReservedCommandeCoverage(tx as never, 109, lines)).resolves.toEqual(new Map([[205, { old_qty: 0, new_qty: 12 }]]));
    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('line.commande_id = $1'), [109]);
    expect(tx.query.mock.calls.some(([sql]) => /\b(UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(false);
  });
  it('keeps OLD and NEW provenance and sums multiple physical reservations exactly once', async () => {
    const tx = db([{ ...reservation, quantity: 4, stock_scope: 'OLD' }, { ...reservation, quantity: 8 }]);
    await expect(readFullyReservedCommandeCoverage(tx as never, 109, lines)).resolves.toEqual(new Map([[205, { old_qty: 4, new_qty: 8 }]]));
  });
  it.each([
    { quantity: 11 }, { quantity: 13 }, { quantity: -1 }, { quantity: Number.NaN },
    { article_id: 'different-article' }, { commande_ligne_id: 206 }, { lot_released: false },
    { stock_scope: 'UNKNOWN' }, { physical_reserved: 11 }, { usable_physical: 11 }, { physical_reserved: Number.NaN },
  ])('never declares a contradictory or unusable reservation fully covered: %j', async change => {
    await expect(readFullyReservedCommandeCoverage(db([{ ...reservation, ...change }]) as never, 109, lines)).resolves.toBeNull();
  });
  it('does not lend one line reservation to another line of the same article', async () => {
    await expect(readFullyReservedCommandeCoverage(db([reservation]) as never, 109,
      [...lines, { ...lines[0]!, commande_ligne_id: 206, qty_ordered: 1 }])).resolves.toBeNull();
  });
  it('checks the summed reservations against their shared physical level', async () => {
    const tx = db([{ ...reservation, quantity: 6, physical_reserved: 10 }, { ...reservation, quantity: 6, physical_reserved: 10 }]);
    await expect(readFullyReservedCommandeCoverage(tx as never, 109, lines)).resolves.toBeNull();
  });
  it('leaves unreserved commands to the normal free stock analysis', async () => {
    await expect(readFullyReservedCommandeCoverage(db([]) as never, 109, lines)).resolves.toBeNull();
  });
  it.each([{batch_reserved: 11,batch_usable: 20},{batch_reserved: 12,batch_usable: 11},{batch_reserved: null,batch_usable: null}])('rejects a missing or insufficient physical batch: %j', async batch => {
    await expect(readFullyReservedCommandeCoverage(db([{...reservation,stock_batch_id:'batch-axe',...batch}]) as never,109,lines)).resolves.toBeNull();
  });
  it('accepts the reserved physical batch without reserving it again', async () => {
    await expect(readFullyReservedCommandeCoverage(db([{...reservation,stock_batch_id:'batch-axe',batch_reserved:12,batch_usable:20}]) as never,109,lines)).resolves.toEqual(new Map([[205,{old_qty:0,new_qty:12}]]));
  });
});
