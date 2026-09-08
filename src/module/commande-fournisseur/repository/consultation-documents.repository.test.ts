import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({access:vi.fn()}));
vi.mock('../../ged/services/ged-parent-authorization.service',()=>({assertGedVersionParentReadable:m.access}));
import {readConsultationDocuments} from './consultation-documents.repository';
import {HttpError} from '../../../utils/httpError';
const actor={user_id:1,role:'Achats'},document={document_id:'doc',version_id:'version',code:'DT-1',title:'Plan',original_name:'plan.pdf',version_number:2,sha256:'hash'};
beforeEach(()=>{vi.clearAllMocks();m.access.mockResolvedValue({});});
describe('supplier request document scope',()=>{
  it('freezes only selected accessible versions and their content identity',async()=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[document]})};
    expect(await readConsultationDocuments(tx as never,'po',actor,['version'])).toEqual([document]);
    expect(m.access).toHaveBeenCalledWith(1,'doc');
    expect(tx.query.mock.calls[0][1]).toEqual(['po',['version']]);
  });
  it('refuses a changed, foreign or duplicate selected version',async()=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[]})};
    await expect(readConsultationDocuments(tx as never,'po',actor,['foreign'])).rejects.toMatchObject({code:'CONSULTATION_DOCUMENT_CHANGED'});
    tx.query.mockResolvedValue({rows:[document]});
    await expect(readConsultationDocuments(tx as never,'po',actor,['version','version'])).rejects.toMatchObject({code:'CONSULTATION_DOCUMENT_CHANGED'});
  });
  it('hides denied parents from suggestions and refuses selecting them',async()=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[document]})};m.access.mockRejectedValue(new HttpError(404,'GED_VERSION_NOT_FOUND','Introuvable'));
    expect(await readConsultationDocuments(tx as never,'po',actor)).toEqual([]);
    await expect(readConsultationDocuments(tx as never,'po',actor,['version'])).rejects.toMatchObject({status:404});
  });
  it('does not treat an unavailable authorization service as an empty list',async()=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[document]})};m.access.mockRejectedValue(new Error('ACL unavailable'));
    await expect(readConsultationDocuments(tx as never,'po',actor)).rejects.toThrow('ACL unavailable');
  });
});
