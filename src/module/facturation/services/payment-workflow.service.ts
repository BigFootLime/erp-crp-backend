import {
  repoAllocatePayment,
  repoRegisterPayment,
} from "../repository/payment-workflow.repository";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import type {
  AllocatePaymentBodyDTO,
  RegisterPaymentBodyDTO,
} from "../validators/workflow.validators";

export const svcRegisterPaymentWorkflow = (params: {
  input: RegisterPaymentBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoRegisterPayment(params);

export const svcAllocatePaymentWorkflow = (params: {
  paymentId: number;
  input: AllocatePaymentBodyDTO;
  actor: FinanceActorContext;
  idempotencyKey: string | undefined;
}) => repoAllocatePayment(params);
