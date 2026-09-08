import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({create:vi.fn(),post:vi.fn(),genealogy:vi.fn(),code:vi.fn()}));
vi.mock('./stock.repository',()=>({repoCreateMovement:m.create,repoPostMovement:m.post,repoCreateLotGenealogy:m.genealogy}));
vi.mock('../../../shared/codes/code-generator.service',()=>({generateTransactionalBusinessCode:m.code}));
import {createMaterialRemnantTx} from './material-remnant.repository';
const tx={query:vi.fn()},audit={user_id:1} as never;
const input={ofId:19,reservationId:'res',quantity:2,dimensions:{longueur_mm:2000,diametre_mm:25},note:'Barre coupée avec chute réutilisable',key:'key'};
beforeEach(()=>{vi.resetAllMocks();m.code.mockResolvedValue('LOT-CHUTE');m.create.mockResolvedValue({movement:{id:'movement'}});m.post.mockResolvedValue({movement:{status:'POSTED'}});
  tx.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT l.id')?[{lot_id:'parent',article_id:'article',supplier_lot_code:'heat',client_proprietaire_id:'client',
    material_properties:{grade:'6082',condition:'T651',dimensions:{longueur_mm:6000,diametre_mm:25},certificate_evidence:[{documentId:'certificate',label:'3.1'}]},magasin_id:'warehouse',emplacement_id:1,unite:'m'}]:[{id:'child'}]}));
});
it('keeps ownership, heat/certificate references and posts a distinct lot in quarantine in the parent transaction',async()=>{
  const result=await createMaterialRemnantTx(tx as never,input,audit);
  const insert=tx.query.mock.calls.find(c=>c[0].includes('INSERT INTO public.lots'))!;
  expect(insert[0]).toContain("'EN_ATTENTE'");expect(insert[1][5]).toBe('client');expect(JSON.parse(insert[1][6])).toMatchObject({grade:'6082',condition:'T651',remnant_source_lot_id:'parent',dimensions:input.dimensions,certificate_evidence:[{documentId:'certificate'}]});
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({movement_type:'IN',lines:[expect.objectContaining({lot_id:'child',qty:2})]}),audit,{client:tx,trusted_source_flow:true});
  expect(m.genealogy).toHaveBeenCalledWith(expect.objectContaining({parents:[{lot_id:'parent',qty:2}],children:[{lot_id:'child',qty:2}]}),audit,'key:genealogy',tx);
  expect(result).toMatchObject({lotId:'child',quantity:2});expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
});
it('refuses a remnant larger than its source before creating a stock entry',async()=>{
  await expect(createMaterialRemnantTx(tx as never,{...input,dimensions:{longueur_mm:7000}},audit)).rejects.toMatchObject({code:'MATERIAL_REMNANT_DIMENSIONS_INVALID'});expect(m.create).not.toHaveBeenCalled();
});
it('propagates genealogy failure so its transaction owner can roll back the inbound movement too',async()=>{m.genealogy.mockRejectedValue(new Error('genealogy failed'));
  await expect(createMaterialRemnantTx(tx as never,input,audit)).rejects.toThrow('genealogy failed');expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
});
