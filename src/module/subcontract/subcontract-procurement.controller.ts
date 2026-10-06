import { asyncHandler } from '../../utils/asyncHandler';
import { HttpError } from '../../utils/httpError';
import { buildAuditContext } from '../production/controllers/production.controller';
import { consumableRights } from '../production/controllers/consumable-procurement.controller';
import { readSubcontractProcurement, prepareSubcontractProcurement } from './subcontract-procurement.service';
import { subcontractProcurementIdentity, subcontractProcurementCommand } from './subcontract-procurement.validators';
export const getProcurement = asyncHandler(async (req, res) => {
    const data = await readSubcontractProcurement(subcontractProcurementIdentity.parse(req.params).ofId), rights = await consumableRights(req);
    res.json({ ...data, canPrepare: rights.purchase, pricesVisible: rights.prices, offers: data.offers.map(o => ({ ...o, price: rights.prices ? o.price : null, forfait: rights.prices ? o.forfait : null, minimumInvoice: rights.prices ? o.minimumInvoice : null })) });
});
export const postProcurement = asyncHandler(async (req, res) => {
    if (!(await consumableRights(req)).purchase)
        throw new HttpError(403, 'SUBCONTRACT_PURCHASE_FORBIDDEN', 'Les droits de préparation des achats sont nécessaires.');
    const result = await prepareSubcontractProcurement(subcontractProcurementIdentity.parse(req.params).ofId, subcontractProcurementCommand.parse(req.body), buildAuditContext(req));
    // Return identifiers only; the read route applies price visibility independently.
    res.status(201).json({ commands: result.commands });
});
