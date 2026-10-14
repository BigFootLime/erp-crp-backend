/** Read-only preflight. Integer IDs are local foreign keys, never shared identity. */
export type DirectoryAccount = {id:number;username:string;email:string|null};
export type DirectoryComparison = {
  production_accounts:number;test_accounts:number;matching_identities:number;
  same_id_different_identity:number;matching_identity_different_id:number;
  ambiguous_identities:number;unmatched_production:number;unmatched_test:number;
  ready_for_automatic_reconciliation:boolean;
};
function identity(account:DirectoryAccount) {
  const username=account.username.trim().toUpperCase(),email=account.email?.trim().toLowerCase();
  return username && email ? `${username}\0${email}`:null;
}
export function compareDirectories(production:readonly DirectoryAccount[],test:readonly DirectoryAccount[]):DirectoryComparison {
  const byIdentity=(accounts:readonly DirectoryAccount[])=>{const result=new Map<string,DirectoryAccount[]>();for(const account of accounts){const key=identity(account);if(key)result.set(key,[...(result.get(key)??[]),account]);}return result;};
  const prod=byIdentity(production),trial=byIdentity(test),prodIds=new Map(production.map(a=>[a.id,a]));
  let matching=0,differentId=0,ambiguous=production.filter(a=>!identity(a)).length+test.filter(a=>!identity(a)).length;
  for(const [key,accounts] of prod){const other=trial.get(key);if(accounts.length>1 || (other?.length??0)>1){ambiguous++;continue;}if(other?.length===1){matching++;if(accounts[0].id!==other[0].id)differentId++;}}
  for(const [key,accounts] of trial)if(!prod.has(key) && accounts.length>1)ambiguous++;
  let collisions=0;for(const account of test){const other=prodIds.get(account.id);if(other && (!identity(account) || identity(account)!==identity(other)))collisions++;}
  return {production_accounts:production.length,test_accounts:test.length,matching_identities:matching,
    same_id_different_identity:collisions,matching_identity_different_id:differentId,ambiguous_identities:ambiguous,
    unmatched_production:production.length-matching,unmatched_test:test.length-matching,
    // Password/MFA and business foreign keys still require a reviewed migration.
    // Matching names/emails alone never authorizes a merge or credential reuse.
    ready_for_automatic_reconciliation:false};
}
