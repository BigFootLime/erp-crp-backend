import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs=vi.hoisted(()=>({error:vi.fn(),info:vi.fn()}));
vi.mock('../shared/observability/logger',()=>({logger:logs,safeErrorCode:()=> 'CONNECTION_LOST',errorFingerprint:()=> 'safe-fingerprint'}));
vi.mock('pg',()=>({Pool:class extends EventEmitter {connect=vi.fn();}}));

import pool from './database';
import { RealtimeCommitUncertainError, withRealtimeOutboxTransaction } from '../shared/realtime/realtime-outbox-transaction';

beforeEach(()=>vi.clearAllMocks());

function connectedClient(){
 const client=Object.assign(new EventEmitter(),{query:vi.fn().mockResolvedValue({rows:[]}),release:vi.fn()});
 pool.emit('connect',client);return client;
}

describe('checked-out PostgreSQL client errors',()=>{
 it('keeps a safe error listener while a client is checked out without re-emitting it',()=>{
  const client=connectedClient(),failure=Object.assign(new Error('private-query-and-password'),{code:'57P01'});
  expect(()=>client.emit('error',failure)).not.toThrow();
  expect(client.listenerCount('error')).toBe(1);
  expect(logs.error).toHaveBeenCalledWith('database_client_error',{failure_code:'CONNECTION_LOST',error_fingerprint:'safe-fingerprint'});
  expect(JSON.stringify(logs.error.mock.calls)).not.toContain('private-query-and-password');
  expect(client.release).not.toHaveBeenCalled();
 });
 it('preserves the query rejection and the transaction rollback/release',async()=>{
  const client=connectedClient(),failure=new Error('query failed');
  client.query.mockImplementation(async(sql:string)=>{if(sql==='work'){client.emit('error',failure);throw failure;}return{rows:[]};});
  await expect(withRealtimeOutboxTransaction(client as unknown as PoolClient,async tx=>tx.query('work'))).rejects.toBe(failure);
  expect(client.query.mock.calls.map(c=>c[0])).toEqual(['BEGIN','work','ROLLBACK']);
  expect(client.release).toHaveBeenCalledTimes(1);expect(client.release).toHaveBeenCalledWith();
 });
 it('destroys the failed client when rollback also loses its connection',async()=>{
  const client=connectedClient();
  client.query.mockImplementation(async(sql:string)=>{if(sql!=='BEGIN'){const failure=new Error('connection lost');client.emit('error',failure);throw failure;}return{rows:[]};});
  await expect(withRealtimeOutboxTransaction(client as unknown as PoolClient,async tx=>tx.query('work'))).rejects.toBeInstanceOf(RealtimeCommitUncertainError);
  expect(client.release).toHaveBeenCalledTimes(1);expect(client.release).toHaveBeenCalledWith(true);
 });
});
