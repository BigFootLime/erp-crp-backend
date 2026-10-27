/* Run in a fresh fixture child: --kind seller|buyer --client <id> --source <id> --line <source-line-id> --expected-price <decimal> */
import { repoPreviewFacture, repoCreateFactureDraft } from "../../src/module/facturation/repository/facture-workflow.repository";
import { svcRequestFactureValidation, svcValidateFacture, svcIssueFacture } from "../../src/module/facturation/services/facture-workflow.service";
import { Pool } from "pg";

const args=process.argv.slice(2); const value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const kind=value("--kind"); const clientId=value("--client"); const sourceId=value("--source"); const lineId=value("--line"); const expected=value("--expected-price"); const quantity=value("--quantity"); const frame=value("--frame"); const category=value("--category"); const scope=value("--scope");
const dbUrl=new URL(process.env.DATABASE_URL??""); if(!["127.0.0.1","localhost","::1"].includes(dbUrl.hostname)||dbUrl.port!=="15464"||!/^\/cerp_ec1454_(buyer|seller)_v2$/.test(dbUrl.pathname))throw new Error("FIXTURE_DATABASE_GUARD_FAILED");
if(process.env.CERP_COMPANY_ENVIRONMENT!=="cerp_test")throw new Error("FIXTURE_COMPANY_ENVIRONMENT_GUARD_FAILED");
if((kind!=="seller"&&kind!=="buyer")||!clientId||!expected||!sourceId||!lineId||!quantity||!frame||!category||!scope)throw new Error("usage: --kind seller|buyer --client ID --source ID --line source-line-id --quantity N --expected-price P --frame FRAME --category GOODS|SERVICES --scope SCOPE");
const sourceType=kind==="buyer"?"EXTERNAL_FULFILMENT_RECEIPT_LINE":"DELIVERY_LINE";
const actor={userId:1,path:"/e2e/intercompany-billing-1454",requestId:`billing-${kind}`};
const regulatory={billing_frame_code:frame,operation_category:category,transaction_scope:scope};

async function main(){
  // Explicit source IDs are preferred. The API intentionally never scans across companies.
  process.stdout.write(JSON.stringify({marker:"BILLING_FIXTURE_STARTED",kind,sourceId,lineId})+"\n");
  const canonicalQuantity=Number(quantity).toFixed(3);
  const input={client_id:clientId,currency:"EUR",global_discount_percent:"0.0000",sources:[{source_type:sourceType,source_id:sourceId,source_line_id:lineId,quantity:canonicalQuantity}],due_dates:[{due_date:"2026-12-31",label:"E2E TEST solde"}],regulatory};
  const preview=await repoPreviewFacture(input as never);
  if(preview.blockers.length)throw new Error(`BILLING_BLOCKED:${preview.blockers.map(x=>x.code).join(",")}`);
  const price=preview.lines[0]?.unit_price_ex_tax;
  if(price!==Number(expected).toFixed(4))throw new Error(`PRICE_MISMATCH:${price}`);
  const drafted=await repoCreateFactureDraft({input:{...input,preview_hash:preview.preview_hash} as never,actor,idempotencyKey:`e2e-1454-${kind}-${sourceId}`});
  const replay=await repoCreateFactureDraft({input:{...input,preview_hash:preview.preview_hash} as never,actor,idempotencyKey:`e2e-1454-${kind}-${sourceId}`});
  if(!replay.idempotent_replay)throw new Error("DRAFT_REPLAY_NOT_IDEMPOTENT");
  const requested=await svcRequestFactureValidation({factureId:Number(drafted.id),input:{expected_version:drafted.row_version,preview_hash:preview.preview_hash} as never,actor,idempotencyKey:`e2e-1454-request-${kind}-${sourceId}`});
  const approved=await svcValidateFacture({factureId:Number(drafted.id),input:{decision:"APPROVE",expected_version:requested.row_version,reason:"E2E TEST approval"} as never,actor,idempotencyKey:`e2e-1454-approve-${kind}-${sourceId}`});
  const issued=await svcIssueFacture({factureId:Number(drafted.id),input:{expected_version:approved.row_version,preview_hash:preview.preview_hash} as never,actor,idempotencyKey:`e2e-1454-issue-${kind}-${sourceId}`});
  const db=new Pool({connectionString:dbUrl.toString()}); try { const persisted=await db.query<{statut:string;legal_number:string|null;issuer_snapshot:unknown;client_snapshot:unknown;total_ht:string}>("SELECT statut,legal_number,issuer_snapshot,client_snapshot,total_ht::text FROM facture WHERE id=$1",[drafted.id]); const row=persisted.rows[0]; if(!row||row.statut!=="ISSUED"||!row.legal_number||!row.issuer_snapshot||!row.client_snapshot)throw new Error("ISSUE_PERSISTENCE_OR_IDENTITY_ASSERTION_FAILED"); process.stdout.write(JSON.stringify({marker:"BILLING_FIXTURE_ISSUED",kind,source_type:sourceType,source_id:sourceId,unit_price_ex_tax:price,total_ht:row.total_ht,legal_number:row.legal_number,draft:drafted.id,issued:issued.id,replay:true})+"\n"); } finally {await db.end()}
}
main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1});
