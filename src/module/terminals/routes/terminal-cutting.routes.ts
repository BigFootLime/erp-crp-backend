import { Router } from 'express';
import { HttpError } from '../../../utils/httpError';
import * as cutting from '../controllers/terminal-cutting.controller';
import { downloadDocument } from '../controllers/terminals.controller';
import { clientLogoMetadata, clientLogoContent } from '../controllers/terminal-client-logo.controller';
const router = Router();
router.use('/cutting', (req, _res, next) => {
    if (req.terminal?.kind !== 'CUTTING' || req.terminal.machine_id !== null)
        return next(new HttpError(403, 'TERMINAL_KIND_FORBIDDEN', 'Cette fonction appartient au poste de découpe.'));
    next();
});
router.get('/cutting/worklist', cutting.worklist);
router.post('/cutting/resolve-of', cutting.resolveOf);
router.get('/cutting/ofs/:of_id/operations/:operation_id', cutting.dossier);
router.get('/cutting/ofs/:of_id/operations/:operation_id/documents/:id', downloadDocument);
router.get('/cutting/ofs/:of_id/operations/:operation_id/client-logo', clientLogoMetadata);
router.get('/cutting/ofs/:of_id/operations/:operation_id/client-logo/content', clientLogoContent);
router.post('/cutting/ofs/:of_id/operations/:operation_id/scan', cutting.scanBar);
router.post('/cutting/ofs/:of_id/operations/:operation_id/debits', cutting.debit);
router.post('/cutting/ofs/:of_id/operations/:operation_id/execution', cutting.execute);
export default router;
