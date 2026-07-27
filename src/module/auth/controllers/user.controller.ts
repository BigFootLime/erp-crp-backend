import { RequestHandler } from 'express';

export const getProfile: RequestHandler = (req, res) => {
  res.status(200).json({
    message: 'Profil utilisateur',
    user: req.user
      ? {
          ...req.user,
          role: req.user.role,
          primary_role: req.user.primary_role ?? req.user.role,
          roles: req.user.roles ?? [req.user.primary_role ?? req.user.role],
        }
      : null,
  });
};
