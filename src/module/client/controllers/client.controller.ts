// src/module/client/controllers/client.controller.ts
import { Request, RequestHandler, Response } from "express";
import * as clientService from "../services/client.service"; // ✅ namespace import
import { createClientSchema } from "../validators/client.validators";
import { repoCreateClient, repoUpdateClient  } from "../repository/client.repository";
import path from "node:path";
import { LOGO_BASE_DIR } from "../upload/client-logo-upload";
import { updateClientLogoPath } from "../services/client.service";


export const uploadClientLogo: RequestHandler = async (req, res, next) => {
  try {
    const clientId = req.params.id;

    if (!clientId) {
      return res.status(400).json({ message: "client_id manquant dans l'URL" });
    }

    const file = (req as any).file as Express.Multer.File | undefined;

    if (!file) {
      return res.status(400).json({ message: "Aucun fichier 'logo' reçu" });
    }

    // chemin absolu sur le serveur (UNC)
    const absolutePath = file.path; // multer nous donne déjà le chemin complet

    // si tu préfères stocker juste le nom de fichier :
    // const logoPath = path.join(LOGO_BASE_DIR, path.basename(file.filename));
    const logoPath = absolutePath;

    // update BDD
    await updateClientLogoPath(clientId, logoPath);

    return res.status(200).json({
      client_id: clientId,
      logo_path: logoPath,
    });
  } catch (e) {
    next(e);
  }
};


export async function getClientById(req: Request, res: Response): Promise<void> {
  const row = await clientService.getClientById(req.params.id);
  if (!row) {
    res.status(404).json({ message: "Client not found" });
    return;
  }
  res.json(row);
}

export async function listClients(req: Request, res: Response): Promise<void> {
  const q = (req.query.q as string) || "";
  const limit = Math.min(Number(req.query.limit ?? 25), 100);
  const rows = await clientService.listClients(q, limit);
  res.json(rows);
}

export const postClient: RequestHandler = async (req, res, next) => {
  try {
    const dto = createClientSchema.parse(req.body);
    const created = await repoCreateClient(dto);
    res.status(201).json(created); // { client_id }
  } catch (e) {
    next(e);
  }
};

export const patchClientPrimaryContact: RequestHandler = async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const { contact_id } = req.body as { contact_id: string };
    await clientService.updateClientPrimaryContact(clientId, contact_id);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

export const patchClient: RequestHandler = async (req, res, next) => {
  try {
    const id = req.params.id;

    // on réutilise le même schéma que pour la création
    const dto = createClientSchema.parse(req.body);

    await repoUpdateClient(id, dto);

    // pas besoin de body, le frontend n'en attend pas
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

