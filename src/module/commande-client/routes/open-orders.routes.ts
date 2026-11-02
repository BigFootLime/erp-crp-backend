import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import {
  listOpenOrders,
  openContractOrder,
} from "../repository/open-orders.repository";

const router = Router();
const client = z.string().trim().min(1).max(80);
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        client_id: client.optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .strict()
      .parse(req.query);
    res.json(await listOpenOrders(query.client_id ?? null, query.page));
  }),
);
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        client_id: client,
        contract_id: z.string().uuid(),
        expected_version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const result = await openContractOrder(
      input.client_id,
      input.contract_id,
      input.expected_version,
      req.user!.id,
    );
    res.status(result.created ? 201 : 200).json(result);
  }),
);
export default router;
