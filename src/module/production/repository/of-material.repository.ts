import type {PoolClient} from "pg";
import {readOperationalLotQualityEligibility} from "../../qualite/repository/quality-operational-gate.repository";
import type {MaterialLotVerification} from "../validators/of-material.validators";
import pool from "../../../config/database";
import {HttpError} from "../../../utils/httpError";
import {withRealtimeOutboxTransaction} from "../../../shared/realtime/realtime-outbox-transaction";
import {materialWorkflowEnabled,readOfDossierTx,type DossierDb} from "./of-dossier.repository";
import {preparationAudit} from "./production-preparation.repository";
import type {AuditContext} from "./production.repository";
import {materialPropertiesFingerprint,coverageFingerprint,debitQuantity,materialBalance,lotCompatibility,proposeMaterialCoverage,purchaseQuantity,quantity,type MaterialNeed,type MaterialLot,type MaterialRequirements,type DebitRule} from "../domain/of-material";
import {repoCreateStockReservation} from "../../stock/repository/stock-reservation.repository";
import {createMaterialDraftsTx,type MaterialDraftLine} from "../../commande-fournisseur/repository/commande-fournisseur.repository";

const emptyRequirements=():MaterialRequirements=>({grade:null,condition:null,ownerClientId:null,dimensions:{},certificates:[],manualChecks:[]});
type Purchase={id:string;article_id:string|null;nom?:string;designation?:string;quantite:number;unite_prix:string|null;fournisseur_id:string|null;pu_achat?:number|null;type_achat:string;gamme_operation_id?:string|null};
type NeedRow={id:string;source_ref:string;technical_version_id:string;technical_hash:string;operation_id:string|null;article_id:string|null;required_qty:number;unit:string|null;supply_mode:"PURCHASE"|"CUSTOMER";requirements:MaterialRequirements;specification_reviewed_at:string|null;debit_rule:DebitRule|null;allow_partial:boolean;supplier_id:string|null;destination_id:string|null;row_version:number;superseded_at:string|null};
export type NeedConfiguration={operationId:string;requirements:MaterialRequirements;supplyMode:"PURCHASE"|"CUSTOMER";debitRule:DebitRule;allowPartial:boolean;supplierId:string|null;destinationId:string|null};
type Candidate=MaterialLot&{magasinId:string;emplacementId:number;version:string;properties:Record<string,unknown>;propertiesHash:string;qualityControlId:string|null;qualityExplanation:string[];documents:Array<{id:string;label:string;receptionId:string}>};

