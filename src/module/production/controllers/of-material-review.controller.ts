import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { ofIdParamSchema } from '../validators/production.validators';
import { buildAuditContext } from './production.controller';
import { consumableRights } from './consumable-procurement.controller';
import {
  readPlanningProcurement,
  savePlanningProcurement,
  savePlanningProcurementSchema,
} from '../../planning/repository/planning-procurement.repository';

// Reviewing material to finish an OF belongs to Production. It must not grant
// access to planning or create supplier orders through the review command.
const reviewSchema = savePlanningProcurementSchema.refine(body =>
  body.scope === 'material' && body.deferMaterialPurchase === true && body.operationId === undefined
    && body.entries.every(entry => entry.key.startsWith('MATIERE:')),
  'La revue est limitée à la matière, sans création de commande ni opération de traitement.');

export const readOfMaterialReview = asyncHandler(async (req, res) => {
  const id = ofIdParamSchema.parse({ params: req.params }).params.id;
  const rights = await consumableRights(req);
  const data = await readPlanningProcurement(id, rights.prices);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...data, entries: data.entries.filter(entry => entry.kind === 'MATIERE'), canSave: rights.purchase, canPurchase: rights.purchase });
});

export const saveOfMaterialReview = asyncHandler(async (req, res) => {
  const id = ofIdParamSchema.parse({ params: req.params }).params.id;
  const rights = await consumableRights(req);
  if (!rights.purchase) throw new HttpError(403, 'MATERIAL_PURCHASE_PREPARATION_FORBIDDEN', 'Les droits de préparation des achats sont nécessaires pour modifier les choix fournisseur.');
  const body = reviewSchema.parse(req.body);
  const data = await savePlanningProcurement(id, body, buildAuditContext(req), rights.purchase);
  res.json({ ...data, entries: data.entries.filter(entry => entry.kind === 'MATIERE'), canSave: rights.purchase, canPurchase: rights.purchase });
});
