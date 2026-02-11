// ce code est un custom async-handler optimisé pour typescript pour eviter d'écrire les try catch dans chaque méthode de contrôleur
import type { Request, Response, NextFunction, RequestHandler } from "express";

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    return fn(req, res, next).then(() => undefined).catch(next);
  };
