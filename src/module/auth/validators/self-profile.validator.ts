import {z} from 'zod';
import {canonicalizeAuthEmail} from '../domain/auth-identity';
import {AVATAR_KEYS} from './test-registration.validator';
const name=z.string().transform(v=>v.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleUpperCase('fr-FR')).pipe(z.string().min(1,'Ce champ est requis.').max(80));
export const selfProfilePatchSchema=z.object({
 name:name.optional(),surname:name.optional(),
 email:z.string().transform(canonicalizeAuthEmail).pipe(z.string().email('Adresse email invalide.').max(254)).optional(),
 tel_no:z.string().trim().transform(v=>v.replace(/[\s().-]/g,'')).refine(v=>v===''||/^(?:\+33|0)[1-9]\d{8}$/.test(v),'Téléphone invalide (ex. +33612345678).').transform(v=>v||null).nullable().optional(),
 avatar_key:z.enum(AVATAR_KEYS).optional(),
}).strict().refine(v=>Object.keys(v).length>0,'Aucune modification à enregistrer.');
export type SelfProfilePatch=z.infer<typeof selfProfilePatchSchema>;
