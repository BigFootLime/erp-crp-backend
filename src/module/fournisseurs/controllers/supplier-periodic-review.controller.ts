import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import {
  supplierReviewBoard,
  supplierReviewsDue,
  supplierReviewOptions,
  supplierReviewWrite,
} from "../services/supplier-periodic-review.service";
function supplier(req: Request) {
  const parsed = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success)
    throw new HttpError(
      422,
      "SUPPLIER_REVIEW_SUPPLIER_INVALID",
      "Identifiant fournisseur invalide.",
    );
  return parsed.data;
}
function actor(req: Request) {
  if (!req.user?.id)
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return req.user.id;
}
export const readSupplierReviews: RequestHandler = async (req, res, next) => {
  try {
    res.json({ data: await supplierReviewBoard(supplier(req)) });
  } catch (error) {
    next(error);
  }
};
export const readSupplierReviewsDue: RequestHandler = async (
  _req,
  res,
  next,
) => {
  try {
    res.json({ data: await supplierReviewsDue() });
  } catch (error) {
    next(error);
  }
};
export const readSupplierReviewOptions: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    res.json({ data: await supplierReviewOptions(supplier(req), actor(req)) });
  } catch (error) {
    next(error);
  }
};
export const writeSupplierReview: RequestHandler = async (req, res, next) => {
  try {
    res
      .status(201)
      .json({
        data: await supplierReviewWrite(supplier(req), req.body, actor(req)),
      });
  } catch (error) {
    next(error);
  }
};
