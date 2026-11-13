import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn(), client: vi.fn(), contract: vi.fn(),
  plan: vi.fn(), history: vi.fn(), launches: vi.fn() }));
vi.mock('../../../config/database', () => ({ default: { connect: mocks.connect } }));
vi.mock('../repository/client-crm.repository', () => ({ readCrmClient: mocks.client }));
vi.mock('../repository/client-contract.repository', () => ({ readClientContract: mocks.contract, lockContractArticles: vi.fn() }));
vi.mock('../repository/client-contract-replenishment.repository', () => ({ readReplenishmentPlan: mocks.plan, readReplenishmentHistory: mocks.history }));
vi.mock('../repository/client-contract-replenishment-launch.repository', () => ({ readReplenishmentPlanLaunches: mocks.launches }));
import { getClientReplenishmentPreparation } from './client-contract-replenishment.service';
const tx = { query: mocks.query, release: mocks.release }, plan = { id: 'plan-a', proposals: [{ id: 'proposal-a' }] };
beforeEach(() => {
  vi.resetAllMocks(); mocks.connect.mockResolvedValue(tx); mocks.client.mockResolvedValue({ id: '195' });
  mocks.contract.mockResolvedValue({ id: 'contract-a' }); mocks.plan.mockResolvedValue(plan);
  mocks.query.mockResolvedValue({ rows: [{ preparation_installed: true, generation_installed: true }] });
  mocks.launches.mockResolvedValue([{ proposal_id: 'proposal-a', root_of_id: 101, number: 'OF-101', status: 'BROUILLON' }]);
  mocks.history.mockResolvedValue({ items: [], total: 0 });
});
describe('reopened replenishment preparation', () => {
  it('returns persistent OF links alongside the unchanged immutable proposal on one read-only transaction', async () => {
    expect(await getClientReplenishmentPreparation('195', 'contract-a')).toEqual({ plan,
      launched_ofs: [{ proposal_id: 'proposal-a', root_of_id: 101, number: 'OF-101', status: 'BROUILLON' }], generation_installed: true });
    expect(mocks.launches).toHaveBeenCalledExactlyOnceWith(tx, 'contract-a', 'plan-a');
    expect(mocks.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(mocks.query).toHaveBeenCalledWith('COMMIT'); expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it('keeps preparations readable when the additive generation schema has not been installed', async () => {
    mocks.query.mockResolvedValue({ rows: [{ preparation_installed: true, generation_installed: false }] });
    expect(await getClientReplenishmentPreparation('195', 'contract-a')).toEqual({ plan, launched_ofs: [], generation_installed: false });
    expect(mocks.launches).not.toHaveBeenCalled();
  });
  it('returns an actionable installation conflict before querying absent preparation tables', async () => {
    mocks.query.mockResolvedValue({ rows: [{ preparation_installed: false, generation_installed: false }] });
    await expect(getClientReplenishmentPreparation('195', 'contract-a')).rejects.toMatchObject({ status: 409, code: 'CONTRACT_REPLENISHMENT_NOT_INSTALLED' });
    expect(mocks.plan).not.toHaveBeenCalled(); expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it('reads a historical plan and its launches within that plan and contract only', async () => {
    const result = await getClientReplenishmentPreparation('195', 'contract-a', 'plan-a', 2);
    expect(result.history).toEqual({ items: [], total: 0 });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(tx, 'contract-a', 'plan-a', 2);
    expect(mocks.launches).toHaveBeenCalledExactlyOnceWith(tx, 'contract-a', 'plan-a');
  });
  it('does not expose another contract preparation to a client with a different owner', async () => {
    mocks.contract.mockResolvedValue(null);
    await expect(getClientReplenishmentPreparation('195', 'other-contract')).rejects.toMatchObject({ status: 404 });
    expect(mocks.plan).not.toHaveBeenCalled(); expect(mocks.launches).not.toHaveBeenCalled();
  });
  it('does not invent a preparation or OF list when no plan has been saved', async () => {
    mocks.plan.mockResolvedValue(null);
    expect(await getClientReplenishmentPreparation('195', 'contract-a')).toEqual({ plan: null, launched_ofs: [], generation_installed: true });
    expect(mocks.launches).not.toHaveBeenCalled();
  });
});
