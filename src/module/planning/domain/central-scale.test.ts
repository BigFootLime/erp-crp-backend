import {describe,expect,it} from 'vitest';
import {expandCalendar,type CalendarDefinition} from './central-calendar';
import {capacitySlot,schedule} from './central-scheduler';
import type {Interval,Resource} from '../types/planning-central.types';
const minute=60000,iso=(n:number)=>new Date(n).toISOString();
// Independent UTC-minute oracle, including both folds and absent local minutes at DST.
function minuteCalendar(c:CalendarDefinition,from:string,to:string):Interval[]{
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const result:Interval[]=[];let start:number|null=null;
  for(let t=Math.ceil(Date.parse(from)/minute)*minute;t<Date.parse(to);t+=minute){
    const parts=formatter.formatToParts(t),get=(key:string)=>parts.find(p=>p.type===key)!.value;
    const date=`${get('year')}-${get('month')}-${get('day')}`,civil=Number(get('hour'))*60+Number(get('minute'));
    const weekday=new Date(date+'T12:00:00Z').getUTCDay();
    const open=!c.closedDates.includes(date)&&c.shifts.some(s=>s.weekday===weekday&&civil>=s.startMinute&&civil<s.endMinute)&&
      !c.closures.some(w=>t<Date.parse(w.end)&&t+minute>Date.parse(w.start));
    if(open&&start===null)start=t;
    if(!open&&start!==null){result.push({start:iso(start),end:iso(t)});start=null;}
  }
  if(start!==null)result.push({start:iso(start),end:to});return result;
}
describe('large calendar and capacity semantics',()=>{
  it.each([
    ['Europe/Paris','2026-03-28','2026-03-30'],['Europe/Paris','2026-10-24','2026-10-26'],
    ['Australia/Lord_Howe','2026-04-04','2026-04-06'],['Australia/Lord_Howe','2026-10-03','2026-10-05'],
    ['Asia/Kathmandu','2026-09-07','2026-09-09'],['America/New_York','2026-11-01','2026-11-03'],
  ])('agrees with minute sampling in %s (%s)',(timezone,a,b)=>{
    const from=a+'T00:00:17.000Z',to=b+'T05:37:23.000Z';
    const calendar={timezone,closedDates:[b],closures:[{start:a+'T08:17:23.000Z',end:a+'T08:43:19.000Z'}],
      shifts:Array.from({length:7},(_,weekday)=>[{weekday,startMinute:0,endMinute:175},{weekday,startMinute:165,endMinute:1440}]).flat()};
    expect(expandCalendar(calendar,from,to)).toEqual(minuteCalendar(calendar,from,to));
    const again=expandCalendar(calendar,from,to);again[0].end=from;
    expect(expandCalendar(calendar,from,to)).toEqual(minuteCalendar(calendar,from,to));
  });
  it('agrees with a minute grid over 150 deterministic reservation patterns',()=>{
    let seed=970;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    const base=Date.parse('2026-09-07T00:00:00Z'),at=(n:number)=>base+n*minute;
    for(let test=0;test<150;test++){
      const resources:Resource[]=Array.from({length:2},(_,i)=>({id:`m${i}`,kind:'MACHINE',label:'test',timezone:'UTC',version:'1',
        availability:Array.from({length:4},(_,j)=>({start:iso(at(j*240+Math.floor(rand()*4)*15)),end:iso(at(j*240+120+Math.floor(rand()*8)*15))}))}));
      const occupied=new Map(resources.map(r=>[r.id,Array.from({length:3},()=>{const start=Math.floor(rand()*60)*15;return {start:iso(at(start)),end:iso(at(start+15+Math.floor(rand()*6)*15))};})]));
      const earliest=Math.floor(rand()*20)*15,required=15+Math.floor(rand()*12)*15;
      const busyAt=Array.from({length:960},(_,t)=>resources.some(r=>(occupied.get(r.id)??[]).some(w=>Date.parse(w.start)<at(t+1)&&Date.parse(w.end)>at(t))));
      const openAt=Array.from({length:960},(_,t)=>resources.every(r=>r.availability.some(w=>Date.parse(w.start)<=at(t)&&Date.parse(w.end)>=at(t+1))));
      let expected:Interval|null=null;
      for(let candidate=earliest;candidate<960&&!expected;candidate++){
        let work=0,start:number|null=null;
        for(let t=candidate;t<960;t++){
          if(busyAt[t])break;
          const open=openAt[t];
          if(open){start??=t;work++;if(work>=required){expected={start:iso(at(start)),end:iso(at(t+1))};break;}}
        }
      }
      expect(capacitySlot(resources,occupied,at(earliest),required),`seeded pattern ${test}`).toEqual(expected);
    }
  });
  it('schedules all 10,000 tasks without lost dependencies or overlapping reservations',()=>{
    const fixture=require('../../../../scripts/performance/planning-fixture.cjs').planningFixture();
    const result=schedule(fixture);expect(result.feasible).toBe(true);expect(result.changes).toHaveLength(10000);
    for(const d of fixture.dependencies)expect(Date.parse(result.forecasts[d.successorId].start)).toBeGreaterThanOrEqual(Date.parse(result.forecasts[d.predecessorId].end));
    const byResource=new Map<string,Interval[]>();
    for(const c of result.changes){const id=c.resourceIds[0];if(!byResource.has(id))byResource.set(id,[]);byResource.get(id)!.push(c.after);}
    for(const intervals of byResource.values()){
      intervals.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
      for(let i=1;i<intervals.length;i++)expect(Date.parse(intervals[i].start)).toBeGreaterThanOrEqual(Date.parse(intervals[i-1].end));
    }
  });
});
