import type { RequestHandler } from "express";

import { stripQueryFromUrl } from "../../../utils/logPath";
import { verifyPortalSession } from "../domain/client-portal-security";
import { repoGetLivePortalAccount } from "../repository/client-portal.repository";

export const authenticateClientPortal: RequestHandler = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ code: "CLIENT_PORTAL_SESSION_REQUIRED", message: "Session portail requise." });
    return;
  }
  try {
    const identity = verifyPortalSession(authorization.slice("Bearer ".length));
    repoGetLivePortalAccount(identity)
      .then((account) => {
        if (
          !account
          || account.status !== "ACTIVE"
          || account.session_epoch !== identity.sessionEpoch
        ) {
          res.status(401).json({ code: "CLIENT_PORTAL_SESSION_INVALID", message: "Session portail invalide ou expirée." });
          return;
        }
        req.portalIdentity = identity;
        next();
      })
      .catch(next);
  } catch {
    console.warn(JSON.stringify({
      type: "client_portal_auth_failed",
      requestId: req.requestId ?? null,
      path: stripQueryFromUrl(req.originalUrl),
      reason: "session_invalid",
    }));
    res.status(401).json({ code: "CLIENT_PORTAL_SESSION_INVALID", message: "Session portail invalide ou expirée." });
  }
};