export async function readMaterialTx(tx:DossierDb,ofId:number){
  const dossier=await readOfDossierTx(tx,ofId);
  const of=(await tx.query(`SELECT o.piece_technique_version_id::text AS revision,o.technical_snapshot_sha256 AS hash,o.client_id,
    COALESCE(o.technical_snapshot->'preparation_evidence'->'purchases',
      (SELECT jsonb_agg(to_jsonb(p)) FROM public.pieces_techniques_achats p WHERE p.piece_technique_id=o.piece_technique_id AND p.piece_technique_version_id=o.piece_technique_version_id),'[]'::jsonb) AS purchases
    FROM public.ordres_fabrication o WHERE o.id=$1`,[ofId])).rows[0];
  const purchases=(of.purchases as Purchase[]).filter(p=>p.type_achat==="MATIERE");
  const saved=(await tx.query<NeedRow>("SELECT * FROM public.of_material_needs WHERE of_id=$1 ORDER BY created_at,id",[ofId])).rows;
  const reservations=(await tx.query(`SELECT r.id::text,r.material_need_id::text,r.article_id::text,r.qty_reserved::float8,r.qty_consumed::float8,r.status,r.row_version,r.lot_id::text,
    r.stock_batch_id::text,(r.expires_at IS NULL OR r.expires_at>now()) AS unexpired,
    l.lot_status FROM public.stock_reservations r LEFT JOIN public.lots l ON l.id=r.lot_id
    WHERE(r.of_id=$1 OR(r.source_type='OF' AND r.source_id=$1::text)) AND(r.status IN ('ACTIVE','CONSUMED') OR r.qty_consumed>0)
      AND(r.status='CONSUMED' OR r.qty_consumed>0 OR r.expires_at IS NULL OR r.expires_at>now()) ORDER BY r.created_at,r.id`,[ofId])).rows;
  // Allocate receipts along promised quantities in the stable allocation order.
  // The same physical receipt can never be subtracted from each recipient.
  const promises=(await tx.query(`WITH allocations AS(
    SELECT b.*,sum(b.quantite_couverte) OVER(PARTITION BY b.ligne_id ORDER BY b.created_at,b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier
    FROM public.commande_fournisseur_ligne_besoin b WHERE NOT b.annule)
    SELECT b.id::text,b.material_need_id::text,b.besoin_ref,b.quantite_couverte::float8 AS assigned,c.id::text AS command_id,c.code,c.statut,
      COALESCE(l.date_promesse,c.date_promesse)::text AS due,l.article_id::text,l.unite,l.updated_at::text,
      LEAST(b.quantite_couverte,GREATEST(0,COALESCE(r.received,0)-COALESCE(b.earlier,0)))::float8 AS received,
      COALESCE(t.transferred,0)::float8 AS transferred
    FROM allocations b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id JOIN public.commande_fournisseur c ON c.id=l.commande_id
    LEFT JOIN LATERAL(SELECT sum(rl.qty_received*COALESCE(rl.stock_conversion_coef,l.coef_conversion,1)) AS received FROM public.reception_fournisseur_lignes rl WHERE rl.commande_fournisseur_ligne_id=l.id) r ON true
    LEFT JOIN LATERAL(SELECT sum(sr.qty_reserved) AS transferred FROM public.of_material_receipt_transfers t JOIN public.stock_reservations sr ON sr.id=t.reservation_id WHERE t.purchase_need_id=b.id) t ON true
    WHERE b.besoin_of_id=$1 AND c.statut<>'ANNULEE' AND l.statut_ligne<>'ANNULEE' ORDER BY b.created_at,b.id`,[ofId])).rows;
  const articleIds=[...new Set(purchases.flatMap(p=>p.article_id?[p.article_id]:[]))];
  const articles=(await tx.query(`SELECT a.id::text,a.code,a.unite,m.client_proprietaire_id FROM public.articles a LEFT JOIN public.articles_matiere m ON m.article_id=a.id WHERE a.id=ANY($1::uuid[])`,[articleIds])).rows;
  const lots=(await tx.query<Candidate>(`SELECT l.id::text,b.id::text AS "batchId",l.article_id::text AS "articleId",l.lot_code AS code,a.unite AS unit,l.lot_status AS quality,
    GREATEST(0,LEAST(b.qty_total-b.qty_reserved-b.qty_depreciated,s.qty_total-s.qty_reserved-s.qty_depreciated))::float8 AS available,s.id::text AS "stockLevelId",GREATEST(0,s.qty_total-s.qty_reserved-s.qty_depreciated)::float8 AS "levelAvailable",
    COALESCE(l.received_at::text,l.created_at::text) AS "receivedAt",l.material_properties->>'grade' AS grade,l.material_properties->>'condition' AS condition,
    (SELECT COALESCE(sum(GREATEST(0,physical.qty_total-physical.qty_depreciated)),0)::float8 FROM public.stock_batches physical WHERE physical.lot_id=l.id) AS "physicalQuantity",
    COALESCE(l.client_proprietaire_id,m.client_proprietaire_id) AS "ownerClientId",COALESCE(l.material_properties->'dimensions','{}') AS dimensions,
    COALESCE(l.material_properties->'certificates','[]') AS certificates,false AS "manualVerified",COALESCE(l.material_properties,'{}'::jsonb) AS properties,
    e.magasin_id::text AS "magasinId",e.id::bigint::int AS "emplacementId",concat_ws(':',l.updated_at,s.updated_at,b.qty_reserved,b.qty_total) AS version
    FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id JOIN public.lots l ON l.id=b.lot_id
    JOIN public.articles a ON a.id=l.article_id LEFT JOIN public.articles_matiere m ON m.article_id=a.id
    JOIN public.emplacements e ON e.location_id=s.location_id WHERE l.article_id=ANY($1::uuid[]) AND b.qty_total>0
    ORDER BY l.received_at NULLS LAST,l.created_at,l.id,b.id`,[articleIds])).rows;
  const qualityByLot=new Map<string,{available:number;blocks:string[];explanation:string[];controlId:string|null}>();
  for(const lot of lots){
    if(!qualityByLot.has(lot.id)){
      try{
        const decision=await readOperationalLotQualityEligibility({client:tx,lotId:lot.id,qty:lots.filter(l=>l.id===lot.id).reduce((sum,l)=>sum+l.available,0),unit:lot.unit,purpose:"RESERVE"});
        qualityByLot.set(lot.id,{available:decision.available,blocks:decision.eligibility.blocks.filter(b=>b.code!=="QTY_NOT_RELEASED"||decision.available===0).map(b=>`${b.message} ${b.expected_action}`),explanation:decision.eligibility.blocks.map(b=>`${b.message} ${b.expected_action}`),controlId:decision.evidence.control_ids[0]??null});
      }catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;qualityByLot.set(lot.id,{available:0,blocks:[error.message],explanation:[error.message],controlId:null});}
    }
    const decision=qualityByLot.get(lot.id)!;
    lot.qualityAvailable=decision.available;lot.qualityBlocks=decision.blocks;lot.qualityExplanation=decision.explanation;lot.qualityControlId=decision.controlId;
  }
  const documents=(await tx.query(`SELECT DISTINCT rl.lot_id::text,d.id::text,COALESCE(d.label,d.original_name) AS label,d.reception_id::text AS "receptionId",d.sha256
    FROM public.reception_fournisseur_documents d JOIN public.reception_fournisseur_lignes rl ON rl.reception_id=d.reception_id AND(d.reception_line_id IS NULL OR d.reception_line_id=rl.id)
    WHERE rl.lot_id=ANY($1::uuid[]) AND d.removed_at IS NULL AND d.document_type='CERTIFICAT_MATIERE' ORDER BY 2`,[lots.map(l=>l.id)])).rows;
  for(const lot of lots){
    lot.documents=documents.filter(d=>d.lot_id===lot.id);
    lot.propertiesHash=materialPropertiesFingerprint({articleId:lot.articleId,unit:lot.unit,ownerClientId:lot.ownerClientId,properties:lot.properties});
    const evidence=lot.properties.certificate_evidence;
    lot.certificates=Array.isArray(evidence)?evidence.filter(e=>lot.documents.some(d=>d.id===e.documentId)).map(e=>e.label):[];
  }
  const checks=(await tx.query(`SELECT need_id::text,lot_id::text,requirements_hash,lot_properties_hash,manual_checks_confirmed FROM public.of_material_lot_checks WHERE need_id=ANY($1::uuid[])`,[saved.map(n=>n.id)])).rows;
  const catalogs=(await tx.query(`SELECT id::text,article_id::text,fournisseur_id::text,unite,unite_stock,coef_conversion::float8,prix_unitaire::float8,devise,moq::float8,lot_achat::float8,updated_at::text
    FROM public.fournisseur_catalogue WHERE article_id=ANY($1::uuid[]) AND actif AND(valid_from IS NULL OR valid_from<=current_date) AND(valid_to IS NULL OR valid_to>=current_date) ORDER BY updated_at DESC,id`,[articleIds])).rows;
  const usedLegacy=new Set<string>();
  const needs=purchases.map(p=>{
    const row=saved.find(n=>n.source_ref===p.id&&n.technical_version_id===of.revision&&!n.superseded_at);
    const article=articles.find(a=>a.id===p.article_id),requirements=row?.requirements??emptyRequirements();
    const operation=dossier.operations.find(op=>op.id===row?.operation_id)??null;
    const attached=reservations.filter(r=>r.material_need_id===row?.id||!r.material_need_id&&r.article_id===p.article_id&&!usedLegacy.has(r.id));
    attached.filter(r=>!r.material_need_id).forEach(r=>usedLegacy.add(r.id));
    const expected=promises.filter(b=>b.material_need_id===row?.id||!b.material_need_id&&b.besoin_ref===p.id);
    let required=Number(p.quantite)*dossier.quantity;
    if(row?.debit_rule)required=debitQuantity(row.debit_rule,dossier.quantity);
    const physical=attached.filter(r=>r.status==="ACTIVE"&&r.unexpired).reduce((sum,r)=>sum+Math.max(0,r.qty_reserved-r.qty_consumed),0);
    const consumed=attached.reduce((sum,r)=>sum+(r.status==="CONSUMED"?r.qty_reserved:r.qty_consumed),0);
    const need:MaterialNeed={key:p.id,articleId:p.article_id,unit:row?.unit??p.unite_prix??article?.unite??null,required,requirements,
      reserved:physical,consumed,expected:expected.reduce((sum,b)=>sum+Math.max(0,b.assigned-b.received),0),receivedBlocked:expected.reduce((sum,b)=>sum+Math.max(0,b.received-b.transferred),0)};
    const blockers:string[]=[];
    if(!of.hash)blockers.push("Valider et figer la définition technique de cet OF.");
    if(!row?.specification_reviewed_at)blockers.push("Confirmer les exigences et l’opération consommatrice.");
    if(!operation)blockers.push("Choisir l’opération qui consomme la matière.");
    if(!need.articleId)blockers.push("Renseigner l’article matière dans la définition technique.");
    if(!need.unit||need.unit.toUpperCase()!==article?.unite?.toUpperCase())blockers.push("Compléter l’unité de stock et la règle de conversion.");
    if(expected.some(p=>p.unite?.trim().toUpperCase()!==need.unit?.trim().toUpperCase()))blockers.push("Vérifier la conversion des approvisionnements déjà affectés à ce besoin.");
    const supplierId=row?.supplier_id??p.fournisseur_id;
    const catalog=catalogs.find(c=>c.article_id===p.article_id&&c.fournisseur_id===supplierId&&c.unite===need.unit&&(!c.coef_conversion||c.coef_conversion===1));
    const price=catalog?.prix_unitaire??(p.unite_prix===need.unit?p.pu_achat:null)??null;
    return {...need,id:row?.id??null,designation:p.designation??p.nom??article?.code??"Matière à définir",articleCode:article?.code??null,articleUnit:article?.unite??null,
      operationId:operation?.id??null,operationLabel:operation?.label??null,supplyMode:row?.supply_mode??"PURCHASE",allowPartial:row?.allow_partial??false,
      debitRule:row?.debit_rule??null,reviewed:!!row?.specification_reviewed_at,supplierId,destinationId:row?.destination_id??null,
      catalog,price,currency:catalog?.devise??"EUR",blockers,reservations:attached,promises:expected,
      rowVersion:row?.row_version??null};
  });
  // Per-need checks are never generalized to another reference or revision.
  const remaining=new Map(lots.map(l=>[l.batchId,l.available]));
  const remainingQuality=new Map(lots.map(l=>[l.id,l.qualityAvailable??0]));
  const remainingLevels=new Map(lots.filter(l=>l.stockLevelId).map(l=>[l.stockLevelId!,l.levelAvailable!]));
  const coverage=needs.map(need=>{
    const candidates=lots.map(l=>({...l,available:remaining.get(l.batchId)??0,qualityAvailable:remainingQuality.get(l.id)??0,levelAvailable:l.stockLevelId?remainingLevels.get(l.stockLevelId):undefined,manualVerified:checks.some(c=>c.need_id===need.id&&c.lot_id===l.id&&c.requirements_hash===coverageFingerprint(need.requirements)&&c.lot_properties_hash===l.propertiesHash&&c.manual_checks_confirmed)}));
    const proposal=proposeMaterialCoverage([need],candidates)[0];
    for(const s of proposal.selections){remainingQuality.set(s.lotId,quantity((remainingQuality.get(s.lotId)??0)-s.quantity));remaining.set(s.batchId,quantity((remaining.get(s.batchId)??0)-s.quantity));const levelId=lots.find(l=>l.batchId===s.batchId)?.stockLevelId;if(levelId)remainingLevels.set(levelId,quantity((remainingLevels.get(levelId)??0)-s.quantity));}
    return {...need,...proposal,purchase:purchaseQuantity(proposal.purchaseMissing,need.catalog?.moq??null,need.catalog?.lot_achat??null)};
  });
  return {enabled:true as const,ofId,number:dossier.number,quantity:dossier.quantity,dossierStatus:dossier.status,technicalVersion:of.revision as string|null,
    technicalHash:of.hash as string|null,clientId:of.client_id as string|null,operations:dossier.operations,
    version:coverageFingerprint({dossier:dossier.version,saved,reservations,promises,lots,checks,catalogs,documents}),needs:coverage,
    previousNeeds:saved.filter(n=>n.technical_version_id!==of.revision||n.superseded_at),
    suppliers:(await tx.query("SELECT id::text,COALESCE(nom,raison_sociale) AS name FROM public.fournisseurs WHERE actif IS NOT FALSE ORDER BY COALESCE(nom,raison_sociale)")).rows,
    destinations:(await tx.query("SELECT id::text,COALESCE(code,code_magasin) AS name FROM public.magasins ORDER BY COALESCE(code,code_magasin)")).rows};
}
export async function getOfMaterial(ofId:number){
  const tx=await pool.connect();
  try{await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const result=await materialWorkflowEnabled(tx)?await readMaterialTx(tx,ofId):{enabled:false as const};await tx.query("COMMIT");return result;}
  catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}
