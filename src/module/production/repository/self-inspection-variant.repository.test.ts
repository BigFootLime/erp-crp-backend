import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),load:vi.fn(),evaluate:vi.fn(),render:vi.fn(),audit:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:async()=>({query:mocks.query})}}));
vi.mock('../../../shared/realtime/realtime-outbox-transaction',()=>({withRealtimeOutboxTransaction:async(tx:unknown,run:(tx:unknown)=>unknown)=>run(tx)}));
vi.mock('./production-preparation.repository',async()=>{
  const actual=await vi.importActual<typeof import('./production-preparation.repository')>('./production-preparation.repository');
  return {...actual,loadPreparationOrder:mocks.load,evaluateOfPreparation:mocks.evaluate,preparationAudit:mocks.audit};
});
vi.mock('../services/self-inspection-xlsx',()=>({renderSelfInspectionXlsx:mocks.render}));
vi.mock('./of-document-commercial.repository',()=>({readOfDocumentCommercial:async()=>({scope:'CUSTOMER',affairs:[]})}));
import {repoGenerateInspectionTemplate} from './self-inspection.repository';
import {preparationDecisionsSchema} from '../validators/production-workbench.validators';
const of={id:7,numero:'OF-TEST',statut:'BROUILLON',updated_at:'now',version_id:'revision',quantite_lancee:50};
beforeEach(()=>{
  vi.clearAllMocks();mocks.load.mockResolvedValue(of);mocks.render.mockResolvedValue(Buffer.from('xlsx'));
  mocks.query.mockResolvedValue({rows:[{client_code:'TEST',reference:'REF',designation:'Pièce'}]});
});
describe('inspection sheet part variant',()=>{
  it.each([[' Gauche · finition noire ','Gauche · finition noire'],[undefined,null],[null,null]])('uses the explicit part variant, never the revision change category',async(part_variant,expected)=>{
    mocks.evaluate.mockResolvedValue({version:{indice:'A',version_interne:5,type_changement:'MODIFICATION'},decisions:{part_variant},sheet_hash:'hash'});
    await repoGenerateInspectionTemplate(7,'now',{user_id:7} as Parameters<typeof repoGenerateInspectionTemplate>[2]);
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({variation:expected}));
  });
  it('accepts or clears the dedicated field and rejects oversized values',()=>{
    expect(preparationDecisionsSchema.parse({part_variant:' Droite '})).toEqual({part_variant:'Droite'});
    expect(preparationDecisionsSchema.parse({part_variant:null})).toEqual({part_variant:null});
    expect(preparationDecisionsSchema.safeParse({part_variant:'x'.repeat(161)}).success).toBe(false);
  });
});
