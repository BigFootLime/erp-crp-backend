import { z } from 'zod';
import { receivedMaterialBarsSchema } from './material-bars.validators';

const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Actualisez les barres avant de confirmer.');
const selection = z.object({ barId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict();
const selectedBars = z.array(selection).min(1).max(1000);
/** Prepared for the movement posting boundary. Do not strip unknown fields or
 * coerce empty strings to zero: the UI owns human-friendly number formatting. */
export const materialBarMovementCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RECEIVE'), expectedVersion: revision, bars: receivedMaterialBarsSchema }).strict(),
  z.object({ kind: z.literal('ISSUE'), expectedVersion: revision,
    bars: z.array(selection.extend({ quantityMm: z.number().finite().positive().max(1e9).multipleOf(.001) }).strict()).min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('DEPRECIATE'), expectedVersion: revision,
    bars: z.array(selection.extend({ quantityMm: z.number().finite().positive().max(1e9).multipleOf(.001) }).strict()).min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('TRANSFER'), expectedVersion: revision, expectedDestinationVersion: revision, bars: selectedBars }).strict(),
]).superRefine((body, context) => {
  if (body.kind !== 'RECEIVE' && new Set(body.bars.map(bar => bar.barId)).size !== body.bars.length)
    context.addIssue({ code: 'custom', path: ['bars'], message: 'Une barre ne peut figurer qu’une fois.' });
});
