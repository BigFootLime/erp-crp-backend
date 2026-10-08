import { describe,expect,it } from 'vitest';
import type { PoolClient } from 'pg';
import { resolveCumpLinkedReturnTx } from './cump-return-ledger.repository';
import * as sql from './cump-return-ledger.sql';
import type { CumpJournalSource } from '../domain/cump-posting-source';
import type { CumpScope } from '../domain/cump-valuation';

const id=(n: number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const scope: CumpScope={ articleId:id(1),owner:'COMPANY',unit:'u',currency:'EUR' };
const row: CumpJournalSource={ sequence:'3',movement_id:id(3),article_id:id(1),source_sha256:'a'.repeat(64),
  source_valid:true,source_snapshot:{ movement_type:'ADJUSTMENT',quantity:'-3' },
  acquisition_snapshot:null,acquisition_sha256:null,acquisition_valid:null };
function fixture(missingAncestorCursor=false) {
  const events: unknown[][]=[],updates: unknown[][]=[];
  const query=async (statement: string,args: unknown[]=[])=>{
    if(statement===sql.CUMP_RETURN_ORIGINAL_SQL) {
      const remnant=args[0]===id(2);
      return { rows:[{ id:remnant ? id(20) : id(10),article_id:id(1),source_sequence:remnant ? '2' : '1',
        kind:remnant ? 'RETURN' : 'ISSUE',quantity_delta:remnant ? '3.000000000000' : '-10.000000000000',
        movement_value:remnant ? '3.000000000000' : '10.000000000000',reliability:'VERIFIED',source_valid:true,source_snapshot:{} }] };
    }
    if(statement===sql.CUMP_RETURN_NET_CURSOR_SQL) return { rows:args[0]===id(2) || missingAncestorCursor ? [] : [{
      original_entry_id:id(10),quantity:'3.000000000000',value:'3.000000000000',latest_event_id:id(21),source_valid:true }] };
    if(statement===sql.CUMP_RETURN_ORIGINAL_EVENTS_SQL) return { rows:[{
      id:id(21),original_movement_id:id(4),original_entry_id:id(10),owner_key:'COMPANY',stock_unit:'u',currency:'EUR',
      quantity_delta:'3.000000000000',value_delta:'3.000000000000',source_valid:true }] };
    if(statement===sql.CUMP_RETURN_INSERT_EVENT_SQL) { events.push(args); return { rows:[{ id:args[0] }] }; }
    if(statement===sql.CUMP_RETURN_STORE_NET_CURSOR_SQL) { updates.push(args); return { rows:[{ original_entry_id:args[4] }] }; }
    throw Error('Unexpected ledger query');
  };
  return { tx:{ query } as unknown as PoolClient,events,updates };
}
describe('net return ledger — prepared for final acceptance',()=>{
  it('cancels a remnant and releases the original issue allocation, normalizing PostgreSQL numeric text',async()=>{
    const { tx,events,updates }=fixture();
    const result=await resolveCumpLinkedReturnTx(tx,row,id(2),scope,'3',id(30));
    expect(result).toMatchObject({ kind:'RECEIPT_REVERSAL',cost:{ amount:'3',reliability:'VERIFIED' },issues:[] });
    expect(events).toHaveLength(2);
    expect(events.map(e=>[e[1],e[9],e[10],e[11]])).toEqual([[id(2),null,'3','3'],[id(4),id(21),'-3','-3']]);
    expect(updates.map(e=>[e[0],e[5],e[6]])).toEqual([[id(2),'3','3'],[id(4),'0','0']]);
  });
  it('writes no partial events or cursor when ancestor proof is missing',async()=>{
    const { tx,events,updates }=fixture(true);
    const result=await resolveCumpLinkedReturnTx(tx,row,id(2),scope,'3',id(30));
    expect(result).toMatchObject({ cost:{ amount:null,reliability:'UNKNOWN' },issues:['CUMP_RETURN_CURSOR_PROOF_MISSING'] });
    expect(events).toEqual([]); expect(updates).toEqual([]);
  });
});
