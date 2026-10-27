/* Run in a fresh fixture child: --kind seller|buyer --client <id> --source <id> --line <source-line-id> --expected-price <decimal> */
import { repoPreviewFacture, repoCreateFactureDraft } from "../../src/module/facturation/repository/facture-workflow.repository";

const args=process.argv.slice(2); const value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const kind=value("--kind"); const clientId=value("--client"); const sourceId=value("--source"); const lineId=value("--line"); const expected=value("--expected-price");
if((kind!=="seller"&&kind!=="buyer")||!clientId||!expected||!sourceId||!lineId)throw new Error("usage: --kind seller|buyer --client ID --source ID --line source-line-id --expected-price DECIMAL");
const sourceType=kind==="buyer"?"EXTERNAL_FULFILMENT_RECEIPT_LINE":"DELIVERY_LINE";
const actor={userId:1,path:"/e2e/intercompany-billing-1454",requestId:`billing-${kind}`};
const regulatory={billing_frame_code:"B2C",operation_category:"GOODS",transaction_scope:"FR_PRIVATE_B2B"} as const;

async function main(){
  // Explicit source IDs are preferred. The API intentionally never scans across companies.
  const input={client_id:clientId,currency:"EUR",sources:[{source_type:sourceType,source_id:sourceId,source_line_id:lineId,quantity:"1.000"}],due_dates:[{due_date:"2026-12-31",label:"E2E TEST solde"}],regulatory};
  const preview=await repoPreviewFacture(input as never);
  if(preview.blockers.length)throw new Error(`BILLING_BLOCKED:${preview.blockers.map(x=>x.code).join(",")}`);
  const price=preview.lines[0]?.unit_price_ex_tax;
  if(price!==Number(expected).toFixed(4))throw new Error(`PRICE_MISMATCH:${price}`);
  const drafted=await repoCreateFactureDraft({input:{...input,preview_hash:preview.preview_hash} as never,actor,idempotencyKey:`e2e-1454-${kind}-${sourceId}`});
  const replay=await repoCreateFactureDraft({input:{...input,preview_hash:preview.preview_hash} as never,actor,idempotencyKey:`e2e-1454-${kind}-${sourceId}`});
  if(!replay.idempotent_replay)throw new Error("DRAFT_REPLAY_NOT_IDEMPOTENT");
  console.log(JSON.stringify({kind,source_type:sourceType,source_id:sourceId,unit_price_ex_tax:price,draft:drafted,replay:true}));
}
main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1});
