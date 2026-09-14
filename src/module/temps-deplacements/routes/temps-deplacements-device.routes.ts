import { Router } from "express";
import * as c from "../controllers/temps-deplacements.controller";

// Surface minimale de la borne physique. Le token opaque du terminal est
// l'authentification de ces deux commandes ; aucune session ERP n'est requise.
// Toute autre route /time-clock reste montée après authenticateToken.
const router = Router();

router.post("/device-events", c.postDeviceEvent);
router.post("/device-heartbeat", c.postDeviceHeartbeat);

export default router;
