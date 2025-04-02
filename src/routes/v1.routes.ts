import { Router } from 'express';
import authRoutes from '../module/auth/routes/auth.routes';
// import gestionOutilsRoutes from '../modules/gestion-outils/routes/...'; // à venir

const router = Router();

// 📦 Routes versionnées par module
router.use('/auth', authRoutes);
// router.use('/gestion-outils', gestionOutilsRoutes); // à activer plus tard

export default router;
