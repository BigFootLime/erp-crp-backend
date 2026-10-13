import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { scopeClientUrgency, assertUrgencyResult } from './client-urgency-scope';
import type { CentralSnapshot, ScheduleResult } from '../types/planning-central.types';
import type { CentralSimulationInput } from '../validators/planning-central.validators';

const snapshot = () => ({ tasks: [
  { id: 'op:recovery', ofId: 101, clientId: 'client1', locked: false },
  { id: 'op:own', ofId: 102, clientId: 'client1', locked: false },
  { id: 'op:other', ofId: 200, clientId: 'client2', locked: false },
  { id: 'op:shared', ofId: 300, clientId: 'client1', locked: false },
] } as CentralSnapshot);
const input = () => ({ changes: [{ taskId: 'op:recovery' }] } as CentralSimulationInput);
const db = (clients: string[] = ['client1'], shared = [300], evidence = true) => ({ query: vi.fn(async (sql: string) => {
  if (sql.includes('delivery_urgency_recoveries')) return { rows: clients.map(client_id => ({ client_id })) };
  if (sql.includes('delivery_promise_events')) return { rows: [], rowCount: evidence ? 1 : 0 };
  if (sql.includes('production_consolidations')) return { rows: shared.map(of_id => ({ of_id })) };
  throw new Error('Unexpected SQL');
}) } as unknown as PoolClient);

describe('recovery urgency cannot reschedule other clients', () => {
  it('leaves ordinary planning unchanged', async () => {
    const state = snapshot(); expect(await scopeClientUrgency(state,input(),db([]))).toBe(state);
  });
  it('automatically protects other clients and a shared producer without a client-supplied urgency flag', async () => {
    const state = await scopeClientUrgency(snapshot(),input(),db());
    expect(state.urgencyClientId).toBe('client1');
    expect(state.tasks.filter(task => task.locked).map(task => task.id)).toEqual(['op:other','op:shared']);
    expect(snapshot().tasks.every(task => !task.locked)).toBe(true);
  });
  it('refuses a mixed-client request and a shared producer in the same move', async () => {
    for (const taskId of ['op:other','op:shared']) {
      const request = input(); request.changes.push({ ...request.changes[0], taskId });
      await expect(scopeClientUrgency(snapshot(),request,db())).rejects.toMatchObject({ code: 'PLANNING_OTHER_CLIENT_PROTECTED' });
    }
  });
  it('does not mix recovery requests for different clients', async () => {
    await expect(scopeClientUrgency(snapshot(),input(),db(['client1','client2']))).rejects.toMatchObject({ code: 'PLANNING_OTHER_CLIENT_PROTECTED' });
  });
  it('preserves the evidence requirement for an ordinary promise-change urgency', async () => {
    const request = { ...input(), urgency: { client_id: 'client1', promise_event_id: 'promise1' } };
    await expect(scopeClientUrgency(snapshot(),request,db([],[],false))).rejects.toMatchObject({ code: 'PLANNING_URGENCY_EVIDENCE_REQUIRED' });
  });
  it('also checks the computed result before commit', async () => {
    const state = await scopeClientUrgency(snapshot(),input(),db());
    const result = { changes: [{ taskId: 'op:other' }], affected: ['op:other'], forecasts: {} } as ScheduleResult;
    expect(() => assertUrgencyResult(result,state,input())).toThrow('capacité protégée');
  });
  it('continues protecting other clients after the donor pieces have been withdrawn', async () => {
    const tx = db();
    const state = await scopeClientUrgency(snapshot(),input(),tx);
    expect(tx.query).toHaveBeenNthCalledWith(1,expect.any(String),[[101],['WAITING_PLANNER','APPROVED','WITHDRAWN']]);
    expect(state.tasks.find(task=>task.id==='op:other')?.locked).toBe(true);
  });
  it('protects the child of a mixed-client producer, even when its displayed client matches', async () => {
    const state = snapshot();
    state.tasks.push({...state.tasks[0],id:'op:child',ofId:301});
    const result = await scopeClientUrgency(state,input(),db(['client1'],[300,301]));
    expect(result.tasks.find(task=>task.id==='op:child')?.locked).toBe(true);
    const request = input(); request.changes.push({...request.changes[0],taskId:'op:child'});
    await expect(scopeClientUrgency(state,request,db(['client1'],[300,301])))
      .rejects.toMatchObject({code:'PLANNING_OTHER_CLIENT_PROTECTED'});
  });
});
