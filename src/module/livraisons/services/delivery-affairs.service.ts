import { repoListDeliveryAffairs } from "../repository/delivery-affairs.repository";
import type { DeliveryAffairsQuery } from "../validators/delivery-affairs.validators";
export const svcListDeliveryAffairs = (query: DeliveryAffairsQuery) => repoListDeliveryAffairs(query);