export async function materialCommand<T>(ofId:number,type:string,body:{expectedVersion:string;idempotencyKey:string;sourceRef?:string},audit:AuditContext,action:(tx:PoolClient,current:Awaited<ReturnType<typeof readMaterialTx>>)=>Promise<T>){
  return withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
    await tx.query("SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE",[ofId]);
    if(!await materialWorkflowEnabled(tx))throw new HttpError(409,"MATERIAL_WORKFLOW_DISABLED","Le parcours matière n’est pas activé.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[body.idempotencyKey]);
    const hash=coverageFingerprint({ofId,type,body});
    const replay=(await tx.query("SELECT * FROM public.of_material_commands WHERE idempotency_key=$1::uuid",[body.idempotencyKey])).rows[0];
    if(replay){if(replay.payload_hash!==hash||replay.actor_id!==audit.user_id)throw new HttpError(409,"IDEMPOTENCY_KEY_REUSED","Cette action a déjà été utilisée avec un autre contenu.");return replay.response as T;}
    const current=await readMaterialTx(tx,ofId);
    if(current.version!==body.expectedVersion)throw new HttpError(409,"MATERIAL_COVERAGE_CHANGED","Le stock, le dossier ou un achat a changé. Actualisez la proposition avant de confirmer.");
    const response=await action(tx,current);
    await preparationAudit(tx,audit,ofId,`production.of.material.${type.toLowerCase()}`,{request:body});
    await tx.query("INSERT INTO public.of_material_commands(idempotency_key,actor_id,of_id,command_type,payload_hash,response) VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb)",[body.idempotencyKey,audit.user_id,ofId,type,hash,JSON.stringify(response)]);
    return response;
  });
}

