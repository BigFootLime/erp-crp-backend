import { Router, type RequestHandler } from "express";
import pool from "../../config/database";
import { HttpError } from "../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../access-control/context/account-module-access.context";
import { roleHasCommandeFournisseurCapability } from "../commande-fournisseur/domain/commande-fournisseur-rbac";
import { roleHasOfCapability } from "../production/domain/of-rbac";
import { repoListSubcontractWorkPackagesForOf } from "./subcontract.repository";

const router = Router();
const activeOrderStates = ["ENVOYEE", "ACCUSE_RECU", "PARTIELLEMENT_RECUE"];
const id = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
const unit = (v: unknown) => String(v ?? "").trim().toUpperCase();
const qty = (v: unknown) => Number(v);
const positiveOfId = (v: unknown) => typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
function required(ok: unknown, message: string): asserts ok { if (!ok) throw new HttpError(422, "SUBCONTRACT_INPUT_INVALID", message); }
const access = (write: boolean): RequestHandler => (req, _res, next) => {
  const allowed = requestHasGrantedAccountModuleAccess(req) || (roleHasCommandeFournisseurCapability(req.user?.role, write ? "create" : "read") && roleHasOfCapability(req.user?.role, write ? "operate" : "read"));
  if (allowed) return next();
  next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet pas cette action de sous-traitance."));
};
async function audit(c: any, user: number | undefined, action: string, packageId: string, details: unknown) {
  await c.query("INSERT INTO public.erp_audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,$2,'SUBCONTRACT_WORK_PACKAGE',$3,$4::jsonb)", [user ?? null, action, packageId, JSON.stringify(details)]);
}
async function lockPackage(c: any, packageId: string) {
  const r = await c.query(`SELECT p.*,l.type,l.statut_ligne,cf.statut order_status FROM public.subcontract_work_packages p JOIN public.commande_fournisseur_ligne l ON l.id=p.supplier_order_line_id JOIN public.commande_fournisseur cf ON cf.id=l.commande_id WHERE p.id=$1::uuid FOR UPDATE OF p,l`, [packageId]);
  const row = r.rows[0];
  if (!row || row.status !== "SENT" || row.type !== "SOUS_TRAITANCE" || row.statut_ligne !== "ACTIVE" || !activeOrderStates.includes(row.order_status)) throw new HttpError(409, "SUBCONTRACT_PACKAGE_NOT_ELIGIBLE", "Dossier sous-traitance non éligible.");
  return row;
}

// Strictly OF-scoped board projection.  No unfiltered route exists: a caller
// must name one canonical OF, and the same procurement + production guard
// protects it as the mutable custody actions.
router.get("/", access(false), async (req, res, next) => { try {
  const ofId = positiveOfId(req.query.of_id);
  if (ofId === null) throw new HttpError(422, "SUBCONTRACT_OF_FILTER_REQUIRED", "Le filtre of_id entier positif est obligatoire.");
  const workPackages = await repoListSubcontractWorkPackagesForOf(ofId);
  res.json({ of_id: ofId, work_packages: workPackages });
} catch (e) { next(e); } });

router.get("/:id", access(false), async (req, res, next) => { try {
  const packageId = id(req.params.id); required(packageId, "Identifiant dossier invalide.");
  const r = await pool.query(`SELECT p.*,COALESCE(json_agg(json_build_object('id',e.id,'event_type',e.event_type,'lot_id',e.lot_id,'qty',e.qty,'unit',e.unit,'created_at',e.created_at) ORDER BY e.created_at) FILTER (WHERE e.id IS NOT NULL),'[]'::json) ledger FROM public.subcontract_work_packages p LEFT JOIN public.subcontract_work_package_ledger e ON e.package_id=p.id WHERE p.id=$1::uuid GROUP BY p.id`, [packageId]);
  if (!r.rows[0]) throw new HttpError(404, "SUBCONTRACT_PACKAGE_NOT_FOUND", "Dossier sous-traitance introuvable."); res.json(r.rows[0]);
} catch (e) { next(e); } });

