// ce code est un custom async-handler optimisé pour typescript pour eviter d'écrire les try catch dans chaque méthode de contrôleur
import { Request, Response, NextFunction } from 'express'

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
