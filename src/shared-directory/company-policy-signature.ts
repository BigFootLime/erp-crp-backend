import { createHmac, timingSafeEqual } from "node:crypto";

const path = "/internal/directory/business-company-policy";
export function companyPolicyReplyMac(
  key: string,
  nonce: string,
  body: Buffer,
) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`CERP-BUSINESS-COMPANY-POLICY-RESPONSE-v1\n${path}\n${nonce}\n`)
    .update(body)
    .digest();
}
export function verifyCompanyPolicyReply(
  key: string,
  nonce: string,
  body: Buffer,
  signature: string,
) {
  return (
    /^[a-f0-9]{64}$/.test(signature) &&
    timingSafeEqual(
      companyPolicyReplyMac(key, nonce, body),
      Buffer.from(signature, "hex"),
    )
  );
}
