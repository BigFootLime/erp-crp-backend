import { Router } from 'express';
import authRoutes from '../module/auth/routes/auth.routes';
import outilRoutes from '../module/outils/routes/outil.routes';

const router = Router();
// 📦 Routes versionnées par module

router.use('/auth', authRoutes);
router.use('/outil', outilRoutes);


export default router;
