import { Router, Request, Response } from 'express';
import { register, login } from '../controllers/auth.controller';
import {
    authenticateToken,
    authorizeRole
  } from '../middlewares/auth.middleware';
import {asyncHandler} from '../../../utils/asyncHandler';
import { getProfile } from '../controllers/user.controller';

const router: Router = Router();

router.post('/register', register);
router.post('/login', login);
router.get(
  '/me',
  authenticateToken,
  authorizeRole('Administrateur Systeme et Reseau', 'Directeur'),
  getProfile
);
  

export default router;