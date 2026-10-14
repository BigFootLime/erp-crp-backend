import path from 'node:path';
import {createManagedTestBroker} from './broker';
import {ManagedRegistry} from './registry';
import {PrivilegedHelperClient} from './helper-client';
import {DirectoryClient} from '../shared-directory/client';

async function start(){
  const root=process.env.CERP_MANAGED_TESTS_ROOT??'/var/lib/cerp-managed-tests';
  // #1568 changed: accounts and company must remain shared, with Production as
  // authority. The isolated provisioning fixture does not qualify that contract.
  // Until the directory/session integration is implemented and verified, an env
  // flag alone must never enable independent-account databases in the real app.
  let sharedDirectoryQualified=false;
  if(process.env.CERP_MANAGED_TESTS_ENABLED==='true'){
    const client=new DirectoryClient('http://127.0.0.1:8085/internal/directory','cerp_test',process.env.CERP_DIRECTORY_SITE_CALL_KEY??'');
    const info=await client.call<{directory_id:string;capabilities:string[];import_mode:string}>('info',{});
    sharedDirectoryQualified=info.directory_id===process.env.CERP_SHARED_DIRECTORY_ID&&info.import_mode==='EMPTY_NO_LEGACY_IMPORT'&&['shared-auth-mfa','shared-users','shared-company','shared-avatar'].every(c=>info.capabilities.includes(c));
  }
  const broker=createManagedTestBroker({registry:new ManagedRegistry(path.join(root,'broker','registry.json')),helper:new PrivilegedHelperClient(),commonApi:'http://127.0.0.1:8082/api/v1',origins:(process.env.CERP_MANAGER_CORS_ORIGINS??'https://cerp.croix-rousse-precision.fr,http://cerp.local:8081').split(',').map(s=>s.trim()).filter(Boolean),enabled:sharedDirectoryQualified && process.env.CERP_MANAGED_TESTS_ENABLED==='true'});
  await broker.initialize();broker.server.listen(8084,'127.0.0.1');
  function stop(){const closing=broker.shutdown();broker.server.close(()=>{void closing.then(()=>process.exit(0));});broker.server.closeAllConnections();}
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
void start().catch(()=>{console.error('MANAGED_MANAGER_STARTUP_FAILED');process.exitCode=1;});
