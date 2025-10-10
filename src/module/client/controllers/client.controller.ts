// src/module/client/controllers/client.controller.ts
import { Request, Response } from "express";
import * as clientService from "../services/client.service"; // ✅ namespace import

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

export async function postClient(req: Request, res: Response): Promise<void> {
  // …validate req.body if you want
  const created = await clientService.createClient(req.body);
  res.status(201).json(created);
}
