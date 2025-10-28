// src/module/clients/controllers/clients.analytics.controller.ts
import { Request, Response } from "express"
import { getClientsAnalytics } from "../services/clients.analytics.service"

export async function listClientsAnalytics(req: Request, res: Response) {
  const { from, to, status, blocked, country } = req.query as {
    from?: string; to?: string; status?: string; blocked?: string; country?: string
  }
  const data = await getClientsAnalytics({ from, to, status, blocked, country })
  res.json(data)
}
