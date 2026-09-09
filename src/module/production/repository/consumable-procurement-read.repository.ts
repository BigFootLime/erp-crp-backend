import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { coverageFingerprint, quantity } from "../domain/of-material";
import { acceptedReceiptInterval,consumableCoverage,selectConsumableStock,type ConsumableStockMode } from "../domain/consumable-coverage";
import { readConsumableStockTx } from "../../stock/repository/consumable-stock.repository";
import { readOfDossierTx } from "./of-dossier.repository";
import { readFutureMaterialSupplyTx } from "./material-future-supply.repository";
import { readReceiptLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import type { PurchaseEvidence } from "../domain/preparation-rules";

type Db=Pick<PoolClient,"query">;
type FrozenPurchase=PurchaseEvidence&{nom?:string;pu_achat?:number|null;gamme_operation_id?:string|null};
type SavedNeed={id:string;source_ref:string;technical_version_id:string;technical_hash:string;of_revision_id:string|null;article_id:string;designation:string;
  consumption_mode:"UNIT"|"GLOBAL_PACK";stock_managed:boolean;receipt_quality_required:boolean;unit:string;required_qty:number;
  supplier_id:string|null;destination_id:string|null;superseded_at:string|null;row_version:number};
export type ConsumableCatalogue={id:string;article_id:string;supplier_id:string;supplier_name:string;reference:string|null;unit:string|null;
  stock_unit:string|null;coefficient:number|null;price:number|null;currency:string;minimum:number|null;pack:number|null;delay:number|null;preferred:boolean;version:string};
type ReceiptEvidence={id:string;lineId:string;lotId:string|null;quantity:number;qualityRequired:boolean;coefficient:number;stockUnit:string|null;accepted:number};
type PromiseEvidence={id:string;needId:string|null;sourceRef:string;lineId:string;articleId:string;assigned:number;offset:number;orderId:string;code:string;
  status:string;due:string|null;transferred:number;received:number;accepted:number};

async function readPurchasePromisesTx(tx:Db,ofId:number):Promise<PromiseEvidence[]> {
  const promises=(await tx.query<PromiseEvidence>(`WITH allocations AS(
    SELECT b.*,(CASE WHEN b.besoin_type='OF_MATERIAL' THEN b.quantite_couverte ELSE b.quantite_couverte*COALESCE(l.coef_conversion,1) END) AS stock_assigned,
    sum(CASE WHEN b.besoin_type='OF_MATERIAL' THEN b.quantite_couverte ELSE b.quantite_couverte*COALESCE(l.coef_conversion,1) END)
      OVER(PARTITION BY b.ligne_id ORDER BY b.created_at,b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier
    FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id WHERE NOT b.annule)
    SELECT b.id::text,b.material_need_id::text AS "needId",b.besoin_ref AS "sourceRef",b.ligne_id::text AS "lineId",l.article_id::text AS "articleId",
      b.stock_assigned::float8 AS assigned,COALESCE(b.stock_receipt_offset,b.earlier,0)::float8 AS offset,c.id::text AS "orderId",c.code,c.statut AS status,
      COALESCE(l.date_promesse,c.date_promesse)::text AS due,COALESCE(t.qty,0)::float8 AS transferred
    FROM allocations b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id JOIN public.commande_fournisseur c ON c.id=l.commande_id
    LEFT JOIN LATERAL(SELECT sum(sr.qty_reserved) AS qty FROM public.of_material_receipt_transfers t JOIN public.stock_reservations sr ON sr.id=t.reservation_id WHERE t.purchase_need_id=b.id) t ON true
    WHERE b.besoin_of_id=$1 AND c.statut<>'ANNULEE' AND l.statut_ligne='ACTIVE' ORDER BY b.created_at,b.id`,[ofId])).rows;
  const lineIds=[...new Set(promises.map(p=>p.lineId))];
  if(!lineIds.length)return promises;
  const receipts=(await tx.query<ReceiptEvidence>(`SELECT r.id::text,r.commande_fournisseur_ligne_id::text AS "lineId",r.lot_id::text AS "lotId",
    (r.qty_received*COALESCE(r.stock_conversion_coef,l.coef_conversion,1))::float8 AS quantity,r.receipt_quality_required AS "qualityRequired",
    COALESCE(r.stock_conversion_coef,l.coef_conversion,1)::float8 AS coefficient,COALESCE(r.stock_unit,l.unite_stock,l.unite) AS "stockUnit"
    FROM public.reception_fournisseur_lignes r JOIN public.commande_fournisseur_ligne l ON l.id=r.commande_fournisseur_ligne_id
    WHERE r.commande_fournisseur_ligne_id=ANY($1::uuid[]) ORDER BY r.created_at,r.id`,[lineIds])).rows;
  for(const receipt of receipts){
    receipt.accepted=receipt.qualityRequired?0:receipt.quantity;
    if(receipt.qualityRequired&&receipt.lotId&&receipt.stockUnit)try{
      const quality=await readReceiptLotQualityEligibility({client:tx,lotId:receipt.lotId,receiptLineId:receipt.id,qty:receipt.quantity,unit:receipt.stockUnit});
      receipt.accepted=Math.min(receipt.quantity,quality.eligibility.qty_allowed);
    }catch(e){if(!(e instanceof HttpError)||e.status>=500)throw e;}
  }
  return promises.map(p=>({...p,...acceptedReceiptInterval(p.offset,p.assigned,receipts.filter(r=>r.lineId===p.lineId))}));
}

export async function readOfConsumablesTx(tx:Db,ofId:number){
  const dossier=await readOfDossierTx(tx,ofId);
  const of=(await tx.query<{version:string|null;hash:string|null;revisionId:string|null;revisionCode:string|null;purchases:FrozenPurchase[]}>(`SELECT o.piece_technique_version_id::text AS version,o.technical_snapshot_sha256 AS hash,r.id::text AS "revisionId",r.revision_code AS "revisionCode",
    COALESCE(o.technical_snapshot->'preparation_evidence'->'purchases','[]') AS purchases FROM public.ordres_fabrication o LEFT JOIN public.of_revisions r ON r.of_id=o.id AND r.statut='ACTIVE' WHERE o.id=$1`,[ofId])).rows[0];
  if(!of)throw new HttpError(404,"OF_NOT_FOUND","OF introuvable.");
  const purchases=of.purchases.filter(p=>p.type_achat==="CONSOMMABLE");
  const articleIds=[...new Set(purchases.flatMap(p=>p.article_id?[p.article_id]:[]))];
  const saved=(await tx.query<SavedNeed>(`SELECT * FROM public.of_material_needs WHERE of_id=$1 AND need_kind='CONSOMMABLE' ORDER BY created_at,id`,[ofId])).rows;
  const resolutions=(await tx.query<{previous_need_id:string;target_need_id:string|null;disposition:string}>(`SELECT previous_need_id::text,target_need_id::text,disposition FROM public.of_material_revision_resolutions WHERE of_id=$1`,[ofId])).rows;
  const destinations=(await tx.query<{source_need_id:string;target_need_id:string}>(`SELECT source_need_id::text,target_need_id::text FROM public.v_of_material_need_destinations WHERE of_id=$1`,[ofId])).rows;
  const effective=(id:string|null)=>id?destinations.find(d=>d.source_need_id===id)?.target_need_id??id:null;
  const articles=(await tx.query<{id:string;code:string;reference:string|null;designation:string;unit:string|null;stock_managed:boolean;consumption_mode:string;pack:number;preferred_catalogue_id:string|null;version:string}>(`SELECT a.id::text,a.code,a.internal_reference AS reference,a.designation,a.unite AS unit,a.stock_managed,a.consumption_mode,
    a.purchase_pack_qty::float8 AS pack,app.preferred_catalogue_id::text,a.updated_at::text AS version FROM public.articles a LEFT JOIN public.article_procurement_profile app ON app.article_id=a.id WHERE a.id=ANY($1::uuid[])`,[articleIds])).rows;
  const catalogues=(await tx.query<ConsumableCatalogue>(`SELECT c.id::text,c.article_id::text,c.fournisseur_id::text AS supplier_id,COALESCE(f.nom,f.raison_sociale) AS supplier_name,
    c.reference_fournisseur AS reference,c.unite AS unit,c.unite_stock AS stock_unit,c.coef_conversion::float8 AS coefficient,c.prix_unitaire::float8 AS price,c.devise AS currency,
    c.moq::float8 AS minimum,c.lot_achat::float8 AS pack,c.delai_jours::int AS delay,(app.preferred_catalogue_id=c.id) AS preferred,c.updated_at::text AS version
    FROM public.fournisseur_catalogue c JOIN public.fournisseurs f ON f.id=c.fournisseur_id LEFT JOIN public.article_procurement_profile app ON app.article_id=c.article_id
    WHERE c.article_id=ANY($1::uuid[]) AND c.actif AND f.actif IS NOT FALSE AND (c.valid_from IS NULL OR c.valid_from<=current_date) AND (c.valid_to IS NULL OR c.valid_to>=current_date)
    ORDER BY (app.preferred_catalogue_id=c.id) DESC NULLS LAST,c.updated_at DESC,c.id`,[articleIds])).rows;
  const stocks=await readConsumableStockTx(tx,articleIds);
  const sharedPending=(await tx.query<{articleId:string;quantity:number}>(`SELECT r.article_id::text AS "articleId",
    sum(GREATEST(0,r.qty_received-COALESCE(s.qty,0))*COALESCE(r.stock_conversion_coef,1))::float8 AS quantity
    FROM public.reception_fournisseur_lignes r JOIN public.receptions_fournisseurs h ON h.id=r.reception_id
    LEFT JOIN LATERAL(SELECT sum(qty) AS qty FROM public.reception_fournisseur_stock_receipts WHERE reception_line_id=r.id) s ON true
    WHERE r.article_id=ANY($1::uuid[]) AND r.stock_managed AND h.status<>'CANCELLED' GROUP BY r.article_id`,[articleIds])).rows;
  const promises=await readPurchasePromisesTx(tx,ofId);
  const future=await readFutureMaterialSupplyTx(tx,articleIds);
  const reservations=(await tx.query<{id:string;needId:string;articleId:string;lotId:string|null;lotCode:string|null;reserved:number;consumed:number;status:string;rowVersion:number;unexpired:boolean}>(`SELECT r.id::text,r.material_need_id::text AS "needId",r.article_id::text AS "articleId",r.lot_id::text AS "lotId",l.lot_code AS "lotCode",
    r.qty_reserved::float8 AS reserved,r.qty_consumed::float8 AS consumed,r.status,r.row_version AS "rowVersion",(r.expires_at IS NULL OR r.expires_at>now()) AS unexpired
    FROM public.stock_reservations r LEFT JOIN public.lots l ON l.id=r.lot_id WHERE r.of_id=$1 AND (r.status IN('ACTIVE','CONSUMED') OR r.qty_consumed>0) ORDER BY r.created_at,r.id`,[ofId])).rows;
  const assignedLegacyReservations=new Set<string>();
  const needs=purchases.map(p=>{
    // Each row opens an independent confirmation. Batch confirmation re-reads
    // after each actual reservation, rather than holding stock for unopened rows.
    const pool=new Map<string,number>();
    const row=saved.find(n=>n.source_ref===p.id&&n.technical_version_id===of.version&&n.technical_hash===of.hash&&n.of_revision_id===of.revisionId&&!n.superseded_at);
    const article=articles.find(a=>a.id===p.article_id);
    const policy=p.article_policy;
    const mode:ConsumableStockMode=policy?.stock_managed===false?"NONE":policy?.consumption_mode==="GLOBAL_PACK"?"GLOBAL_PACK":"UNIT";
    const attached=reservations.filter(r=>(row&&effective(r.needId)===row.id)||(!r.needId&&r.articleId===p.article_id&&!assignedLegacyReservations.has(r.id)));
    attached.filter(r=>!r.needId).forEach(r=>assignedLegacyReservations.add(r.id));
    const ordered=promises.filter(b=>(row&&effective(b.needId)===row.id)||(!b.needId&&b.sourceRef===p.id));
    const supplierId=row?.supplier_id??p.fournisseur_id??catalogues.find(c=>c.article_id===p.article_id&&c.preferred)?.supplier_id??null;
    const catalogue=catalogues.find(c=>c.article_id===p.article_id&&c.supplier_id===supplierId)??null;
    const candidates=stocks.filter(s=>s.articleId===p.article_id);
    const required=quantity(Number(p.quantite)*dossier.quantity);
    const reserved=quantity(attached.filter(r=>r.status==="ACTIVE"&&r.unexpired).reduce((sum,r)=>sum+Math.max(0,r.reserved-r.consumed),0));
    const consumed=quantity(attached.reduce((sum,r)=>sum+(r.status==="CONSUMED"?r.reserved:r.consumed),0));
    const expected=quantity(ordered.reduce((sum,p)=>sum+Math.max(0,p.assigned-p.received),0));
    const receivedAccepted=mode==="NONE"?quantity(ordered.reduce((sum,p)=>sum+p.accepted,0)):0;
    const receivedBlocked=mode==='GLOBAL_PACK'?quantity((sharedPending.find(r=>r.articleId===p.article_id)?.quantity??0)+candidates.filter(c=>c.pack&&c.available<=0).reduce((sum,c)=>sum+c.total,0)):
      quantity(ordered.reduce((sum,p)=>sum+Math.max(0,p.received-(mode==="NONE"?p.accepted:p.transferred)),0));
    const relatedFuture=future.filter(f=>f.articleId===p.article_id);
    const availablePacks=new Set(candidates.filter(s=>s.pack&&s.available>0).map(s=>s.lotId)).size;
    const stockAvailable=candidates.reduce((sum,c)=>sum+(pool.get(c.key)??c.available),0);
    const coverage=consumableCoverage({mode,required,stockAvailable,availablePacks,articlePack:article?.pack??1,
      supplierPack:catalogue?.pack,supplierMinimum:catalogue?.minimum,coefficient:catalogue?.coefficient??1,
      reserved,consumed,expected,receivedBlocked,receivedAccepted,sharedExpected:relatedFuture.reduce((sum,f)=>sum+f.available,0)+receivedBlocked});
    const selections=mode==="UNIT"?selectConsumableStock(candidates,coverage.reserve,pool).selections:[];
    const blockers:string[]=[];
    if(attached.some(r=>!r.needId)&&purchases.filter(other=>other.article_id===p.article_id).length>1)blockers.push("Rapprocher les réservations antérieures : plusieurs besoins utilisent cet article.");
    if(!of.version||!of.hash||!policy?.consumable)blockers.push("Revalider le dossier technique pour figer l’article consommable et son mode de gestion.");
    if(!article||!policy?.unit)blockers.push("Compléter l’article et son unité dans la nomenclature de cette version.");
    if(article&&policy&&(article.unit!==policy.unit||article.stock_managed!==policy.stock_managed||article.consumption_mode!==policy.consumption_mode))blockers.push("Le mode ou l’unité de l’article a changé depuis cette version : rapprocher la définition de l’OF.");
    if(catalogue&&(catalogue.stock_unit??catalogue.unit)!==policy?.unit)blockers.push("Confirmer la conversion de l’unité d’achat vers l’unité du besoin.");
    if(catalogue&&catalogue.unit!==policy?.unit&&!catalogue.coefficient)blockers.push("Renseigner le coefficient de conversion fournisseur.");
    return {...coverage,id:row?.id??null,key:p.id,articleId:p.article_id,articleCode:article?.code??null,reference:article?.reference??null,
      designation:p.designation??p.nom??article?.designation??"Consommable à définir",unit:policy?.unit??null,mode,policy,articlePack:article?.pack??1,
      supplierId,destinationId:row?.destination_id??null,catalogue,catalogues:catalogues.filter(c=>c.article_id===p.article_id),
      reserved,consumed,expected,receivedBlocked,receivedAccepted,reservations:attached,promises:ordered,candidates,selections,availablePacks,
      futureSupplies:relatedFuture.map(f=>({...f,compatible:f.unit===policy?.unit&&f.destinationId===(row?.destination_id??null)&&!f.ownerClientId&&!f.allocatedNeedIds.includes(row?.id??"")})),
      blockers,rowVersion:row?.row_version??null};
  });
  const previousNeeds=saved.filter(n=>!needs.some(current=>current.id===n.id)&&!resolutions.some(r=>r.previous_need_id===n.id)).map(n=>({...n,
    reservations:reservations.filter(r=>effective(r.needId)===n.id),promises:promises.filter(p=>effective(p.needId)===n.id)}))
    .filter(n=>n.reservations.some(r=>r.consumed>0||r.status==="CONSUMED"||r.status==="ACTIVE"&&r.unexpired)||n.promises.length>0);
  const otherPurchases=of.purchases.filter(p=>p.type_achat!=="CONSOMMABLE");
  const otherIds=[...new Set(otherPurchases.flatMap(p=>p.article_id?[p.article_id]:[]))];
  const otherArticles=(await tx.query<{id:string;stockManaged:boolean;unit:string|null}>('SELECT id::text,stock_managed AS "stockManaged",unite AS unit FROM public.articles WHERE id=ANY($1::uuid[])',[otherIds])).rows;
  const otherStock=await readConsumableStockTx(tx,otherIds);
  const trackedOtherPurchases=otherPurchases.map(p=>{
    const a=otherArticles.find(a=>a.id===p.article_id),required=quantity(p.quantite*dossier.quantity);
    const attached=promises.filter(b=>b.sourceRef===p.id);
    const legacy=reservations.filter(r=>!r.needId&&r.articleId===p.article_id);
    const ambiguous=legacy.length>0&&of.purchases.filter(n=>n.article_id===p.article_id).length>1;
    const reserved=ambiguous?0:quantity(legacy.filter(r=>r.status==='ACTIVE'&&r.unexpired).reduce((s,r)=>s+Math.max(0,r.reserved-r.consumed),0));
    const consumed=ambiguous?0:quantity(legacy.reduce((s,r)=>s+(r.status==='CONSUMED'?r.reserved:r.consumed),0));
    const expected=quantity(attached.reduce((s,p)=>s+Math.max(0,p.assigned-p.received),0));
    const accepted=quantity(attached.reduce((s,p)=>s+p.accepted,0));
    const waiting=quantity(attached.reduce((s,p)=>s+Math.max(0,p.received-p.accepted),0));
    const stockAvailable=quantity(otherStock.filter(s=>s.articleId===p.article_id&&s.unit===a?.unit).reduce((sum,s)=>sum+s.available,0));
    // Generic rubrics expose existing evidence; only an unambiguous reservation
    // or accepted non-stock purchase establishes availability here.
    const unitsMatch=!!a?.unit&&a.unit===p.unite_prix;
    const available=unitsMatch&&!ambiguous&&(a?.stockManaged?reserved+consumed:accepted)>=required;
    let status='À commander',reason='Besoin non couvert : ouvrir le parcours de cette rubrique pour préparer son approvisionnement.';
    if(available){status='Disponible';reason='Le besoin est couvert par ses engagements disponibles.';}
    else if(ambiguous){status='À rapprocher';reason='Plusieurs besoins utilisent cet article : les réservations antérieures doivent être rapprochées.';}
    else if(!p.article_id||!unitsMatch){status='À vérifier';reason='Confirmer l’article, les unités et les engagements dans le parcours de cette rubrique.';}
    else if(waiting>0){status='En attente de qualité';reason=`${waiting} ${a.unit} reçus restent en attente d’acceptation qualité.`;}
    else if(attached.some(p=>p.received>0&&p.received<p.assigned)){status='Réception partielle';reason=`${expected} ${a.unit} restent attendus pour ce besoin.`;}
    else if(attached.some(p=>p.status==='ACCUSE_RECU')){status='AR reçu';reason='Date fournisseur confirmée, disponibilité à établir après réception.';}
    else if(attached.some(p=>['ENVOYEE','PARTIELLEMENT_RECUE','RECUE'].includes(p.status))){status='Commandé';reason='Achat lié au besoin ; réception ou mise à disposition encore attendue.';}
    else if(attached.length){status='Brouillon préparé';reason='Un achat est déjà lié au besoin. Ouvrir ce brouillon avant de préparer une autre commande.';}
    else if(stockAvailable>0){status='À réserver';reason=`${stockAvailable} ${a?.unit} disponibles en stock ; l’affectation à ce besoin reste à confirmer.`;}
    return {...p,tracking:{required,unit:a?.unit??p.unite_prix,available,stockAvailable,reserved,consumed,expected,receivedAccepted:accepted,receivedBlocked:waiting,status,reason,promises:attached}};
  });
  return {ofId,number:dossier.number,dossierStatus:dossier.status,executionStatus:dossier.executionStatus,technicalVersion:of.version,technicalHash:of.hash,ofRevisionId:of.revisionId,ofRevisionCode:of.revisionCode,
    version:coverageFingerprint({dossier:dossier.version,ofRevision:of.revisionId,saved,articles,catalogues,stocks,promises,future,reservations,resolutions,sharedPending}),needs,previousNeeds,
    operations:dossier.operations,otherPurchases:trackedOtherPurchases,
    destinations:(await tx.query<{id:string;name:string}>(`SELECT id::text,COALESCE(code,code_magasin) AS name FROM public.magasins ORDER BY COALESCE(code,code_magasin)`)).rows};
}

export async function getOfConsumables(ofId:number){
  const tx=await pool.connect();
  try{await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const result=await readOfConsumablesTx(tx,ofId);await tx.query("COMMIT");return result;}
  catch(e){await tx.query("ROLLBACK");throw e;}finally{tx.release();}
}