export async function configureOfMaterial(ofId:number,sourceRef:string,body:{expectedVersion:string;idempotencyKey:string;configuration:NeedConfiguration},audit:AuditContext){
  return materialCommand(ofId,"CONFIGURE",{...body,sourceRef},audit,async(tx,current)=>{
    const need=current.needs.find(n=>n.key===sourceRef),c=body.configuration;
    if(!need||!current.technicalVersion||!current.technicalHash)throw new HttpError(409,"MATERIAL_DEFINITION_REQUIRED","La matière doit être définie dans la version technique figée.");
    if(!current.operations.some(o=>o.id===c.operationId))throw new HttpError(422,"MATERIAL_OPERATION_INVALID","Choisissez une opération de cet OF.");
    if(c.supplyMode==="CUSTOMER"&&(!current.clientId||c.requirements.ownerClientId!==current.clientId))throw new HttpError(422,"MATERIAL_OWNER_REQUIRED","La matière fournie par le client doit conserver ce client propriétaire.");
    if(c.supplyMode==="PURCHASE"&&c.requirements.ownerClientId)throw new HttpError(422,"MATERIAL_OWNER_INVALID","La matière achetée par CERP ne peut pas utiliser les lots appartenant à un client.");
    const article=(await tx.query("SELECT unite FROM public.articles WHERE id=$1::uuid",[need.articleId])).rows[0];
    if(!article||c.debitRule.stockUnit!==article.unite)throw new HttpError(422,"MATERIAL_STOCK_UNIT_REQUIRED","La conversion doit aboutir à l’unité de stock de l’article.");
    const total=debitQuantity(c.debitRule,(await readOfDossierTx(tx,ofId)).quantity);
    await tx.query(`INSERT INTO public.of_material_needs(of_id,source_ref,technical_version_id,technical_hash,operation_id,article_id,designation,required_qty,unit,supply_mode,requirements,specification_reviewed_at,specification_reviewed_by,debit_rule,allow_partial,supplier_id,destination_id,created_by,updated_by)
      VALUES($1,$2,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::jsonb,now(),$12,$13::jsonb,$14,$15::uuid,$16::uuid,$12,$12)
      ON CONFLICT(of_id,technical_version_id,source_ref) DO UPDATE SET operation_id=EXCLUDED.operation_id,required_qty=EXCLUDED.required_qty,unit=EXCLUDED.unit,supply_mode=EXCLUDED.supply_mode,requirements=EXCLUDED.requirements,specification_reviewed_at=now(),specification_reviewed_by=EXCLUDED.specification_reviewed_by,debit_rule=EXCLUDED.debit_rule,allow_partial=EXCLUDED.allow_partial,supplier_id=EXCLUDED.supplier_id,destination_id=EXCLUDED.destination_id,row_version=of_material_needs.row_version+1,updated_at=now(),updated_by=EXCLUDED.updated_by`,
      [ofId,sourceRef,current.technicalVersion,current.technicalHash,c.operationId,need.articleId,need.designation,total,c.debitRule.stockUnit,c.supplyMode,JSON.stringify(c.requirements),audit.user_id,JSON.stringify(c.debitRule),c.allowPartial,c.supplierId,c.destinationId]);
    await tx.query("UPDATE public.of_dossier_validations SET invalidated_at=now(),invalidation_reason='La préparation matière ou les règles de débit ont changé.' WHERE of_id=$1 AND invalidated_at IS NULL",[ofId]);
    return readMaterialTx(tx,ofId);
  });
}

