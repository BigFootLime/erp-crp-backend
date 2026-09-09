import type { RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import {
  findTerminal,
  type Terminal,
} from "../repository/terminal-auth.repository";
import {
  authenticateTerminalSession,
  assertTerminalAdmin,
} from "../services/terminal-auth.service";
declare global {
  namespace Express {
    interface Request {
      terminal?: Terminal;
    }
  }
}
export const requireTerminalDevice: RequestHandler = (req, _res, next) => {
  const token = req.get("X-Terminal-Device");
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return next(
      new HttpError(
        401,
        "TERMINAL_DEVICE_REQUIRED",
        "Appairez cette tablette depuis CERP.",
      ),
    );
  void findTerminal(token)
    .then((t) => {
      req.terminal = t;
      next();
    })
    .catch(next);
};
export const requireTerminalSession: RequestHandler = (req, _res, next) => {
  if (!req.terminal)
    return next(
      new HttpError(401, "TERMINAL_DEVICE_REQUIRED", "Terminal non reconnu."),
    );
  const token = req.get("X-Station-Session");
  if (!token)
    return next(
      new HttpError(401, "TERMINAL_SESSION_REQUIRED", "Saisissez votre code."),
    );
  void authenticateTerminalSession(req.terminal, token)
    .then((station) => {
      req.station = station;
      req.user = {
        id: station.user.id,
        role: station.user.role ?? "",
        username: station.user.username,
        email: "",
      };
      next();
    })
    .catch(next);
};
export function terminalAdmin(credentials = false): RequestHandler {
  return (req, _res, next) => {
    void assertTerminalAdmin(req.user?.id ?? 0, credentials)
      .then(() => next())
      .catch(next);
  };
}
export const requireOperatorTerminal: RequestHandler = (req, _res, next) => {
  if (req.terminal?.kind !== "OPERATOR")
    return next(
      new HttpError(
        403,
        "TERMINAL_KIND_FORBIDDEN",
        "Cette fonction appartient au poste opérateur.",
      ),
    );
  next();
};
