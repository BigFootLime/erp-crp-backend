import { z } from "zod";
export const SETUP_STEPS=["company","workshop","costs","machines","maintenance","hours","stock","finance","references","review"] as const;
export const progressSchema=z.object({current_step:z.enum(SETUP_STEPS)}).strict();
const text=z.string().trim().max(200);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v,"Date invalide");
export const companySchema=z.object({
  biller_id:z.string().uuid().nullable(), expected_updated_at:z.string().nullable(),
  biller_name:text.min(2,"Raison sociale requise"),street:text.min(1,"Adresse requise"),house_number:text,
  postal_code:text.min(1,"Code postal requis"),city:text.min(1,"Ville requise"),country:z.string().trim().length(2,"Code pays à deux lettres").transform(v=>v.toUpperCase()),
  phone:text,email:z.string().trim().email("Email invalide").max(254),
  legal_form:text.min(1,"Forme juridique requise"),siret:z.string().trim().regex(/^\d{14}$/,"SIRET : 14 chiffres"),
  vat_number:text,share_capital:z.number().nonnegative().max(999999999999),rcs_city:text,rcs_number:text,
  late_penalty_rate:z.number().positive().max(999),recovery_indemnity:z.number().nonnegative().max(99999999),
  effective_from:date,
}).strict();
export type SetupCompany=z.infer<typeof companySchema>;
