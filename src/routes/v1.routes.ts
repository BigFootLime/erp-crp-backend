import { Router } from 'express';
import authRoutes from '../module/auth/routes/auth.routes';

const router = Router();
// 📦 Routes versionnées par module

router.use('/auth', authRoutes);


export default router;
