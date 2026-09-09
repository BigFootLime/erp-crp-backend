import { z } from 'zod';

// Canonical stock and purchase quantities use three decimal places.
export const consumableQuantitySchema = z.number().finite().positive().max(999999999)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001, 'Trois décimales maximum.');
