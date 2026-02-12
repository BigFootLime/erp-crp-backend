import type { RequestHandler } from "express";
import {
  createPaiementBodySchema,
  getPaiementQuerySchema,
  listPaiementsQuerySchema,
  paiementIdParamsSchema,
  updatePaiementBodySchema,
} from "../validators/paiements.validators";
import {
  svcCreatePaiement,
  svcDeletePaiement,
  svcGetPaiement,
  svcListPaiements,
  svcUpdatePaiement,
} from "../services/paiements.service";

export const listPaiements: RequestHandler = async (req, res, next) => {
  try {
    const query = listPaiementsQuerySchema.parse(req.query);
    const out = await svcListPaiements(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getPaiement: RequestHandler = async (req, res, next) => {
  try {
    const { id } = paiementIdParamsSchema.parse(req.params);
    const { include } = getPaiementQuerySchema.parse(req.query);
    const out = await svcGetPaiement(id, include);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ paiement: out });
  } catch (err) {
    next(err);
  }
};

export const createPaiement: RequestHandler = async (req, res, next) => {
  try {
    const dto = createPaiementBodySchema.parse(req.body);
    const out = await svcCreatePaiement(dto);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updatePaiement: RequestHandler = async (req, res, next) => {
  try {
    const { id } = paiementIdParamsSchema.parse(req.params);
    const dto = updatePaiementBodySchema.parse(req.body);
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    const out = await svcUpdatePaiement(id, dto);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const deletePaiement: RequestHandler = async (req, res, next) => {
  try {
    const { id } = paiementIdParamsSchema.parse(req.params);
    const ok = await svcDeletePaiement(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};
