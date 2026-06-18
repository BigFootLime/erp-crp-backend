import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { listAssignableUsersController } from "../controllers/users.controller";

const router = Router();

router.use(authenticateToken);
router.get("/assignees", listAssignableUsersController);

export default router;
