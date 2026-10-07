import { z } from 'zod';
export const legacyDocumentLocation = z.string().trim().min(3).max(1000).refine(value => {
    if (/^\\\\[^\\/]+\\[^\r\n]+$/.test(value))
        return true;
    if (/^[A-Za-z]:\\[^\r\n]+$/.test(value))
        return true;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    }
    catch {
        return false;
    }
}, 'Indiquez un chemin serveur Windows ou une adresse HTTPS sans identifiants.');
export const legacyDocumentIdentity = z.object({ id: z.string().uuid() });
export const legacyDocumentCommand = z.object({
    idempotencyKey: z.string().uuid(),
    type: z.enum(['PLAN', 'CERTIFICAT_MP', 'CERTIFICAT_TRAITEMENT', 'CONTROLE', 'AUTRE']),
    label: z.string().trim().min(3).max(200),
    location: legacyDocumentLocation,
    reason: z.string().trim().min(10).max(1000),
}).strict();
export type LegacyDocumentCommand = z.infer<typeof legacyDocumentCommand>;