router.post("/", access(true), async (req: any, res, next) => { try {
  const line = id(req.body?.supplier_order_line_id), operation = id(req.body?.of_operation_id), evidence = id(req.body?.ged_evidence_document_id), packageUnit = unit(req.body?.unit), planned = qty(req.body?.qty_planned);
  required(line && operation && evidence && packageUnit && Number.isFinite(planned) && planned > 0, "Ligne PO, opération OF, unité, quantité et preuve GED sont obligatoires.");
  const c = await pool.connect(); try { await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1)),pg_advisory_xact_lock(hashtext($2))", [line, operation]);
    const r = await c.query<any>(`INSERT INTO public.subcontract_work_packages(supplier_order_line_id,of_operation_id,status,unit,qty_planned,ged_evidence_document_id,created_by)
      SELECT l.id,o.id,'SENT',$3,$4,d.id,$6 FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur cf ON cf.id=l.commande_id JOIN public.of_operations o ON o.id=$2::uuid AND o.of_id=l.of_id JOIN public.pieces_techniques_operations source ON source.id=o.source_piece_operation_id AND source.type_operation='SOUS_TRAITANCE' JOIN public.ged_documents d ON d.id=$5::uuid AND d.archived_at IS NULL WHERE l.id=$1::uuid AND l.type='SOUS_TRAITANCE' AND l.statut_ligne='ACTIVE' AND cf.statut=ANY($7::text[]) RETURNING *`, [line, operation, packageUnit, planned, evidence, req.user?.id ?? null, activeOrderStates]);
    if (!r.rows[0]) throw new HttpError(409, "SUBCONTRACT_PACKAGE_PREREQUISITES", "La ligne sous-traitance active, l'opération OF canonique et la preuve GED active doivent correspondre.");
    await c.query("INSERT INTO public.ged_document_links(document_id,entity_type,entity_id,link_role,created_by) VALUES($1,'SUBCONTRACT_WORK_PACKAGE',$2,'EVIDENCE',$3) ON CONFLICT DO NOTHING", [evidence,r.rows[0].id,req.user?.id ?? null]);
    await audit(c,req.user?.id,"CREATE",r.rows[0].id,{line,operation,evidence,unit:packageUnit,qty_planned:planned}); await c.query("COMMIT"); res.status(201).json(r.rows[0]);
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
} catch (e) { next(e); } });

