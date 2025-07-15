import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';

interface JwtPayload {
  id: number;
  username: string;
  email: string;
  role: string;
}

// 🔧 Ajout de `req.user` pour tout Express
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// 🔐 Vérifie le token JWT
export const authenticateToken: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant ou invalide' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Token invalide ou expiré' });
  }
};

// 🎯 Vérifie que l'utilisateur a un rôle autorisé
export const authorizeRole = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!req.user) {
        res.status(401).json({ error: 'Utilisateur non authentifié' });
        return;
      }
  
      if (!roles.includes(req.user.role)) {
        res.status(403).json({ error: "Accès refusé : rôle insuffisant" });
        return;
      }
  
      next();
    };
  };
  
