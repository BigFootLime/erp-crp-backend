import type { RequestHandler } from "express";
import { repoListComptesVente, repoListConditionsPaiement } from "../repository/commercial-references.repository";

export const listConditionsPaiement: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await repoListConditionsPaiement());
  } catch (error) {
    next(error);
  }
};

export const listComptesVente: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await repoListComptesVente());
  } catch (error) {
    next(error);
  }
};
