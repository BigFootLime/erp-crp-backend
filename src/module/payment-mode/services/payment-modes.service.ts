// src/module/payment-modes/services/payment-modes.service.ts
import { repoCreatePaymentMode, repoListPaymentModes } from "../repository/payment-modes.repository";

export const svcCreatePaymentMode = (dto: { name: string; code?: string }) =>
  repoCreatePaymentMode(dto);

export const svcListPaymentModes = (q = "") =>
  repoListPaymentModes(q).then(rows =>
    // shape handy for your frontend selects/autocomplete
    rows.map(r => ({ id: r.payment_id, value: r.payment_id, label: r.type, code: r.payment_code }))
  );
