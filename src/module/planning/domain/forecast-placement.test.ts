import {describe,expect,it} from 'vitest';
import {forecastPlacements} from './forecast-placement';
import {projectMasterPlan} from './planning-master-plan';
import type {CentralTask,CentralSnapshot,ScheduleResult,Resource} from '../types/planning-central.types';

const start='2026-10-08T08:00:00.000Z',end='2026-10-08T09:00:00.000Z';
const task:CentralTask={id:'op',resourceIds:['machine:a'],forecast:null,committed:null,commitment:'FORECAST',ofId:1,
  blockers:[],eligibleResourceIds:['machine:a','machine:b'],source:'OPERATION',operationId:'operation',programmingId:null,
  orderId:1,ofNumber:'OF-1',reference:'PIECE',revision:'A',label:'Fraisage',view:'machines',internal:false,internalPurpose:null,
  quantity:10,good:0,scrap:0,rework:0,released:0,actual:null,locked:false,readiness:'READY',earliestStart:start,due:end,
  priority:1,createdAt:start,version:'1',estimate:null};
const result:ScheduleResult={changes:[{taskId:'op',before:null,after:{start,end},resourceIds:['machine:b']}],
  forecasts:{op:{start,end}},conflicts:[],feasible:true,affected:['op']};

describe('forecast resource evidence',()=>{
  it('retains the calculated machine and clears date and resource together after a conflict',()=>{
    expect(forecastPlacements([task],result)[0]).toMatchObject({start,end,resources:['machine:b']});
    expect(task.resourceIds).toEqual(['machine:a']);
    expect(forecastPlacements([task],{...result,conflicts:[{taskId:'op',code:'NO_CAPACITY',message:'Aucun créneau'}]})[0])
      .toMatchObject({start:null,end:null,resources:null,issues:['Aucun créneau']});
  });
  it('retains a fixed commitment resource without inventing a changed placement',()=>{
    expect(forecastPlacements([{...task,committed:{start,end}}],{...result,changes:[]})[0].resources).toEqual(['machine:a']);
  });
  const machine:Resource={id:'machine:b',capacityId:'machine:b',kind:'MACHINE',label:'Takumi',calendarConfigured:true,
    capacityEnabled:true,availability:[{start,end}],timezone:'UTC',version:'1'};
  const snapshot=(patch:Partial<CentralTask>):CentralSnapshot=>({tasks:[{...task,forecast:{start,end},...patch}],
    resources:[machine,{...machine,id:'poste:b',kind:'POSTE'}],forecastState:{status:'READY',calculatedAt:start,
      sourceRevision:'1',issueCount:0,error:null},generatedAt:start,revision:'1',apiVersion:2,stale:false,activation:'LEARN',
    sources:[],demands:[],allocations:[],coverageAvailable:true,dependencies:[],total:1,nextCursor:null});
  const periods=[{start,end,label:'S41'}] as Parameters<typeof projectMasterPlan>[2];
  it('allocates forecast capacity once across machine aliases without creating committed load',()=>{
    const value=projectMasterPlan(snapshot({forecastResourceIds:['machine:b','poste:b']}),[],periods);
    expect(value.capacities).toHaveLength(1);
    expect(value.capacities[0].cells[0]).toMatchObject({capacityMinutes:60,forecastMinutes:60,committedMinutes:0,taskIds:['op']});
    expect(value.summary.unallocatedForecasts).toBe(0);
  });
  it('keeps forecast load unknown when placement or calculation freshness is missing',()=>{
    const value=projectMasterPlan(snapshot({forecastResourceIds:null}),[],periods);
    expect(value.capacities[0].cells[0].forecastMinutes).toBeNull();
    expect(value.summary.unallocatedForecasts).toBe(1);
    const pending=snapshot({forecastResourceIds:['machine:b']});pending.forecastState!.status='PENDING';
    expect(projectMasterPlan(pending,[],periods).capacities[0].cells[0].forecastMinutes).toBeNull();
  });
});
