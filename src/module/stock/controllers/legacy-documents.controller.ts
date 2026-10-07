import { asyncHandler } from '../../../utils/asyncHandler';
import { roleHasStockCapability } from '../domain/stock-rbac';
import { requestHasGrantedAccountModuleAccess } from '../../access-control/context/account-module-access.context';
import { readLegacyDocuments, appendLegacyDocument } from '../services/legacy-documents.service';
import { legacyDocumentIdentity, legacyDocumentCommand } from '../validators/legacy-documents.validators';
export const getLegacyDocuments = asyncHandler(async (req, res) => res.json({ ...await readLegacyDocuments(legacyDocumentIdentity.parse(req.params).id), canAdd: requestHasGrantedAccountModuleAccess(req) || roleHasStockCapability(req.user?.role, 'documents_manage') }));
export const postLegacyDocument = asyncHandler(async (req, res) => res.status(201).json(await appendLegacyDocument(legacyDocumentIdentity.parse(req.params).id, legacyDocumentCommand.parse(req.body), req.user!.id)));
