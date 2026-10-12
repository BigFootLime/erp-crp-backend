import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({authorize:vi.fn(),resolve:vi.fn(),previous:vi.fn(),material:vi.fn()}));
vi.mock('../repository/station-cutting.repository',()=>({assertCuttingRead:mocks.authorize,authorizeCuttingTx:vi.fn(),cuttingPointageTx:vi.fn()}));
vi.mock('../repository/of-material.repository',()=>({getOfMaterial:mocks.material}));
vi.mock('../../identification/identification.service',()=>({resolveIdentification:mocks.resolve}));
vi.mock('../../identification/identification.repository',()=>({repoFindScanEvent:mocks.previous}));
import { scanStationCutting } from './station-cutting.service';
import type { StationContext } from '../middlewares/station-authorization.middleware';
const station={user:{id:31,role:'Opérateur atelier'},device_code:'CUT-TEST'} as StationContext;
beforeEach(()=>{vi.clearAllMocks();mocks.previous.mockResolvedValue(null);mocks.resolve.mockResolvedValue({ok:true,entity:{type:'STOCK_LOT',id:'lot',code:'LOT-1'}});
  mocks.material.mockResolvedValue({enabled:true,needs:[{operationId:'cut',reservations:[{id:'res',lot_id:'lot',status:'ACTIVE',unexpired:true,qty_reserved:100,qty_consumed:0}]}]});});
it('preserves the original timestamp when the same actor retries a scan event',async()=>{
  mocks.previous.mockResolvedValue({actor_user_id:31,client_scanned_at:'2026-10-12T08:00:00.000Z'});
  await scanStationCutting(station,19,'cut','CERP:1:11111111-1111-4111-8111-111111111111','event');
  expect(mocks.resolve.mock.calls[0][0]).toMatchObject({client_scanned_at:'2026-10-12T08:00:00.000Z',expected_entity_types:['STOCK_LOT','STOCK_MATERIAL_BAR']});
  expect(mocks.authorize).toHaveBeenCalledWith(station,19,'cut');
});
it('does not reuse another actor’s timestamp or bypass the identification resolver',async()=>{
  mocks.previous.mockResolvedValue({actor_user_id:99,client_scanned_at:'2000-01-01T08:00:00.000Z'});
  mocks.resolve.mockRejectedValue(new Error('SCAN_EVENT_CONFLICT'));
  await expect(scanStationCutting(station,19,'cut','CERP:1:11111111-1111-4111-8111-111111111111','event')).rejects.toThrow('SCAN_EVENT_CONFLICT');
  expect(mocks.resolve.mock.calls[0][0].client_scanned_at).not.toBe('2000-01-01T08:00:00.000Z');
});
