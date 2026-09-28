import { Router } from "express";
import { runDemoPresentation } from "../controllers/demo-presentation.controller";

const router = Router();

router.post("/presentation/run", runDemoPresentation);

export default router;
