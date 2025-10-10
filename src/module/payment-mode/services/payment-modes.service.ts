import { CreatePaymentModeDTO } from "../validators/payment-mode.validators";
import { findAllPaymentModes, insertPaymentMode } from "../repository/payment-modes.repository";

export const listPaymentModes = () => findAllPaymentModes();

export const createPaymentMode = (dto: CreatePaymentModeDTO) =>
  insertPaymentMode(dto.name, dto.code);
