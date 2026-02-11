import type { RequestHandler } from "express";
import {
  affaireIdParamsSchema,
  createAffaireBodySchema,
  getAffaireQuerySchema,
  listAffairesQuerySchema,
  updateAffaireBodySchema,
} from "../validators/affaire.validators";
import {
  svcCreateAffaire,
  svcDeleteAffaire,
  svcGetAffaire,
  svcListAffaires,
  svcUpdateAffaire,
} from "../services/affaire.service";

export const listAffaires: RequestHandler = async (req, res, next) => {
  try {
    const query = listAffairesQuerySchema.parse(req.query);
    const out = await svcListAffaires(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getAffaire: RequestHandler = async (req, res, next) => {
  try {
    const { id } = affaireIdParamsSchema.parse(req.params);
    const { include } = getAffaireQuerySchema.parse(req.query);

    const affaire = await svcGetAffaire(id, include);
    if (!affaire) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({ affaire });
  } catch (err) {
    next(err);
  }
};

export const createAffaire: RequestHandler = async (req, res, next) => {
  try {
    const dto = createAffaireBodySchema.parse(req.body);
    const out = await svcCreateAffaire(dto);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateAffaire: RequestHandler = async (req, res, next) => {
  try {
    const { id } = affaireIdParamsSchema.parse(req.params);
    const dto = updateAffaireBodySchema.parse(req.body);
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const out = await svcUpdateAffaire(id, dto);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const deleteAffaire: RequestHandler = async (req, res, next) => {
  try {
    const { id } = affaireIdParamsSchema.parse(req.params);
    const ok = await svcDeleteAffaire(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};
