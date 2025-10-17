import { repoCreatePaymentMode, repoListPaymentModes } from "../repository/payment-modes.repository";

export const svcCreatePaymentMode = (dto: {
  name: string; code?: string; notes?: string; createdBy?: string | null;
}) => repoCreatePaymentMode(dto);

export const svcListPaymentModes = (q = "") =>
  repoListPaymentModes(q).then(rows =>
    rows.map(r => ({
      id: r.payment_id,
      value: r.payment_id,
      label: r.type,            // ← le select utilisera bien l’intitulé
      code: r.payment_code,
      notes: r.notes ?? null,
    }))
  );