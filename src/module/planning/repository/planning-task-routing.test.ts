import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/database',()=>({default:{}}));
vi.mock('./planning-forecast.repository',()=>({readForecastState:async()=>null}));
vi.mock('./duration-learning.repository',()=>({hydrateDurationEstimates:async()=>{},readLearningState:async()=>null}));
vi.mock('./planning-external.repository',()=>({hydrateExternalPlanning:async()=>{}}));
vi.mock('./planning-replenishment-targets.repository',()=>({readReplenishmentPlanningTargets:async()=>new Map(),earliestReplenishmentTarget:()=>null}));
import { readCentralSnapshot, taskFromRow } from './planning-central.repository';

describe('Snapshot carries the routing identity used by resource qualification',()=>{
  it.each(['FRAISAGE','TOURNAGE','REPRISE','CONTROLE','SOUS_TRAITANCE',null])('uses frozen %s rather than designation text',async type=>{
    const row={id:'op:x',operation_id:'x',source:'OPERATION',of_id:42,reference:'PLAT',phase:20,
      label:'Tournage described in free text',view:type==='SOUS_TRAITANCE'?'external':'machines',created_at:'2026-10-11T08:00:00Z',
      version:'1',quantity:4,unit_minutes:0,status:'TODO',readiness:'VALIDATED',total:1};
    const tx={query:vi.fn(async(sql:string)=>{
      if(sql.includes('SELECT activation,revision'))return {rows:[{activation:'READ',revision:'10'}]};
      if(sql.includes('WITH operation_rows'))return {rows:[row]};
      if(sql.includes('WITH qualified_resources'))return {rows:[{id:'x',family:'FRAISAGE',operation_type:type,eligible:['machine:fixture']}]};
      return {rows:[]};
    })};
    const snapshot=await readCentralSnapshot({from:'2026-10-12T00:00:00Z',to:'2026-10-13T00:00:00Z',limit:100,include_coverage:false},tx as never,false);
    expect(snapshot.tasks[0]).toMatchObject({operationType:type,phase:20,label:row.label});
    expect(row).not.toHaveProperty('operationType');
  });
});

describe('Canonical client identity in planning',()=>{
  const row={id:'op:identity',source:'OPERATION',phase:20,reference:'AXE',label:'Tournage',created_at:'2026-10-11T08:00:00Z',
    quantity:4,unit_minutes:0,client_id:'CLI-TEST-01',client_name:'Client fixture',client_color:'#147D92'};
  it('carries the client record without parsing the operation designation',()=>{
    expect(taskFromRow(row)).toMatchObject({clientId:'CLI-TEST-01',clientName:'Client fixture',clientColor:'#147D92',phase:20});
  });
  it('supports a missing client and older snapshot metadata',()=>{
    expect(taskFromRow({...row,client_id:null,client_name:undefined,client_color:null})).toMatchObject({clientId:null,clientName:null,clientColor:null});
  });
  it('refreshes the task version when client identity or color changes',()=>{
    expect(taskFromRow({...row,client_color:'#AF2200'}).version).not.toBe(taskFromRow(row).version);
    expect(taskFromRow({...row,client_name:'Renamed fixture'}).version).not.toBe(taskFromRow(row).version);
  });
});