async function ledger(eventType: "ISSUE" | "RETURN", req: any, res: any, next: any) { try {
  const packageId=id(req.params.id), lot=id(req.body?.lot_id), eventUnit=unit(req.body?.unit), amount=qty(req.body?.qty), key=String(req.header("Idempotency-Key") ?? "").trim();
  required(packageId&&lot&&eventUnit&&Number.isFinite(amount)&&amount>0&&key.length>=8&&key.length<=128,"Lot, quantité, unité et Idempotency-Key (8–128 caractères) sont obligatoires.");
  const c=await pool.connect(); try { await c.query("BEGIN");
    const replay=await c.query<any>("SELECT id,package_id,event_type,lot_id,qty,unit FROM public.subcontract_work_package_ledger WHERE idempotency_key=$1 FOR KEY SHARE",[key]);
    if(replay.rows[0]) { const x=replay.rows[0]; if(x.package_id!==packageId||x.event_type!==eventType||x.lot_id!==lot||Number(x.qty)!==amount||unit(x.unit)!==eventUnit) throw new HttpError(409,"SUBCONTRACT_IDEMPOTENCY_KEY_REUSED","Cette clé correspond à une autre opération matière."); await c.query("COMMIT"); return res.json({package_id:packageId,ledger_event_id:x.id,idempotent_replay:true}); }
    const p=await lockPackage(c,packageId!); if(unit(p.unit)!==eventUnit) throw new HttpError(409,"SUBCONTRACT_UNIT_MISMATCH","Conversion implicite interdite.");
    const lots=await c.query<any>("SELECT lot_status FROM public.lots WHERE id=$1::uuid FOR KEY SHARE",[lot]); const expected=eventType==="ISSUE"?"LIBERE":"QUARANTAINE";
    if(lots.rows[0]?.lot_status!==expected) throw new HttpError(409,eventType==="ISSUE"?"SUBCONTRACT_QUALITY_BLOCK":"SUBCONTRACT_RETURN_NOT_QUARANTINED",eventType==="ISSUE"?"Le lot expédié doit être LIBERE.":"Le retour doit être en QUARANTAINE avant décision Qualité.");
    if(eventType==="RETURN") { const b=await c.query<any>("SELECT COALESCE(sum(qty) FILTER(WHERE event_type='ISSUE'),0)-COALESCE(sum(qty) FILTER(WHERE event_type='RETURN'),0) qty FROM public.subcontract_work_package_ledger WHERE package_id=$1::uuid",[packageId]); if(Number(b.rows[0].qty)+1e-9<amount) throw new HttpError(409,"SUBCONTRACT_OVER_RETURN","Retour supérieur au solde expédié."); }
    const inserted=await c.query<any>("INSERT INTO public.subcontract_work_package_ledger(package_id,event_type,lot_id,qty,unit,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[packageId,eventType,lot,amount,eventUnit,key,req.user?.id??null]); await audit(c,req.user?.id,eventType,packageId!,{lot,qty:amount,unit:eventUnit,idempotency_key:key}); await c.query("COMMIT"); res.status(201).json({package_id:packageId,ledger_event_id:inserted.rows[0].id,idempotent_replay:false});
  } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
} catch(e) { next(e); } }
router.post("/:id/issues",access(true),(req,res,next)=>ledger("ISSUE",req,res,next));
router.post("/:id/returns",access(true),(req,res,next)=>ledger("RETURN",req,res,next));
async function finalise(status:"CLOSED"|"CANCELLED",req:any,res:any,next:any){try{const packageId=id(req.params.id),expected=qty(req.body?.expected_row_version),reason=String(req.body?.reason??"").trim();required(packageId&&Number.isInteger(expected)&&expected>0&&reason,"expected_row_version et motif sont obligatoires.");const c=await pool.connect();try{await c.query("BEGIN");const p=await lockPackage(c,packageId!);if(Number(p.row_version)!==expected)throw new HttpError(409,"SUBCONTRACT_CONCURRENT_OR_FINAL","Dossier modifié ou déjà finalisé.");const b=await c.query<any>("SELECT COALESCE(sum(qty) FILTER(WHERE event_type='ISSUE'),0)-COALESCE(sum(qty) FILTER(WHERE event_type='RETURN'),0) qty FROM public.subcontract_work_package_ledger WHERE package_id=$1::uuid",[packageId]);if(Number(b.rows[0].qty)!==0)throw new HttpError(409,"SUBCONTRACT_CUSTODY_OPEN","Finalisation refusée : matière toujours chez le sous-traitant.");const r=await c.query<any>("UPDATE public.subcontract_work_packages SET status=$2,row_version=row_version+1,closed_at=now(),closed_by=$3,close_reason=$4 WHERE id=$1::uuid AND status='SENT' AND row_version=$5 RETURNING *",[packageId,status,req.user?.id??null,reason,expected]);if(!r.rows[0])throw new HttpError(409,"SUBCONTRACT_CONCURRENT_OR_FINAL","Dossier modifié ou déjà finalisé.");await audit(c,req.user?.id,status,packageId!,{reason});await c.query("COMMIT");res.json(r.rows[0]);}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}}catch(e){next(e)}}
router.post("/:id/close",access(true),(req,res,next)=>finalise("CLOSED",req,res,next));
router.post("/:id/cancel",access(true),(req,res,next)=>finalise("CANCELLED",req,res,next));
export default router;
