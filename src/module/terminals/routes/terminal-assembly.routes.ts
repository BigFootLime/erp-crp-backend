import { Router } from 'express';
import * as assembly from '../controllers/terminal-assembly.controller';
const router = Router();
router.get('/operator/ofs/:of_id/operations/:operation_id/assembly-components', assembly.preparation);
router.post('/operator/ofs/:of_id/operations/:operation_id/assembly-components/withdraw', assembly.withdraw);
router.get('/operator/ofs/:of_id/operations/:operation_id/assembly-components/withdrawals', assembly.history);
router.get('/operator/ofs/:of_id/operations/:operation_id/assembly-components/withdrawals/:withdrawal_id/return', assembly.previewReturn);
router.post('/operator/ofs/:of_id/operations/:operation_id/assembly-components/withdrawals/:withdrawal_id/return', assembly.restore);
export default router;
