import type { RequestHandler } from "express";
import { deliveryAffairsQuerySchema } from "../validators/delivery-affairs.validators";
import { svcListDeliveryAffairs } from "../services/delivery-affairs.service";
export const listDeliveryAffairs: RequestHandler = async (req, res, next) => {
    try {
        res.setHeader("Cache-Control", "private, no-store, max-age=0");
        res.json(await svcListDeliveryAffairs(deliveryAffairsQuerySchema.parse(req.query)));
    }
    catch (error) {
        next(error);
    }
};
