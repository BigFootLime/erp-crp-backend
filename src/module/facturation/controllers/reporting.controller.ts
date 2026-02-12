import type { RequestHandler } from "express";
import { repoCommercialOutstanding, repoCommercialRevenue, repoCommercialTopClients } from "../repository/reporting.repository";
import { outstandingQuerySchema, revenueQuerySchema, topClientsQuerySchema } from "../validators/reporting.validators";

export const commercialRevenue: RequestHandler = async (req, res, next) => {
  try {
    const query = revenueQuerySchema.parse(req.query);
    const out = await repoCommercialRevenue(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const commercialOutstanding: RequestHandler = async (req, res, next) => {
  try {
    const query = outstandingQuerySchema.parse(req.query);
    const out = await repoCommercialOutstanding(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const commercialTopClients: RequestHandler = async (req, res, next) => {
  try {
    const query = topClientsQuerySchema.parse(req.query);
    const out = await repoCommercialTopClients(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};
