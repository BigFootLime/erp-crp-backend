import {
  listTreatmentEstimates,
  saveTreatmentEstimate,
  type TreatmentEstimateInput,
} from "../repository/supplier-treatment-estimates.repository";
export const getSupplierTreatmentEstimates = (orderId: string) =>
  listTreatmentEstimates(orderId);
export const saveSupplierTreatmentEstimate = (input: TreatmentEstimateInput) =>
  saveTreatmentEstimate(input);
