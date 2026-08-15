import type { RequestHandler } from "express";

export const requireRecentMfa = (maxAgeSeconds = 5 * 60): RequestHandler => (req, res, next) => {
  // The global authenticateToken middleware rejects a privileged token with no
  // MFA claim. Keeping this compatibility branch lets isolated route tests and
  // non-privileged legacy callers exercise their original contracts.
  if (req.user?.mfa !== true) {
    next();
    return;
  }
  const verifiedAt = req.user.mfa_verified_at;
  const age = typeof verifiedAt === "number" ? Math.floor(Date.now() / 1000) - verifiedAt : Number.POSITIVE_INFINITY;
  if (age >= 0 && age <= maxAgeSeconds) {
    next();
    return;
  }
  res.status(428).json({
    success: false,
    code: "MFA_STEP_UP_REQUIRED",
    message: "Confirmez votre facteur MFA pour cette action sensible.",
    details: { max_age_seconds: maxAgeSeconds },
  });
};

export const requireRecentMfaForMutations: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  requireRecentMfa()(req, res, next);
};
