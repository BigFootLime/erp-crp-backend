const {spawnSync}=require('node:child_process');
const env={...process.env,DATABASE_URL:'postgresql://cerp_fixture@127.0.0.1:15463/cerp_test',CERP_E2E_ISOLATED:'1',CERP_E2E_QUIET:'1',NODE_ENV:'test'};
const result=spawnSync(process.execPath,['scripts/e2e/migrate-isolated.js'],{env,stdio:'inherit'});
process.exit(result.status ?? 1);
