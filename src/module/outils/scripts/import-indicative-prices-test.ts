/** TEST-only CLI. Printed catalogue evidence is intentionally separate from current offers and actual purchases. */
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import db from "../../../config/database";
import { recordToolIndicativeCataloguePrice } from "../repository/outil-indicative-price.repository";

type Price = { manufacturer:string; reference:string; currency:"EUR"; unit:"piece"; unit_price:string; price_type:"catalogue_indicatif"; tariff_date:null; tax_basis:null; source:{document:string;sha256:string;page:number;price_rect:number[];selection_id:string} };
type Dataset = { status:string; prices:Price[] };
const arg=(name:string)=>{const at=process.argv.indexOf(name);return at<0?null:process.argv[at+1]??null};
const stableKey=(x:unknown)=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");

async function main() {
  const datasetPath=arg("--dataset"), expectedHash=arg("--sha256"), actorId=Number(arg("--actor-id")), username=arg("--actor-username"), apply=process.argv.includes("--apply");
  if(!datasetPath||!expectedHash||!/^[a-f0-9]{64}$/i.test(expectedHash)||!Number.isInteger(actorId)||actorId<=0||!username) throw new Error("Usage: --dataset <absolute-json> --sha256 <sha256> --actor-id <id> --actor-username <name> [--apply]");
  if(!path.isAbsolute(datasetPath)) throw new Error("INDICATIVE_PRICE_DATASET_ABSOLUTE_PATH_REQUIRED");
  const bytes=await readFile(datasetPath); if(crypto.createHash("sha256").update(bytes).digest("hex")!==expectedHash.toLowerCase()) throw new Error("INDICATIVE_PRICE_DATASET_HASH_MISMATCH");
  const dataset=JSON.parse(bytes.toString("utf8")) as Dataset;
  if(dataset.status!=="source-extracted-indicative-only-not-a-purchase-price"||!Array.isArray(dataset.prices)||dataset.prices.length!==1674) throw new Error("INDICATIVE_PRICE_DATASET_CONTRACT_INVALID");
  const database=(await db.query<{database:string}>("SELECT current_database() AS database")).rows[0]?.database;
  if(database!=="cerp_test") throw new Error("INDICATIVE_PRICE_IMPORT_TEST_DATABASE_REQUIRED");
  if(apply&&process.env.CERP_TOOL_INDICATIVE_PRICE_TEST_IMPORT!=="true") throw new Error("INDICATIVE_PRICE_IMPORT_APPLY_DISABLED");
  const audit={userId:actorId,ip:null,userAgent:`#1762-indicative-price-import:${username}`,path:"cli:#1762-indicative-prices",pageKey:"outillage",sessionId:null};
  const plan: Array<{manufacturer:string;reference:string;toolId:number;catalogueId:string;key:string}>=[];
  for(const price of dataset.prices) {
    if(price.price_type!=="catalogue_indicatif"||price.tariff_date!==null||price.tax_basis!==null||price.currency!=="EUR"||price.unit!=="piece"||!/^\d+(\.\d{1,3})?$/.test(price.unit_price)||!/^[a-f0-9]{64}$/i.test(price.source.sha256)||!Array.isArray(price.source.price_rect)||price.source.price_rect.length!==4) throw new Error(`INDICATIVE_PRICE_ROW_INVALID:${price.manufacturer}:${price.reference}`);
    const tool=await db.query<{id_outil:number;fournisseur_id:string}>(`SELECT o.id_outil,m.fournisseur_id::text FROM gestion_outils_outil o JOIN gestion_outils_fabricant f ON f.id_fabricant=o.id_fabricant JOIN gestion_outils_catalogue_provenance p ON p.id_outil=o.id_outil JOIN outillage_fabricant_fournisseur_master m ON m.id_fabricant=f.id_fabricant WHERE f.name=$1 AND o.reference_fabricant=$2 AND p.source_document=$3 AND p.source_sha256=$4`,[price.manufacturer,price.reference,price.source.document,price.source.sha256]);
    if(tool.rows.length!==1) throw new Error(`INDICATIVE_PRICE_TOOL_RESOLUTION_FAILED:${price.manufacturer}:${price.reference}:${tool.rows.length}`);
    const catalogue=await db.query<{id:string}>("SELECT id::text AS id FROM fournisseur_catalogue WHERE fournisseur_id=$1::uuid AND type='OUTILLAGE' AND actif=true AND reference_fournisseur=$2",[tool.rows[0].fournisseur_id,price.reference]);
    if(catalogue.rows.length!==1) throw new Error(`INDICATIVE_PRICE_CATALOGUE_RESOLUTION_FAILED:${price.manufacturer}:${price.reference}:${catalogue.rows.length}`);
    const key=stableKey({v:1,tool:tool.rows[0].id_outil,catalogue:catalogue.rows[0].id,price:price.unit_price,currency:price.currency,unit:price.unit,document:price.source.document,sha:price.source.sha256,page:price.source.page,rect:price.source.price_rect});
    plan.push({manufacturer:price.manufacturer,reference:price.reference,toolId:tool.rows[0].id_outil,catalogueId:catalogue.rows[0].id,key});
    if(apply) await recordToolIndicativeCataloguePrice({idempotencyKey:key,toolId:tool.rows[0].id_outil,catalogueId:catalogue.rows[0].id,unitPrice:price.unit_price,currency:price.currency,unit:price.unit,source:{document:price.source.document,sha256:price.source.sha256,page:price.source.page,rect:price.source.price_rect,sourceDate:null,taxBasis:"UNKNOWN"}},audit);
  }
  if(new Set(plan.map(x=>x.key)).size!==plan.length) throw new Error("INDICATIVE_PRICE_IDEMPOTENCY_KEY_COLLISION");
  process.stdout.write(JSON.stringify({apply,database,planned:plan.length,manufacturers:[...new Set(plan.map(x=>x.manufacturer))],price_kind:"CATALOGUE_INDICATIF",tariff_date:null,tax_basis:"UNKNOWN"})+"\n");
}
main().catch(e=>{process.stderr.write(`${e instanceof Error?e.message:String(e)}\n`);process.exitCode=1}).finally(()=>db.end());
