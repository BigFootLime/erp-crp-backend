import type { RequestHandler } from "express";
import {
  createTarificationClientBodySchema,
  getTarificationClientQuerySchema,
  listTarificationClientsQuerySchema,
  tarificationIdParamsSchema,
  updateTarificationClientBodySchema,
} from "../validators/tarification.validators";
import {
  svcCreateTarificationClient,
  svcDeleteTarificationClient,
  svcGetTarificationClient,
  svcListTarificationClients,
  svcUpdateTarificationClient,
} from "../services/tarification.service";

export const listTarificationClients: RequestHandler = async (req, res, next) => {
  try {
    const query = listTarificationClientsQuerySchema.parse(req.query);
    const out = await svcListTarificationClients(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getTarificationClient: RequestHandler = async (req, res, next) => {
  try {
    const { id } = tarificationIdParamsSchema.parse(req.params);
    const { include } = getTarificationClientQuerySchema.parse(req.query);
    const out = await svcGetTarificationClient(id, include);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ tarification: out });
  } catch (err) {
    next(err);
  }
};

export const createTarificationClient: RequestHandler = async (req, res, next) => {
  try {
    const dto = createTarificationClientBodySchema.parse(req.body);
    const out = await svcCreateTarificationClient(dto);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateTarificationClient: RequestHandler = async (req, res, next) => {
  try {
    const { id } = tarificationIdParamsSchema.parse(req.params);
    const dto = updateTarificationClientBodySchema.parse(req.body);
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    const out = await svcUpdateTarificationClient(id, dto);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const deleteTarificationClient: RequestHandler = async (req, res, next) => {
  try {
    const { id } = tarificationIdParamsSchema.parse(req.params);
    const ok = await svcDeleteTarificationClient(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};
