import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), missing: false }));
vi.mock('../config/database', () => ({ default: { connect: async () => database } }));
vi.mock('../module/commande-fournisseur/repository/purchase-client-context.repository', () => ({
  readOfPurchaseClientContextsTx: vi.fn(async () => []),
}));
vi.mock('../module/fournisseurs/repository/client-supplier-approval.repository', () => ({
  readApprovalPoliciesTx: vi.fn(async () => []),
}));
import { getOfSupplierRecommendations } from '../module/production/repository/of-supplier-recommendation.repository';

const articleId = '546fe920-19ad-4e32-bd34-668513a0f63e';
const versionId = 'b0639b6b-873e-4bc5-8844-3c947541805e';

beforeEach(() => {
  vi.clearAllMocks();
  database.missing = false;
  database.query.mockImplementation(async (sql: string) => {
    // node-postgres returns bigint identifiers as strings with its default parsers.
    if (sql.includes('AS of_id')) return { rows: database.missing ? [] : [{
      of_id: '92', of_updated_at: '2026-10-10 00:55:00+00', technical_version_id: versionId,
    }] };
    if (sql.startsWith('WITH dossier')) return { rows: [{ id: articleId, position: 1, type: 'MATIERE', catalogue_type: null, categories: [] }] };
    if (sql.includes('AS checked_at')) return { rows: [{ today: '2026-10-10', checked_at: '2026-10-10 01:00:00+00' }] };
    return { rows: [] };
  });
});

describe('supplier recommendation wire context with PostgreSQL bigint IDs', () => {
  it.each([true, false])('returns the validated numeric OF identity, including empty history (price access %s)', async canReadPrices => {
    const result = await getOfSupplierRecommendations(92, { articleId, quantity: 1326, unit: 'mm', currency: 'EUR' }, canReadPrices);
    const wire = JSON.parse(JSON.stringify(result)).data;
    expect(wire.context).toEqual({ of_id: 92, of_updated_at: '2026-10-10 00:55:00+00',
      technical_version_id: versionId, article_id: articleId, quantity: 1326, unit: 'mm', currency: 'EUR' });
    expect(wire.items).toEqual([]);
    expect(wire.recommended_supplier_id).toBeNull();
    expect(wire.can_read_prices).toBe(canReadPrices);
    expect(wire.policy.weights.price).toBe(canReadPrices ? 40 : 0);
    expect(wire.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(database.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(database.query).toHaveBeenCalledWith('COMMIT');
    expect(database.release).toHaveBeenCalledOnce();
  });

  it('does not fabricate a recommendation context when the OF is absent', async () => {
    database.missing = true;
    await expect(getOfSupplierRecommendations(92, { articleId, currency: 'EUR' }, false)).rejects.toMatchObject({ status: 404 });
    expect(database.query).toHaveBeenCalledWith('ROLLBACK');
    expect(database.release).toHaveBeenCalledOnce();
  });
});
