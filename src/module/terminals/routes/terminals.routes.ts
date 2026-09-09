import * as controllers from "../controllers/terminals.controller";
import { Router } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import { grantAccountModuleAccessToRequest } from "../../access-control/context/account-module-access.context";
import { terminalModule } from '../domain/terminal-policy';
import { getOwnPin,changeOwnPin } from '../controllers/terminal-own-pin.controller';
import supplyRoutes from './terminal-supply.routes';
import {
  requireTerminalDevice,
  requireTerminalSession,
  requireOperatorTerminal,
  terminalAdmin,
} from "../middlewares/terminal-auth.middleware";

const router = Router();
router.use((_req, _res, next) => {
  if (process.env.CERP_ANDROID_TERMINALS_ENABLED !== "true")
    return next(
      new HttpError(
        503,
        "TERMINALS_DISABLED",
        "Les terminaux Android ne sont pas activés sur cet environnement.",
      ),
    );
  next();
});
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// This administrative surface still requires an ERP JWT and administrative rights.
const admin = Router();
admin.use(authenticateToken, terminalAdmin());
admin.get("/", controllers.listTerminals);
admin.get("/options", controllers.adminOptions);
admin.patch("/:id", controllers.updateTerminal);
admin.post("/", controllers.enrollTerminal);
admin.post("/:id/pairing", controllers.renewPairing);
admin.put("/pins", terminalAdmin(true), controllers.setPin);
admin.post("/pins/revoke", terminalAdmin(true), controllers.revokePin);
admin.post("/:id/revoke", controllers.revokeTerminal);
router.use("/admin", admin);
router.get('/me/pin',authenticateToken,getOwnPin);
router.put('/me/pin',authenticateToken,changeOwnPin);
router.post("/pair", controllers.pairTerminal);
router.use(requireTerminalDevice);
router.get("/bootstrap", controllers.bootstrapTerminal);
router.post("/identify", controllers.identifyOperator);
router.use(requireTerminalSession);
// The account's production grant was verified by requireTerminalSession. Only
// the explicit terminal commands below can use it; there is no ERP fallthrough.
router.use((req, _res, next) =>
  grantAccountModuleAccessToRequest(
    req,
    { userId: req.user!.id, moduleKey: terminalModule[req.terminal!.kind], elevated: false },
    next,
  ),
);
router.get("/session", controllers.getSession);
router.post("/session/activity", controllers.recordActivity);
router.post("/session/lock", controllers.lockSession);
router.post("/session/close", controllers.closeSession);
router.use(supplyRoutes);
router.use("/operator", requireOperatorTerminal);
router.get("/operator/worklist", controllers.getWorklist);
router.get("/operator/activities", controllers.listActivities);
router.post("/operator/scan", controllers.resolveScan);
router.get(
  "/operator/ofs/:of_id/operations/:operation_id",
  controllers.getDossier,
);
router.post(
  "/operator/ofs/:of_id/operations/:operation_id/handover",
  controllers.createHandover,
);
router.get(
  "/operator/ofs/:of_id/operations/:operation_id/documents/:id",
  controllers.downloadDocument,
);
router.post(
  "/operator/ofs/:of_id/operations/:operation_id/program/confirm",
  controllers.confirmProgram,
);
router.post(
  "/operator/ofs/:of_id/operations/:operation_id/start",
  controllers.startExecution,
);
router.post(
  "/operator/executions/:id/:action",
  controllers.transitionExecution,
);
router.post(
  "/operator/ofs/:of_id/operations/:operation_id/declaration/preview",
  controllers.previewDeclaration,
);
router.post(
  "/operator/ofs/:of_id/operations/:operation_id/declaration/confirm",
  controllers.confirmDeclaration,
);

router.post(
  "/operator/ofs/:of_id/operations/:operation_id/controls/:action",
  controllers.prepareControl,
);
router.post(
  "/operator/ofs/:of_id/operations/:operation_id/controls/:id/measurements",
  controllers.recordMeasurements,
);
router.use((_req, _res, next) =>
  next(
    new HttpError(404, "TERMINAL_ROUTE_UNKNOWN", "Fonction terminal inconnue."),
  ),
);
export default router;
