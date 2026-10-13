import {describe,it,expect,vi,beforeEach} from 'vitest';
import type {PoolClient} from 'pg';
const mocks=vi.hoisted(()=>({find:vi.fn(),queue:vi.fn()}));
vi.mock('../../../shared/authoritative-documents/authoritative-document.repository',()=>({repoFindAuthoritativePdfByIdempotency:mocks.find}));
vi.mock('../../../shared/authoritative-documents/authoritative-document.service',()=>({queueFrozenCommercialPdfArchive:mocks.queue}));
import {queueFrozenSupplierDocumentTx} from './supplier-po-document-archive.repository';
const snapshot={type:'SUPPLIER_PURCHASE_ORDER',status:'APPROUVEE',code:'BCF-TEST',issuer:{name:'Fixture'},lines:[{quantity:'18'},{quantity:'2'}],general_terms:null};
const document={id:'freeze-id',version:1,payload:{official_snapshot:snapshot,official_source_revision:'frozen-token'}};
beforeEach(()=>{vi.clearAllMocks();mocks.find.mockResolvedValue(null);mocks.queue.mockResolvedValue({id:'archive',documentVersion:2});});
describe('supplier business freeze and GED are one source',()=>{
  it('queues the next GED edition with the exact approved snapshot and source',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{version:2}]});
    await queueFrozenSupplierDocumentTx({query} as unknown as PoolClient,'order',document,1);
    expect(mocks.queue).toHaveBeenCalledWith({query},expect.objectContaining({documentVersion:2,sourceRevision:'frozen-token',
      sourceSnapshot:{...snapshot,frozen_document:{id:'freeze-id',version:1}},actorUserId:1}));
    expect(query.mock.calls[0][0]).toContain('max(document_version)');
    expect(mocks.queue.mock.calls[0][1].idempotencyKey).toBe('commande-fournisseur:order:freeze:freeze-id');
  });
  it('returns accepted immutable work before reading any newer order state',async()=>{
    const prior={entityType:'commande-fournisseur',entityId:'order',documentKind:'SUPPLIER_PURCHASE_ORDER',id:'archive'};
    mocks.find.mockResolvedValue(prior);const query=vi.fn();
    expect(await queueFrozenSupplierDocumentTx({query} as unknown as PoolClient,'order',document,1)).toBe(prior);
    expect(query).not.toHaveBeenCalled();expect(mocks.queue).not.toHaveBeenCalled();
  });
  it('rejects a cross-entity idempotency record',async()=>{
    mocks.find.mockResolvedValue({entityType:'commande-fournisseur',entityId:'other',documentKind:'SUPPLIER_PURCHASE_ORDER'});
    await expect(queueFrozenSupplierDocumentTx({query:vi.fn()} as unknown as PoolClient,'order',document,1)).rejects.toMatchObject({status:409});
  });
  it.each([{}, {official_snapshot:snapshot},{official_source_revision:'token'}, {official_snapshot:{...snapshot,status:'BROUILLON'},official_source_revision:'token'}])('does not substitute mutable values for missing historic source %j',async payload=>{
    const query=vi.fn();
    await expect(queueFrozenSupplierDocumentTx({query} as unknown as PoolClient,'order',{...document,payload},1)).rejects.toMatchObject({status:409});
    expect(query).not.toHaveBeenCalled();expect(mocks.queue).not.toHaveBeenCalled();
  });
});
