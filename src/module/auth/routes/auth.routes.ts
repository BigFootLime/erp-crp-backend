import { Router } from 'express';
import { activateAccount, login, forgotPassword, resetPassword } from '../controllers/auth.controller';
import {
    authenticateToken,
  } from '../middlewares/auth.middleware';
import { getProfile } from '../controllers/user.controller';
import { getAccessProfile } from '../../access-control/controllers/access-control.controller';
import {
  forgotPasswordRateLimit,
  loginRateLimit,
  resetPasswordRateLimit,
} from '../middlewares/auth-rate-limit.middleware';

const router: Router = Router();

router.post('/login', loginRateLimit, login);
router.post('/forgot-password', forgotPasswordRateLimit, forgotPassword);
router.post('/reset-password', resetPasswordRateLimit, resetPassword);
router.post('/activate', resetPasswordRateLimit, activateAccount);
router.get(
  '/me',
  authenticateToken,
  getProfile
);

// Profil d'accès module (#326) — volontairement SANS authorizeRole : chaque compte,
// opérateur compris, doit pouvoir charger la navigation à laquelle il a droit.
router.get('/access-profile', authenticateToken, getAccessProfile);


export default router;
