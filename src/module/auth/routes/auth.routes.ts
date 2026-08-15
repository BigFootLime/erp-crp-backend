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
  mfaRateLimit,
  resetPasswordRateLimit,
} from '../middlewares/auth-rate-limit.middleware';
import {
  recoveryCodes,
  revoke,
  startReplacement,
  status,
  stepUp,
  verifyChallenge,
} from '../controllers/mfa.controller';

const router: Router = Router();

router.post('/login', loginRateLimit, login);
router.post('/mfa/verify', mfaRateLimit, verifyChallenge);
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
router.get('/mfa/status', authenticateToken, status);
router.post('/mfa/step-up', authenticateToken, mfaRateLimit, stepUp);
router.post('/mfa/replacement', authenticateToken, mfaRateLimit, startReplacement);
router.post('/mfa/recovery-codes', authenticateToken, mfaRateLimit, recoveryCodes);
router.post('/mfa/revoke', authenticateToken, mfaRateLimit, revoke);


export default router;
