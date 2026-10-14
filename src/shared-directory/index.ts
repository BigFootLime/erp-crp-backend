import pool from '../config/database';
import {assertMfaStartupConfiguration} from '../module/auth/domain/mfa';
import {createDirectoryServer} from './server';
import {directoryIdSchema} from './model';
import {readDirectoryCallerKeys} from './caller-keys';
import {probeUploadScannerHealth} from '../shared/uploads/upload-scanner';
async function start(){
 assertMfaStartupConfiguration();
 if(!process.env.JWT_SECRET || !process.env.AUTH_RATE_LIMIT_HASH_KEY)throw new Error('DIRECTORY_PRIVATE_CONFIGURATION_REQUIRED');
 if(process.env.NODE_ENV==='production'){
  if(!process.env.CERP_STORAGE_ROOT||!process.env.CERP_IMAGES_ROOT||!process.env.CERP_TMP_ROOT)throw new Error('DIRECTORY_PRIVATE_STORAGE_REQUIRED');
  if(!(await probeUploadScannerHealth()).ready)throw new Error('DIRECTORY_SCANNER_NOT_READY');
 }
 const file=process.env.CERP_DIRECTORY_CALLERS_FILE??'/etc/cerp-shared-directory/callers.json';
 await readDirectoryCallerKeys(file);
 const keys=()=>readDirectoryCallerKeys(file);
 const server=createDirectoryServer({db:pool,directoryId:directoryIdSchema.parse(process.env.CERP_SHARED_DIRECTORY_ID),sourceJwtSecret:process.env.JWT_SECRET,keys,registrationOpen:process.env.CERP_DIRECTORY_TEST_REGISTRATION_OPEN==='true',registrationHashKey:process.env.AUTH_RATE_LIMIT_HASH_KEY});
 await server.initialize();const listener=server.app.listen(8085,'127.0.0.1');
 const stop=()=>listener.close(()=>{void pool.end().finally(()=>process.exit(0));});process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
void start().catch(()=>{console.error('DIRECTORY_STARTUP_FAILED');void pool.end().finally(()=>{process.exitCode=1;});});
