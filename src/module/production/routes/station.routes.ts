import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  loadStationSessionIfAny,
  requireStationCapability,
  requireStationIdempotencyKey,
  requireStationSession,
} from "../middlewares/station-authorization.middleware";
import {
  acknowledgeHandover,
  bootstrap,
  closeSession,
  confirmMachine,
  createHandover,
  dossier,
  enrollDevice,
  heartbeat,
  identify,
  issueCredential,
  listCredentials,
  listDevices,
  listHandovers,
  listMachines,
  lock,
  revokeCredential,
  revokeDevice,
  scan,
  stationAudit,
  unlock,
  updateDevice,
  worklist,
} from "../controllers/station.controller";

/**
 * Surface « CERP Atelier — Mon poste » (#159), montée sous `/production/station`.
 *
 * DEUX FAMILLES DE ROUTES, DEUX IDENTITÉS DISTINCTES :
 *
 *   1. `/bootstrap`, `/identify`, `/sessions/unlock` sont les seules routes
 *      accessibles SANS session de poste : elles servent l'écran verrouillé et
 *      l'identification. Elles n'exposent aucune donnée métier.
 *   2. Toutes les autres routes tablette exigent une SESSION DE POSTE vivante,
 *      vérifiée en base à chaque requête — c'est ce qui rend la révocation
 *      d'une tablette immédiate.
 *   3. Les routes d'administration exigent un JWT ERP : on n'enrôle pas une
 *      tablette depuis une tablette.
 *
 * Ce routeur ne duplique AUCUNE commande de `/production/execution` (#274) :
 * démarrer, mettre en pause, déclarer et terminer restent là-bas. Il n'existe
 * qu'un seul moteur d'exécution.
 */
const router = Router();

/* ------------------------- 1. Écran verrouillé ---------------------------- */
// Publiques au sens « sans session de poste », mais toujours derrière le socle
// default-deny de `/api/v1` : le JWT ERP reste requis pour atteindre ce routeur.
// `loadStationSessionIfAny` permet au bootstrap de reconnaître une session déjà
// ouverte sans échouer quand il n'y en a pas.

router.get("/bootstrap", loadStationSessionIfAny, bootstrap);
router.post("/identify", identify);
router.post("/sessions/unlock", unlock);

/* --------------------- 2. Routes de poste (session) ----------------------- */

router.post("/sessions/lock", requireStationSession, lock);
router.post("/sessions/close", requireStationSession, closeSession);
router.post("/sessions/heartbeat", requireStationSession, heartbeat);

router.get(
  "/machines",
  requireStationSession,
  requireStationCapability("select_machine"),
  listMachines
);
router.post(
  "/machines/confirm",
  requireStationSession,
  requireStationCapability("select_machine"),
  confirmMachine
);

router.get(
  "/worklist",
  requireStationSession,
  requireStationCapability("read_own_station"),
  worklist
);
router.post("/scan", requireStationSession, requireStationCapability("read_own_station"), scan);

router.get(
  "/dossier/:ofId/:operationId",
  requireStationSession,
  requireStationCapability("read_dossier"),
  dossier
);

router.get(
  "/handovers",
  requireStationSession,
  requireStationCapability("read_own_station"),
  listHandovers
);
// Une transmission est une écriture immuable : clé d'idempotence obligatoire.
router.post(
  "/handovers",
  requireStationSession,
  requireStationIdempotencyKey,
  requireStationCapability("handover_shift"),
  createHandover
);
router.post(
  "/handovers/:id/acknowledge",
  requireStationSession,
  requireStationCapability("acknowledge_handover"),
  acknowledgeHandover
);

/* ----------------------- 3. Administration (JWT) -------------------------- */
// `authenticateToken` est déjà appliqué en amont par `v1.routes.ts` ; on le
// redéclare ici pour que ce routeur reste sûr s'il était monté ailleurs.

router.get(
  "/devices",
  authenticateToken,
  requireStationCapability("administer_devices"),
  listDevices
);
router.post(
  "/devices",
  authenticateToken,
  requireStationCapability("administer_devices"),
  enrollDevice
);
router.patch(
  "/devices/:id",
  authenticateToken,
  requireStationCapability("administer_devices"),
  updateDevice
);
router.post(
  "/devices/:id/revoke",
  authenticateToken,
  requireStationCapability("administer_devices"),
  revokeDevice
);

router.get(
  "/credentials/:userId",
  authenticateToken,
  requireStationCapability("read_own_station"),
  listCredentials
);
router.post(
  "/credentials",
  authenticateToken,
  requireStationCapability("administer_credentials"),
  issueCredential
);
router.post(
  "/credentials/:id/revoke",
  authenticateToken,
  requireStationCapability("administer_credentials"),
  revokeCredential
);

router.get("/audit", authenticateToken, requireStationCapability("audit_stations"), stationAudit);

export default router;
