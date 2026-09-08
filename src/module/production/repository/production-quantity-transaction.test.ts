import {describe,expect,it,vi} from 'vitest';
const connect=vi.hoisted(()=>vi.fn());
vi.mock('../../../config/database',()=>({default:{connect}}));
vi.mock('./operation-readiness.repository',()=>({lockMaterialExecutionTx:vi.fn()}));
import {repoDeclareQuantity} from './production-execution.repository';
describe('déclaration dans la transaction du débit',()=>{
  it('laisse le propriétaire annuler et libérer sa transaction après un échec',async()=>{
    const tx={query:vi.fn(),release:vi.fn()},beforeEffect=vi.fn().mockRejectedValue(new Error('arrêt contrôlé'));
    await expect(repoDeclareQuantity({transactionClient:tx as never,body:{of_id:19,qty_good:1,qty_scrap:0,qty_rework:0,qty_pending_control:0},audit:{user_id:1} as never,idempotencyKey:'intent',transactionHooks:{beforeEffect,beforeCommit:vi.fn()}})).rejects.toThrow('arrêt contrôlé');
    expect(beforeEffect).toHaveBeenCalledWith(tx);expect(connect).not.toHaveBeenCalled();
    expect(tx.query).not.toHaveBeenCalled();expect(tx.release).not.toHaveBeenCalled();
  });
  it('conserve BEGIN et ROLLBACK pour une déclaration indépendante',async()=>{
    const tx={query:vi.fn(),release:vi.fn()};connect.mockResolvedValue(tx);
    await expect(repoDeclareQuantity({body:{of_id:19,qty_good:1,qty_scrap:0,qty_rework:0,qty_pending_control:0},audit:{user_id:1} as never,idempotencyKey:'intent',transactionHooks:{beforeEffect:vi.fn().mockRejectedValue(new Error('arrêt contrôlé')),beforeCommit:vi.fn()}})).rejects.toThrow('arrêt contrôlé');
    expect(tx.query.mock.calls).toEqual([['BEGIN'],['ROLLBACK']]);expect(tx.release).toHaveBeenCalledOnce();
  });
});
