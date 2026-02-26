import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { acquireLock, heartbeatLock, releaseLock } from "../controllers/locks.controller";

const router = Router();
router.use(authenticateToken);

router.post("/acquire", acquireLock);
router.post("/release", releaseLock);
router.post("/heartbeat", heartbeatLock);

export default router;
