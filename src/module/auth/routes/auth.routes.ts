import { Router } from 'express';
import { activateAccount, login, forgotPassword, resetPassword, tabletPinLogin, tabletPinPair, tabletPinRevoke, tabletPinSet, tabletPinStatus, tabletPinAdminCreate, tabletPinAdminList, tabletPinAdminRename, tabletPinAdminRepair, tabletPinAdminRevoke } from '../controllers/auth.controller';
import {
    authenticateToken,
  } from '../middlewares/auth.middleware';
import { getProfile } from '../controllers/user.controller';
import { getNavigationPreferences, putNavigationPreferences } from '../controllers/navigation-preferences.controller';
import { getAccessProfile } from '../../access-control/controllers/access-control.controller';
import {
  forgotPasswordRateLimit,
  loginRateLimit,
  tabletPinLoginRateLimit,
  tabletPinPairRateLimit,
  mfaRateLimit,
  resetPasswordRateLimit,
  registerRateLimit,
} from '../middlewares/auth-rate-limit.middleware';
import {
  policy,
  recoveryCodes,
  revoke,
  startEnrollment,
  startReplacement,
  status,
  stepUp,
  updatePolicy,
  verifyChallenge,
} from '../controllers/mfa.controller';
import { requireSuperadmin } from '../../access-control/middlewares/require-superadmin';
import { testRegistration, testRegistrationOptions } from '../controllers/test-registration.controller';
import { uploadOwnAvatar } from '../controllers/avatar.controller';
import { createSecureUpload } from '../../../shared/uploads/secure-upload';
import {getSelfProfile,patchSelfProfile} from '../controllers/self-profile.controller';
import { publicAccountRequestRouter } from '../../account-requests/account-requests.routes';
import { companyLoginTargetMiddleware } from '../../entreprises/routes/entreprises.routes';

const router: Router = Router();
const avatarUpload = createSecureUpload('image', {maxFiles:1});

router.get('/test-registration', testRegistrationOptions);
router.post('/test-registration', registerRateLimit, testRegistration);

router.post('/login', loginRateLimit, companyLoginTargetMiddleware, login);
router.post('/tablet-pin/login', tabletPinLoginRateLimit, companyLoginTargetMiddleware, tabletPinLogin);
router.post('/tablet-pin/pair', tabletPinPairRateLimit, companyLoginTargetMiddleware, tabletPinPair);
router.post('/mfa/verify', mfaRateLimit, companyLoginTargetMiddleware, verifyChallenge);
router.post('/forgot-password', forgotPasswordRateLimit, forgotPassword);
router.post('/reset-password', resetPasswordRateLimit, resetPassword);
router.post('/activate', resetPasswordRateLimit, activateAccount);
router.use(publicAccountRequestRouter);
router.get(
  '/me',
  authenticateToken,
  getProfile
);

// Profil d'accès module (#326) — volontairement SANS authorizeRole : chaque compte,
// opérateur compris, doit pouvoir charger la navigation à laquelle il a droit.
router.get('/access-profile', authenticateToken, getAccessProfile);
router.get('/me/profile', authenticateToken, getSelfProfile);
router.patch('/me/profile', authenticateToken, patchSelfProfile);
router.put('/me/avatar', authenticateToken, avatarUpload.single('avatar'), uploadOwnAvatar);
router.get('/me/navigation-preferences', authenticateToken, getNavigationPreferences);
router.get('/me/tablet-pin',authenticateToken,tabletPinStatus);
router.put('/me/tablet-pin',authenticateToken,tabletPinSet);
router.delete('/me/tablet-pin',authenticateToken,tabletPinRevoke);
router.get('/tablet-pin/devices',authenticateToken,requireSuperadmin,tabletPinAdminList);
router.post('/tablet-pin/devices',authenticateToken,requireSuperadmin,tabletPinAdminCreate);
router.post('/tablet-pin/devices/:deviceId/pairing',authenticateToken,requireSuperadmin,tabletPinAdminRepair);
router.patch('/tablet-pin/devices/:deviceId',authenticateToken,requireSuperadmin,tabletPinAdminRename);
router.delete('/tablet-pin/devices/:deviceId',authenticateToken,requireSuperadmin,tabletPinAdminRevoke);
router.put('/me/navigation-preferences', authenticateToken, putNavigationPreferences);
router.get('/mfa/status', authenticateToken, status);
router.post('/mfa/step-up', authenticateToken, mfaRateLimit, stepUp);
router.post('/mfa/enrollment', authenticateToken, mfaRateLimit, startEnrollment);
router.post('/mfa/replacement', authenticateToken, mfaRateLimit, startReplacement);
router.post('/mfa/recovery-codes', authenticateToken, mfaRateLimit, recoveryCodes);
router.post('/mfa/revoke', authenticateToken, mfaRateLimit, revoke);
router.get('/mfa/policy', authenticateToken, requireSuperadmin, policy);
router.put('/mfa/policy', authenticateToken, requireSuperadmin, mfaRateLimit, updatePolicy);


export default router;
