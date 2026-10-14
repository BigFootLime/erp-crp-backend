import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { AVATAR_KEYS, testRegistrationSchema } from "../validators/test-registration.validator";
import { registrationEnabled } from "../repository/test-registration.repository";
import { createTestAccount } from "../services/test-registration.service";
export const testRegistrationOptions=asyncHandler(async (_req,res) => {
  res.setHeader("Cache-Control","no-store");
  res.json({enabled:await registrationEnabled(),database:"cerp_test",role:"superAdmin",avatars:AVATAR_KEYS});
});
export const testRegistration=asyncHandler(async (req,res) => {
  res.setHeader("Cache-Control","no-store");
  const input=testRegistrationSchema.parse(req.body);
  const key=z.string().uuid("Identifiant de demande requis").parse(req.header("Idempotency-Key"));
  const user_agent=req.headers["user-agent"]?.toString() ?? null;
  const result=await createTestAccount(input,key,{ip:getClientIp(req),user_agent,...parseDevice(user_agent),path:"/api/v1/auth/test-registration"});
  res.setHeader("Idempotency-Replayed",String(result.replayed));
  res.status(result.replayed ? 200 : 201).json(result);
});
