export type PaymentMode = {
  id: string;          // payment_id
  code: string;        // payment_code
  type: string;        // type
};

export type CreatePaymentModeInput = {
  name: string;        // shown on UI, we’ll store in payment_code
  code?: string;       // optional short code; fallback to name
  notes?: string;      // not in schema; ignored for now
};
