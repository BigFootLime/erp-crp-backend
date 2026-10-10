import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCustomerOrderV2AfterLaunch, repairCustomerOrderV2StockOnlyPlanning } from './commande-client.repository';

const auditWrite = vi.hoisted(() => vi.fn());
vi.mock('../../audit-logs/repository/audit-logs.repository', () => ({ repoInsertAuditLog: auditWrite }));
vi.mock('../../notifications/repository/notifications.repository', () => ({
  repoListUsersForCommandePlanningNotification: vi.fn(async () => []),
  repoCreateAppNotifications: vi.fn(async () => []),
}));

const audit = {
  user_id: 7, user_role: 'Administrateur système et réseau', ip: null, user_agent: null,
  device_type: null, os: null, browser: null, path: '/commandes/112/generate-affaires',
  page_key: 'commandes', client_session_id: null,
};

function transaction(options: { status?: string; eligible?: boolean; allocated?: number; reserved?: number; actualReserved?: number | null; toProduce?: number } = {}) {
  let status = options.status ?? 'ATTENTE_PLANNING';
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('st.nouveau_statut AS raw_statut')) return { rows: [{ id: '112', numero: 'CMD-1235', client_id: '195', order_type: 'STANDARD', raw_statut: status }] };
    if (sql.includes('AS eligible')) return { rows: [{ eligible: options.eligible ?? true }] };
    if (sql.includes('line.quantite::float8 AS quantity')) return { rows: [{ id: 209, quantity: 2, allocated: options.allocated ?? 2, reserved: options.reserved ?? 2, to_produce: options.toProduce ?? 0 }] };
    if (sql.includes('FROM public.stock_reservations reservation') && sql.includes('FOR UPDATE')) {
      return { rows: options.actualReserved === null ? [] : [{ id: 'reservation-old', commande_ligne_id: 209, qty_reserved: options.actualReserved ?? 2 }] };
    }
    if (sql.includes('SELECT nouveau_statut')) return { rows: [{ nouveau_statut: status }] };
    if (sql.includes('INSERT INTO') && sql.includes('commande_historique')) {
      status = String(values?.[3]); return { rows: [{ id: '13' }] };
    }
    if (sql.includes('FROM commande_client') || sql.includes('FROM public.commande_client')) return { rows: [{ id: 112, numero: 'CMD-1235', client_id: '195', order_type: 'STANDARD' }] };
    return { rows: [] };
  });
  return { tx: { query } as unknown as PoolClient, query, status: () => status };
}

beforeEach(() => vi.clearAllMocks());

describe('customer order v2 stock-only handoff', () => {
  it('prepares AR from a draft fully covered by stock, without activating planning or creating a BL', async () => {
    const { tx, query, status } = transaction({ status: 'BROUILLON' });
    await expect(advanceCustomerOrderV2AfterLaunch({ tx, commande_id: 112, user_id: 7, needs_production: false, has_technical_warnings: false, of_ids: [] })).resolves.toBe('AR_PRET');
    expect(status()).toBe('AR_PRET');
    expect(query.mock.calls.some(([sql, values]) => sql.includes("WHEN checkpoint_code = 'ar_sent' THEN 'active'") && String(values?.[2]).includes('stock_only_flow'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes('CASE WHEN $3::boolean OR $5::boolean'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO.*(?:bon_livraison|stock_reservations|ordres_fabrication)/s.test(sql))).toBe(false);
  });

  it.each([
    { needs_production: true, has_technical_warnings: false, of_ids: [94], expected: 'ATTENTE_PLANNING' },
    { needs_production: true, has_technical_warnings: true, of_ids: [94], expected: 'ATTENTE_TECHNIQUE' },
    { needs_production: true, has_technical_warnings: false, of_ids: [], waiting_contract_supply: true, expected: 'ATTENTE_OF' },
    { needs_production: false, has_technical_warnings: true, of_ids: [], expected: 'ATTENTE_TECHNIQUE' },
    { needs_production: false, has_technical_warnings: false, of_ids: [94], expected: 'ATTENTE_PLANNING' },
  ])('keeps the production/technical/contract gate: $expected', async ({ expected, ...input }) => {
    const { tx, query } = transaction({ status: 'BROUILLON' });
    await expect(advanceCustomerOrderV2AfterLaunch({ tx, commande_id: 112, user_id: 7, ...input })).resolves.toBe(expected);
    expect(query.mock.calls.some(([sql]) => sql.includes("WHEN checkpoint_code = 'ar_sent' THEN 'active'"))).toBe(false);
  });
});

describe('explicit repair of a fully reserved v2 launch', () => {
  it('reuses the exact two reserved units, records the transition/audit and is side-effect free on a second replay', async () => {
    const { tx, query, status } = transaction();
    const input = { tx, commande_id: 112, audit, ar_sent_at: null, of_ids: [] };
    await expect(repairCustomerOrderV2StockOnlyPlanning(input)).resolves.toBe(true);
    expect(status()).toBe('AR_PRET');
    expect(auditWrite).toHaveBeenCalledOnce();
    expect(auditWrite).toHaveBeenCalledWith(expect.objectContaining({ tx, body: expect.objectContaining({ action: 'commandes.stock_only_workflow.repair', details: expect.objectContaining({ reservations_unchanged: true }) }) }));
    expect(query.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE).*public\.(?:stock_reservations|affaire|bon_livraison|ordres_fabrication)/s.test(sql))).toBe(false);
    const writes = query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT INTO)/.test(sql)).length;
    await expect(repairCustomerOrderV2StockOnlyPlanning(input)).resolves.toBe(false);
    expect(query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT INTO)/.test(sql))).toHaveLength(writes);
  });

  it.each([
    { status: 'AR_ENVOYE' }, { eligible: false }, { allocated: 1 }, { reserved: 1 },
    { toProduce: 1 }, { actualReserved: null },
  ])('does not change a downstream, ineligible, missing or partial coverage: %j', async options => {
    const { tx, query } = transaction(options);
    await expect(repairCustomerOrderV2StockOnlyPlanning({ tx, commande_id: 112, audit, ar_sent_at: null, of_ids: [] })).resolves.toBe(false);
    expect(query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT INTO)/.test(sql))).toBe(false);
  });

  it('refuses contradictory active reservations rather than increasing them', async () => {
    const { tx, query } = transaction({ actualReserved: 1 });
    await expect(repairCustomerOrderV2StockOnlyPlanning({ tx, commande_id: 112, audit, ar_sent_at: null, of_ids: [] })).rejects.toMatchObject({ code: 'RECOVERED_RESERVATION_COVERAGE_MISMATCH' });
    expect(query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT INTO)/.test(sql))).toBe(false);
  });

  it.each([{ ar_sent_at: '2026-10-10T08:00:00Z', of_ids: [] }, { ar_sent_at: null, of_ids: [94] }])('never repairs an order with an AR sent or an existing OF', async flags => {
    const { tx, query } = transaction();
    await expect(repairCustomerOrderV2StockOnlyPlanning({ tx, commande_id: 112, audit, ...flags })).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
