import { Router } from "express";
import { centralApply, centralGetSimulation, centralSimulate, centralSnapshot, centralStatus, centralUnplan } from "../controllers/planning-central.controller";
import { requirePlanningCapability } from "../middlewares/planning-authorization.middleware";
const router=Router();
// Authentication and module scope are enforced by the parent planning router.
router.get("/status",requirePlanningCapability("read"),centralStatus);
router.get("/snapshot",requirePlanningCapability("read"),centralSnapshot);
router.post("/simulations",requirePlanningCapability("manage_schedule"),centralSimulate);
router.get("/simulations/:id",requirePlanningCapability("manage_schedule"),centralGetSimulation);
router.post("/simulations/:id/apply",requirePlanningCapability("manage_schedule"),centralApply);
router.post("/unplan",requirePlanningCapability("manage_schedule"),centralUnplan);
export default router;
