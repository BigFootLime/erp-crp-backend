import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { listCodeFormats } from "../controllers/codes.controller";

const router = Router();

router.use(authenticateToken);

router.get("/formats", listCodeFormats);

export default router;
