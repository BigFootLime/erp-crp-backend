import { Router,type RequestHandler } from 'express';
import { z } from 'zod';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { asyncHandler } from '../../../utils/asyncHandler';
import { createSecureUpload } from '../../../shared/uploads/secure-upload';
import { requireModule } from '../services/terminal-auth.service';
import { parseIdentificationPayload } from '../../identification/domain/identification';
import { repoFindLabelByPublicId } from '../../identification/identification.repository';
import { resolveTerminalIdentification } from '../services/terminal-scan.service';
import * as receipts from '../../receptions/controllers/grouped-receipts.controller';
import { getReception,attachReceptionDocuments } from '../../receptions/controllers/receptions.controller';
import * as procurement from '../../production/controllers/consumable-procurement.controller';
import * as supply from '../../stock/controllers/consumable-supply.controller';
import { listStockMagasins,listStockEmplacements,listStockArticleCategories } from '../../stock/controllers/stock.controller';

const router=Router();
const kind=(...kinds:string[]):RequestHandler=>(req,_res,next)=>{
  if(!req.terminal||!kinds.includes(req.terminal.kind))return next(new HttpError(403,'TERMINAL_KIND_FORBIDDEN','Cette fonction appartient à une autre application.'));
  next();
};
const moduleAccess=(module:string):RequestHandler=>(req,_res,next)=>{void requireModule(req.user!.id,module).then(()=>next()).catch(next);};

// Explicit routes only. Neither a device credential nor a terminal session is
// an ERP JWT, and the operator terminal cannot invoke logistics commands.
router.use('/reception',kind('RECEPTION'),moduleAccess('qualite'));
router.get('/reception/expected-lines',receipts.expectedReceiptLines);
router.get('/reception/drafts',asyncHandler(async(req,res)=>{
  const items=(await pool.query(`SELECT r.id,r.reception_no AS number,r.fournisseur_id AS "supplierId",r.supplier_reference AS reference,r.reception_date::text AS date,
    COALESCE(f.nom,f.raison_sociale) AS "supplierName"
    FROM public.receptions_fournisseurs r JOIN public.fournisseurs f ON f.id=r.fournisseur_id
    WHERE r.confirmation_state='DRAFT' AND r.created_by=$1 ORDER BY r.created_at DESC LIMIT 50`,[req.user!.id])).rows;
  res.json({items});
}));
router.get('/reception/scan',asyncHandler(async(req,res)=>{
  const scan=z.string().trim().min(1).max(200).parse(req.query.scan);
  if(!/^CERP:/i.test(scan)){res.json({q:scan});return;}
  const label=await repoFindLabelByPublicId(parseIdentificationPayload(scan));
  if(!label||label.status!=='ACTIVE')throw new HttpError(404,'RECEIPT_SCAN_UNKNOWN','Étiquette inconnue, remplacée ou invalidée.');
  if(label.entity_type==='PURCHASE_ORDER'){res.json({orderId:z.string().uuid().parse(label.entity_id)});return;}
  if(label.entity_type==='WORK_ORDER'){res.json({ofId:z.coerce.number().int().positive().parse(label.entity_id)});return;}
  if(label.entity_type==='STOCK_ARTICLE'){
    const row=(await pool.query('SELECT code FROM public.articles WHERE id=$1::uuid',[label.entity_id])).rows[0];
    if(row){res.json({q:row.code});return;}
  }
  throw new HttpError(422,'RECEIPT_SCAN_WRONG_TYPE','Scannez une commande, un OF ou un article.');
}));
router.post('/reception/grouped',receipts.stageGroupedReceipt);
router.get('/reception/:id',getReception);
router.post('/reception/:id/confirm',receipts.validateGroupedReceipt);
router.post('/reception/:id/documents',createSecureUpload('quality-document').array('documents[]'),attachReceptionDocuments);

router.use('/procurement',kind('OF_PROCUREMENT'),moduleAccess('production'));
router.get('/procurement/ofs',asyncHandler(async(req,res)=>{
  const query=z.string().trim().max(200).default('').parse(req.query.q);
  let id:number|null=null;
  if(/^CERP:/i.test(query))id=await resolveTerminalIdentification(parseIdentificationPayload(query));
  const items=(await pool.query(`SELECT o.id,o.numero,o.statut,p.code_piece,p.designation
    FROM public.ordres_fabrication o LEFT JOIN public.pieces_techniques p ON p.id=o.piece_technique_id
    WHERE ($1::bigint IS NOT NULL AND o.id=$1) OR ($1 IS NULL AND concat_ws(' ',o.numero,p.code_piece,p.designation) ILIKE $2)
    ORDER BY o.updated_at DESC,o.id DESC LIMIT 50`,[id,`%${query}%`])).rows;
  res.json({items});
}));
router.get('/procurement/ofs/:id',procurement.readConsumables);
router.post('/procurement/ofs/:id/configure',procurement.configureConsumable);
router.post('/procurement/ofs/:id/prepare',procurement.prepareConsumables);
router.post('/procurement/ofs/:id/withdraw',procurement.withdrawConsumable);
router.post('/procurement/ofs/:id/reconcile',procurement.reconcileConsumables);
router.get('/procurement/consumables/resolve',moduleAccess('stock'),supply.findScannedConsumable);
router.get('/procurement/consumables/:id/supply',moduleAccess('stock'),supply.readConsumableSupply);
router.post('/procurement/consumables/:id/replenish',moduleAccess('stock'),supply.prepareConsumableSupply);
router.post('/procurement/consumables/:id/finish-pack',moduleAccess('stock'),supply.finishConsumablePack);

router.use('/logistics',kind('RECEPTION','OF_PROCUREMENT'),moduleAccess('stock'));
router.get('/logistics/article-categories',listStockArticleCategories);
router.get('/logistics/magasins',listStockMagasins);
router.get('/logistics/emplacements',listStockEmplacements);
export default router;
