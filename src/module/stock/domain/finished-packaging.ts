import { z } from 'zod';
export const packagingPolicySchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('GLOBAL'), lotSize: z.null() }),
    z.object({ mode: z.literal('UNIT'), lotSize: z.null() }),
    z.object({ mode: z.literal('LOT'), lotSize: z.number().int().positive().max(1000000) }),
]);
export type PackagingPolicy = z.infer<typeof packagingPolicySchema>;
export function packagingPortions(quantity: number, policy: PackagingPolicy): number[] {
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
        throw new Error('Quantité entière positive requise.');
    const size = policy.mode === 'GLOBAL' ? quantity : policy.mode === 'UNIT' ? 1 : policy.lotSize;
    if (Math.ceil(quantity / size) > 1000)
        throw new Error('Un conditionnement ne peut pas produire plus de 1 000 étiquettes.');
    const portions: number[] = [];
    for (let left = quantity; left > 0; left -= size)
        portions.push(Math.min(left, size));
    return portions;
}
