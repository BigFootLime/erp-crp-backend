import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({begin:vi.fn(),complete:vi.fn(),quality:vi.fn(),create:vi.fn(),post:vi.fn(),states:vi.fn(),assert:vi.fn()}));
vi.mock('./stock.repository',()=>({beginStockCommand:m.begin,completeStockCommand:m.complete,repoCreateMovement:m.create,repoPostMovement:m.post,lockStockStates:m.states,assertStockConsumptionAllowed:m.assert,stockTargetKey:()=> 'source'}));
vi.mock('../../qualite/repository/quality-operational-gate.repository',()=>({assertOperationalLotQualityEligibility:m.quality}));
import {consumeMaterialReservationTx} from './partial-reservation-consumption.repository';
const input={reservationId:'reservation',ofId:19,operationId:'cut',quantity:20,expectedVersion:4,idempotencyKey:'debit-20',reason:'Débit de 20 bruts'};
const audit={user_id:1} as never;
function client(){return {query:vi.fn(async(sql:string)=>{
  if(sql.startsWith('SELECT lot_id::text'))return {rows:[{lot_id:'lot'}]};
  if(sql.includes('FROM public.stock_reservations r'))return {rows:[{article_id:'article',lot_id:'lot',stock_batch_id:'batch',stock_level_id:'level',magasin_id:'magasin',emplacement_id:1,unit:'u',qty_reserved:60,qty_consumed:0,qty_prepared:0,row_version:4,status:'ACTIVE',unexpired:true}]};
  return {rows:[]};
})};}
beforeEach(()=>{
  vi.resetAllMocks();
  m.begin.mockResolvedValue({key:'command',existing:null});m.quality.mockResolvedValue({});
  m.states.mockResolvedValue(new Map([['source',{}]]));
  m.create.mockResolvedValue({movement:{id:'movement'}});m.post.mockResolvedValue({movement:{id:'movement',status:'POSTED'}});
});
describe('orchestration du débit de réservation dans la transaction propriétaire',()=>{
  it('retire uniquement 20 du stock réservé, publie la sortie et conserve 40',async()=>{
    const tx=client();
    await expect(consumeMaterialReservationTx(tx as never,input,audit)).resolves.toMatchObject({quantity:20,remaining:40,status:'ACTIVE',stockMovementId:'movement'});
    const changes=tx.query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE public.stock_'));
    expect(changes).toHaveLength(3);
    expect(m.assert).toHaveBeenCalledWith({}, {movement_type:'UNRESERVE',qty:20});
    expect(m.post).toHaveBeenCalledWith('movement',{},audit,'command:post',tx,{reservationId:'reservation'});
    expect(m.quality).toHaveBeenCalledWith(expect.objectContaining({qty:0,lotId:'lot'}));
    expect(tx.query.mock.calls.some(([sql])=>/COMMIT|ROLLBACK/.test(sql))).toBe(false);
  });
  it('rejoue la preuve sans une nouvelle sortie ni une nouvelle déduction',async()=>{
    const result={reservationId:'reservation',stockMovementId:'movement',quantity:20,remaining:40,status:'ACTIVE'};
    m.begin.mockResolvedValue({existing:{result_payload:result}});
    const tx=client();await expect(consumeMaterialReservationTx(tx as never,input,audit)).resolves.toEqual(result);
    expect(tx.query).not.toHaveBeenCalled();expect(m.create).not.toHaveBeenCalled();expect(m.post).not.toHaveBeenCalled();
  });
  it('refuse avant toute modification si la réserve a changé',async()=>{
    const tx=client();await expect(consumeMaterialReservationTx(tx as never,{...input,expectedVersion:3},audit)).rejects.toMatchObject({code:'CONCURRENT_MODIFICATION'});
    expect(tx.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);expect(m.create).not.toHaveBeenCalled();
  });
  it('remonte un échec de comptabilisation à la transaction propriétaire sans enregistrer de succès',async()=>{
    m.post.mockRejectedValue(new Error('stock unavailable'));
    await expect(consumeMaterialReservationTx(client() as never,input,audit)).rejects.toThrow('stock unavailable');
    expect(m.complete).not.toHaveBeenCalled();
  });
});
