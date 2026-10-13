import {z} from 'zod';
import type {LegalParty} from '../../../shared/pdf/legal-mentions';
import {generalTermsSnapshotSchema} from '../../../shared/commercial-terms/commercial-terms.domain';
import type {SupplierPurchaseOrderSnapshot} from '../services/commande-fournisseur-official-pdf';

const amount=z.union([z.number().finite(),z.string().regex(/^-?\d+(?:\.\d+)?$/)]);
const nullableText=z.string().nullable().optional();
const payloadSchema=z.object({
  type:z.literal('BON_DE_COMMANDE_FOURNISSEUR'),version:z.number().int().positive(),
  code:z.string().min(1),statut:z.literal('APPROUVEE'),
  fournisseur:z.object({id:z.string().uuid(),code:nullableText,nom:z.string().min(1)}),
  devise:z.string().min(1),date_besoin:nullableText,incoterm:nullableText,conditions_paiement:nullableText,
  mode_transport:nullableText,commentaire_public:nullableText,
  general_terms:generalTermsSnapshotSchema.nullable(),
  lignes:z.array(z.object({position:z.number().int().positive(),reference_fournisseur:nullableText,designation:z.string(),
    unite:nullableText,quantite:amount,prix_unitaire_ht:amount.nullable(),remise_pct:amount.nullable(),tva_pct:amount.nullable(),
    net_ht:amount,date_besoin:nullableText})).min(1),
  totaux:z.object({total_ht:amount,total_remise:amount,total_tva:amount,frais_port_ht:amount,total_ttc:amount}),
});

/** A pre-fix freeze did not capture an official PDF identity. Its corrective
 * first issuance is dated now, with identity checked now. Commercial content
 * and terms come exclusively from its verified immutable business payload;
 * don't backdate issuance or rebuild prices/quantities from the live order. */
export function snapshotFromLegacySupplierFreeze(payload:unknown,identity:{
  issuer:LegalParty;supplierAddress:SupplierPurchaseOrderSnapshot['supplier']['address'];issuedAt:string;
}):SupplierPurchaseOrderSnapshot {
  const p=payloadSchema.parse(payload);
  if(!Number.isFinite(Date.parse(identity.issuedAt)))throw Error('SUPPLIER_PO_ISSUANCE_DATE_INVALID');
  return {type:'SUPPLIER_PURCHASE_ORDER',code:p.code,status:p.statut,issued_at:identity.issuedAt,
    supplier:{code:p.fournisseur.code??null,name:p.fournisseur.nom,address:identity.supplierAddress},
    issuer:identity.issuer,currency:p.devise,need_date:p.date_besoin??null,incoterm:p.incoterm??null,
    payment_terms:p.conditions_paiement??null,transport_mode:p.mode_transport??null,
    public_comment:p.commentaire_public??null,delivery_address:null,
    general_terms:p.general_terms,lines:p.lignes.map(l=>({position:l.position,reference:l.reference_fournisseur??null,
      designation:l.designation,unit:l.unite??null,quantity:String(l.quantite),
      unit_price_ht:l.prix_unitaire_ht==null?null:String(l.prix_unitaire_ht),
      discount_pct:l.remise_pct==null?null:String(l.remise_pct),vat_pct:l.tva_pct==null?null:String(l.tva_pct),
      net_ht:String(l.net_ht),need_date:l.date_besoin??null})),
    totals:{total_ht:String(p.totaux.total_ht),total_discount:String(p.totaux.total_remise),
      total_vat:String(p.totaux.total_tva),freight_ht:String(p.totaux.frais_port_ht),total_ttc:String(p.totaux.total_ttc)}};
}
