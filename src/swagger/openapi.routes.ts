import { Router } from "express";

import { swaggerSpec } from "./swagger";
import { openApiContractDigest } from "./openapi-contract";

const router = Router();
const digest = openApiContractDigest(swaggerSpec);

router.get("/openapi.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("ETag", `\"sha256-${digest}\"`);
  res.json(swaggerSpec);
});

export default router;
