// src/module/client/controllers/client.controller.ts
import { Request, RequestHandler, Response } from "express";
import * as clientService from "../services/client.service"; // ✅ namespace import
import { createClientSchema } from "../validators/client.validators";
import { repoCreateClient } from "../repository/client.repository";

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