export async function confirmOfMaterial(ofId:number,body:{expectedVersion:string;idempotencyKey:string;selections:Array<{needKey:string;batchId:string;quantity:number}>},audit:AuditContext,canPurchase:boolean){
  return materialCommand(ofId,"CONFIRM",body,audit,async(tx,current)=>{
    if(current.needs.some(n=>n.blockers.length))throw new HttpError(409,"MATERIAL_PREPARATION_REQUIRED","Complétez les besoins matière avant de confirmer la couverture.");
    if(current.previousNeeds.length)throw new HttpError(409,"MATERIAL_PREVIOUS_REVISION","Les affectations de l’ancienne version doivent être revues avant une nouvelle couverture.");
    if(new Set(body.selections.map(s=>`${s.needKey}:${s.batchId}`)).size!==body.selections.length)throw new HttpError(422,"MATERIAL_DUPLICATE_SELECTION","Le même lot est présent deux fois pour ce besoin.");
    // Stabilize quality and material properties before rechecking the preview.
    const batchIds=body.selections.map(s=>s.batchId);
    await tx.query("SELECT id FROM public.lots WHERE id IN (SELECT lot_id FROM public.stock_batches WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE",[batchIds]);
    const locked=await readMaterialTx(tx,ofId);
    if(locked.version!==current.version)throw new HttpError(409,"MATERIAL_COVERAGE_CHANGED","Un lot ou un approvisionnement a changé. Actualisez la proposition.");
    const drafts:MaterialDraftLine[]=[],reservedIds:string[]=[],pending:Array<{needKey:string;message:string}>=[];
    for(const need of current.needs){
      const selections=body.selections.filter(s=>s.needKey===need.key),total=quantity(selections.reduce((sum,s)=>sum+s.quantity,0));
      if(total>materialBalance(need).missing)throw new HttpError(409,"MATERIAL_OVER_COVERAGE","La sélection dépasse le manque restant.");
      for(const selection of selections){
        const candidate=need.candidates.find(c=>c.lot.batchId===selection.batchId);
        if(!candidate||lotCompatibility(need,candidate.lot).length||selection.quantity>candidate.available)throw new HttpError(409,"MATERIAL_LOT_CHANGED","Un lot sélectionné n’est plus compatible ou disponible.");
        const lot=candidate.lot as Candidate;
        const result=await repoCreateStockReservation({article_id:need.articleId!,magasin_id:lot.magasinId,emplacement_id:lot.emplacementId,lot_id:lot.id,qty:selection.quantity,source:{source_type:"OF",of_id:ofId},reason:`Matière ${current.number} · ${need.operationLabel}`},audit,`${body.idempotencyKey}:${need.key}:${lot.batchId}`,tx,need.id!);
        reservedIds.push(result.reservation.id);
      }
      const buy=purchaseQuantity(quantity(materialBalance(need).missing-total),need.catalog?.moq??null,need.catalog?.lot_achat??null);
      if(!buy.assigned)continue;
      if(need.supplyMode==="CUSTOMER"){pending.push({needKey:need.key,message:`Préparer l’appel de ${buy.assigned} ${need.unit} au client.`});continue;}
      if(!canPurchase){pending.push({needKey:need.key,message:"Faire préparer le brouillon par un utilisateur habilité aux achats."});continue;}
      if(!need.supplierId||need.price===null){pending.push({needKey:need.key,message:!need.supplierId?"Choisir le fournisseur pour préparer le brouillon.":"Renseigner le prix fournisseur ou consulter les fournisseurs."});continue;}
      drafts.push({needId:need.id!,sourceRef:need.key,ofId,articleId:need.articleId!,designation:need.designation,supplierId:need.supplierId,currency:need.currency,destinationId:need.destinationId,unit:need.unit!,quantity:buy.ordered,assigned:buy.assigned,price:need.price,due:current.operations.find(o=>o.id===need.operationId)?.start?.slice(0,10)??null,operation:need.operationLabel!,requirements:[need.requirements.grade,need.requirements.condition,...need.requirements.certificates,...need.requirements.manualChecks].filter((x):x is string=>!!x)});
    }
    if(body.selections.some(s=>!current.needs.some(n=>n.key===s.needKey)))throw new HttpError(422,"MATERIAL_NEED_NOT_FOUND","Le besoin sélectionné n’existe plus.");
    const commands=await createMaterialDraftsTx(tx,drafts,audit);
    return {coverage:await readMaterialTx(tx,ofId),commands,reservedIds,pending};
  });
}

