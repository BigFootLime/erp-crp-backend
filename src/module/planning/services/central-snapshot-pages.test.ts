import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),snapshot:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{query:m.query}}));
vi.mock('../repository/planning-central.repository',()=>({readCentralSnapshot:m.snapshot}));
const query={from:'2026-09-01T00:00:00Z',to:'2026-10-01T00:00:00Z',include_coverage:false,limit:100};
beforeEach(()=>{vi.resetModules();vi.resetAllMocks();vi.restoreAllMocks();
  m.query.mockResolvedValue({rows:[{revision:'1',calculated:null,activation:'COMMIT'}]});
  m.snapshot.mockResolvedValue({revision:'1',stale:false,activation:'COMMIT',tasks:Array.from({length:250},(_,i)=>({id:`op:${i}`})),dependencies:[],nextCursor:null,total:250});
});
describe('immutable bounded planning read pages',()=>{
  it('coalesces simultaneous readers while preserving every row and a stable total',async()=>{
    const {readCentralPage}=await import('./central-snapshot-pages');
    const first=await Promise.all([readCentralPage(query),readCentralPage(query),readCentralPage(query)]);
    expect(m.snapshot).toHaveBeenCalledOnce();expect(first[0].tasks).toHaveLength(100);
    const second=await readCentralPage({...query,cursor:first[0].nextCursor!,snapshot_revision:'1'});
    const third=await readCentralPage({...query,cursor:second.nextCursor!,snapshot_revision:'1'});
    expect([first[0].total,second.total,third.total]).toEqual([250,250,250]);expect(third.nextCursor).toBeNull();
    expect(new Set([...first[0].tasks,...second.tasks,...third.tasks].map(t=>t.id)).size).toBe(250);
  });
  it('finishes the old immutable page after a commit and labels it stale',async()=>{
    const {readCentralPage}=await import('./central-snapshot-pages');const first=await readCentralPage(query);
    m.query.mockResolvedValue({rows:[{revision:'2',calculated:null,activation:'READ'}]});
    const second=await readCentralPage({...query,cursor:first.nextCursor!,snapshot_revision:'1'});
    expect(second).toMatchObject({revision:'1',stale:true,activation:'READ',total:250});expect(m.snapshot).toHaveBeenCalledOnce();
  });
  it('rejects cursor reuse across filters or revisions',async()=>{
    const {readCentralPage}=await import('./central-snapshot-pages');const first=await readCentralPage(query);
    await expect(readCentralPage({...query,search:'other',cursor:first.nextCursor!})).rejects.toMatchObject({code:'PLANNING_SNAPSHOT_EXPIRED'});
    await expect(readCentralPage({...query,snapshot_revision:'2',cursor:first.nextCursor!})).rejects.toMatchObject({code:'PLANNING_SNAPSHOT_EXPIRED'});
  });
  it('expires old pages and refuses silently truncated windows',async()=>{
    const {readCentralPage}=await import('./central-snapshot-pages');const first=await readCentralPage(query);
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+31000);
    await expect(readCentralPage({...query,cursor:first.nextCursor!})).rejects.toMatchObject({code:'PLANNING_SNAPSHOT_EXPIRED'});
    m.snapshot.mockResolvedValue({tasks:[],nextCursor:'more'});
    await expect(readCentralPage({...query,search:'dense'})).rejects.toMatchObject({code:'PLANNING_WINDOW_TOO_DENSE'});
  });
  it('does not cache material coverage or use it in the analytical read cache',async()=>{
    const {readCentralPage}=await import('./central-snapshot-pages');
    await readCentralPage({...query,include_coverage:true});await readCentralPage({...query,include_coverage:true});
    expect(m.snapshot).toHaveBeenCalledTimes(2);expect(m.query).not.toHaveBeenCalled();
  });
  it('waits for an available read slot during a short burst',async()=>{
    const {readCentralPage}=await import('./central-snapshot-pages');
    const resolve:Array<()=>void>=[];
    m.snapshot.mockImplementation(()=>new Promise(r=>resolve.push(()=>r({revision:'1',stale:false,tasks:[],dependencies:[],nextCursor:null,total:0}))));
    const jobs=Array.from({length:5},(_,i)=>readCentralPage({...query,search:String(i)}));
    await vi.waitFor(()=>expect(m.snapshot).toHaveBeenCalledTimes(4));
    resolve[0]();await vi.waitFor(()=>expect(m.snapshot).toHaveBeenCalledTimes(5));
    for(const done of resolve)done();
    expect(await Promise.all(jobs)).toHaveLength(5);
  });
});
