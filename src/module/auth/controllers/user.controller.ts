import { RequestHandler } from 'express';

export const getProfile: RequestHandler = (req, res) => {
  res.status(200).json({
    message: 'Profil utilisateur',
    user: req.user,
  });
};