export async function verifyOfMaterialLot(ofId:number,sourceRef:string,body:MaterialLotVerification,audit:AuditContext){
  return materialCommand(ofId,"VERIFY_LOT",{...body,sourceRef},audit,async(tx,current)=>{
    const need=current.needs.find(n=>n.key===sourceRef);
    const candidate=need?.candidates.find(c=>c.lot.batchId===body.batchId);
    if(!need?.id||!candidate)throw new HttpError(409,"MATERIAL_LOT_NOT_FOUND","Préparez le besoin et choisissez un lot de cet article.");
    const lot=candidate.lot as Candidate;
    await tx.query("SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE",[lot.id]);
    if((await readMaterialTx(tx,ofId)).version!==current.version)throw new HttpError(409,"MATERIAL_COVERAGE_CHANGED","Le lot ou la préparation a changé. Actualisez avant de vérifier.");
    if(body.certificates.some(c=>!lot.documents.some(d=>d.id===c.documentId)))throw new HttpError(422,"MATERIAL_CERTIFICATE_DOCUMENT_REQUIRED","Chaque certificat doit correspondre à un document matière actif de la réception de ce lot.");
    const properties={...lot.properties,grade:body.grade,condition:body.condition,dimensions:body.dimensions,certificate_evidence:body.certificates,certificates:body.certificates.map(c=>c.label)};
    await tx.query("UPDATE public.lots SET material_properties=$2::jsonb,updated_at=now(),updated_by=$3 WHERE id=$1::uuid",[lot.id,JSON.stringify(properties),audit.user_id]);
    const propertiesHash=materialPropertiesFingerprint({articleId:lot.articleId,unit:lot.unit,ownerClientId:lot.ownerClientId,properties});
    await tx.query(`INSERT INTO public.of_material_lot_checks(need_id,lot_id,requirements_hash,evidence,decided_by,lot_properties_hash,manual_checks_confirmed)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
      ON CONFLICT(need_id,lot_id,requirements_hash) DO UPDATE SET evidence=EXCLUDED.evidence,decided_by=EXCLUDED.decided_by,decided_at=now(),lot_properties_hash=EXCLUDED.lot_properties_hash,manual_checks_confirmed=EXCLUDED.manual_checks_confirmed`,
      [need.id,lot.id,coverageFingerprint(need.requirements),body.evidence,audit.user_id,propertiesHash,body.manualRequirementsChecked]);
    await preparationAudit(tx,audit,ofId,"production.of.material.lot_verified",{lotId:lot.id,needId:need.id,oldProperties:lot.properties,properties,evidence:body.evidence});
    return readMaterialTx(tx,ofId);
  });
}
