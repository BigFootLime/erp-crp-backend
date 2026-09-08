import {describe,it,expect} from 'vitest';
import {materialForecastAvailability as available} from './material-forecast';
const base={now:'2026-09-08T08:00:00.000Z',required:100,consumed:20,reserved:40,blocked:0,preparation:[],promises:[{quantity:40,date:'2026-09-14'}]};
describe('full quantity forecast',()=>{
  it('waits for remaining promised material without counting reservations twice',()=>{expect(available(base).date).toBe('2026-09-14T00:00:00.000Z');expect(available({...base,required:60}).date).toBe(base.now);});
  it('updates a supplier delay and requires the last necessary partial promise',()=>{expect(available({...base,promises:[{quantity:25,date:'2026-09-14'},{quantity:15,date:'2026-09-18'}]}).date).toBe('2026-09-18T00:00:00.000Z');});
  it('does not manufacture a receipt or date from overdue, insufficient or unconfirmed promises',()=>{
    for(const promises of [[{quantity:40,date:'2026-09-07'}],[{quantity:40,date:null}],[{quantity:25,date:'2026-09-18'}]])expect(available({...base,promises}).date).toBeNull();
  });
  it('requires quality release and reviewed preparation before a usable forecast',()=>{expect(available({...base,blocked:15}).reason).toContain('libération');expect(available({...base,preparation:['Revoir la nuance']}).date).toBeNull();});
});
