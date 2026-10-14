if(process.env.NODE_ENV!=='test'||!/^postgresql:\/\/(cerp_fixture|cerp_directory_app)@127\.0\.0\.1:15463\/cerp_directory_[a-f0-9]{32}$/.test(process.env.DATABASE_URL??''))throw new Error('OWNED_DIRECTORY_FIXTURE_REQUIRED');
require('ts-node/register/transpile-only');
require('../../src/shared/uploads/upload-scanner').setUploadScannerForTests({name:'owned-fixture-scanner',scan:async()=>({status:'clean',provider:'owned-fixture-scanner'})});
require('../../src/shared-directory/index');
