import {describe,it,expect,vi} from 'vitest';
import {connectedTestInfo} from '../config/managed-database';
const id=`cerp_test_${'a'.repeat(32)}`;
function query(database:string,marker?:{database_id:string;ordinal:number}){return {query:vi.fn(async(sql:string)=>({rows:sql.includes('current_database()') ? [{database}]:marker ? [marker]:[]}))};}
describe('actual managed PostgreSQL identity',()=>{
 it('recognizes the fixed common Test without trusting a client header',async()=>{expect(await connectedTestInfo(query('cerp_test') as never,{})).toMatchObject({database:'cerp_test',ordinal:1});});
 it.each(['cerp_prod','unknown','cerp_test_broken'])('never classifies %s as a managed Test',async database=>{const q=query(database);expect(await connectedTestInfo(q as never,{CERP_MANAGED_TEST_ID:id})).toBeNull();expect(q.query).toHaveBeenCalledOnce();});
 it('requires a matching connected database, process identity and immutable marker',async()=>{expect(await connectedTestInfo(query(id,{database_id:id,ordinal:2}) as never,{CERP_MANAGED_TEST_ID:id})).toEqual({database:id,ordinal:2,label:'Base Test 2.0'});expect(await connectedTestInfo(query(id,{database_id:id,ordinal:2}) as never,{})).toBeNull();expect(await connectedTestInfo(query(id,{database_id:'cerp_test',ordinal:2}) as never,{CERP_MANAGED_TEST_ID:id})).toBeNull();});
 it('rejects a managed process accidentally connected to the common Test',async()=>{expect(await connectedTestInfo(query('cerp_test') as never,{CERP_MANAGED_TEST_ID:id})).toBeNull();});
});
