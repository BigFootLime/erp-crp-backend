import { RequestHandler } from 'express';
import { readUserAvatar } from '../repository/avatar.repository';
import pool from '../../../config/database';
import {sharedDirectoryClient} from '../../../shared-directory/site-runtime';
import {readDirectoryAvatar} from '../../../shared-directory/avatar.facade';

export const getProfile: RequestHandler = async (req, res, next) => {
 try {
  const avatar=req.user ? sharedDirectoryClient()?await readDirectoryAvatar(pool,req.user.id):await readUserAvatar(req.user.id):null;
  res.status(200).json({
    message: 'Profil utilisateur',
    user: req.user
      ? {
          ...req.user,
          ...avatar,
          role: req.user.role,
          primary_role: req.user.primary_role ?? req.user.role,
          roles: req.user.roles ?? [req.user.primary_role ?? req.user.role],
        }
      : null,
  });
 } catch(error) {next(error);}
};
