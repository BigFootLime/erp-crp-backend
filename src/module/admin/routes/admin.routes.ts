// src/module/admin/routes/admin.routes.ts
import { Router } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireRecentMfaForMutations } from "../../auth/middlewares/mfa-assurance.middleware";
import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import { requireSensitiveCapability } from "../../access-control/middlewares/sensitive-capability.middleware";
import {
  createPasswordResetTokenAdmin,
  createAccountInvitationAdmin,
  createUserAdmin,
  getUserAdmin,
  getPrivateUserProfile,
  patchPrivateUserProfile,
  listRolesAdmin,
  listUsersAdmin,
  listLoginLogsAdmin,
  resetUserPasswordAdmin,
  recoverUserAccountAdmin,
  getAdminAnalytics,
  patchUserAdmin,
  getErpSettingAdmin,
  upsertErpSettingAdmin,
} from "../controllers/admin.controller";
import { getOperationsConsole } from "../controllers/operations-console.controller";
import { uploadAdminUserAvatar } from '../../auth/controllers/avatar.controller';
import { createSecureUpload } from '../../../shared/uploads/secure-upload';

const router = Router();
const avatarUpload = createSecureUpload('image', {maxFiles:1});

router.use(authenticateToken);
router.get("/users/:id/private-profile", requireSensitiveCapability("hr.sensitive.read"), getPrivateUserProfile);
router.patch("/users/:id/private-profile", requireSensitiveCapability("hr.sensitive.write"), patchPrivateUserProfile);
// Account administration is a sensitive exception to the open-by-default
// module model. The live database marker is authoritative; role labels and a
// granted Administration module can never authorize account provisioning.
router.use(requireSuperadmin);
router.use(requireRecentMfaForMutations);

router.get("/users", listUsersAdmin);
router.get("/roles", listRolesAdmin);
router.get("/users/:id", getUserAdmin);
router.post("/users", createUserAdmin);
router.put('/users/:id/avatar', avatarUpload.single('avatar'), uploadAdminUserAvatar);
router.patch("/users/:id", patchUserAdmin);
router.post("/users/:id/invitations", createAccountInvitationAdmin);

router.get("/login-logs", listLoginLogsAdmin);
router.get("/analytics", getAdminAnalytics);
router.get("/operations", getOperationsConsole);
router.get("/erp-settings/:key", getErpSettingAdmin);
router.put("/erp-settings/:key", upsertErpSettingAdmin);

router.post("/users/:id/password-reset-token", createPasswordResetTokenAdmin);
router.patch("/users/:id/password", resetUserPasswordAdmin);
router.post("/users/:id/account-recovery", recoverUserAccountAdmin);

export default router;
