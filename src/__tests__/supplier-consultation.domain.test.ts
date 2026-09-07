import {describe,it,expect} from 'vitest';
import {assertSelectableSupplierOffer,compareSupplierOffer,consultationSnapshotKey,supplierConsultationRequest,type ConsultationSnapshot} from '../module/commande-fournisseur/domain/supplier-consultation';
import {supplierConsultationCommandSchema,supplierOfferResponseSchema,type SupplierOfferResponse} from '../module/commande-fournisseur/validators/supplier-consultation.validators';

const lineId='11111111-1111-4111-8111-111111111111';
const snapshot:ConsultationSnapshot={code:'BCF-TEST',currency:'EUR',delivery_address:'Atelier test',destination_id:null,freight_vat_pct:20,lines:[{
  id:lineId,designation:'Brut aluminium',article_id:null,article_code:'ALU',quantity:40,unit:'u',stock_unit:'u',coefficient:1,vat_pct:20,
  need_date:'2026-09-18',requirements:[{type:'SPECIFICATION',valeur:'6082 T651',obligatoire:true}],documents:['Certificat matière'],operation:'Découpe',of_id:19,
}]};
function offer():SupplierOfferResponse{return {reference:'OFFRE-TEST',currency:'EUR',valid_until:'2026-09-20',freight_ht:10,payment_terms:'30 jours',notes:'',lines:[{
  line_id:lineId,quantity:50,unit:'u',unit_price_ht:2,discount_pct:0,fees_ht:0,delivery_date:'2026-09-17',conformity:'CONFORMING',conformity_notes:'Exigences confirmées',supplier_reference:'ALU-TEST',
}]};}
describe('consultation matière',()=>{
  it('affiche séparément surplus et coût sans créer de demande supplémentaire',()=>{
    const before=structuredClone(snapshot);
    const result=assertSelectableSupplierOffer(snapshot,offer(),'2026-09-08');
    expect(result.quantities).toEqual([{lineId,surplus:10,late:false}]);
    expect(result.totals).toMatchObject({total_ht:110,total_tva:22,total_ttc:132});
    expect(snapshot).toEqual(before);
  });
  it.each(['NONCONFORMING','TO_VERIFY'] as const)('refuse une conformité %s au choix, mais conserve une réponse enregistrable',conformity=>{
    const response=offer();response.lines[0].conformity=conformity;
    expect(supplierOfferResponseSchema.safeParse(response).success).toBe(true);
    expect(()=>assertSelectableSupplierOffer(snapshot,response,'2026-09-08')).toThrow();
  });
  it('refuse quantité insuffisante, autre unité, offre expirée et date passée',()=>{
    const response=offer();response.lines[0].quantity=39;response.lines[0].unit='kg';response.valid_until='2026-09-01';response.lines[0].delivery_date='2026-09-01';
    expect(compareSupplierOffer(snapshot,response,'2026-09-08').blocking).toHaveLength(4);
  });
  it('signale une livraison tardive sans choisir à la place de l’acheteur',()=>{
    const response=offer();response.lines[0].delivery_date='2026-09-22';
    expect(compareSupplierOffer(snapshot,response,'2026-09-08')).toMatchObject({blocking:[],quantities:[{late:true}]});
  });
  it('ne compare pas des devises par conversion implicite',()=>{
    const response=offer();response.currency='USD';
    expect(compareSupplierOffer(snapshot,response,'2026-09-08')).toMatchObject({currency:'USD',totals:{total_ht:110}});
  });
  it('interdit les doublons de lignes et les quantités arrondies silencieusement',()=>{
    const response=offer();response.lines.push({...response.lines[0]});
    expect(supplierOfferResponseSchema.safeParse(response).success).toBe(false);
    response.lines.pop();response.lines[0].quantity=40.0001;
    expect(supplierOfferResponseSchema.safeParse(response).success).toBe(false);
  });
  it('refuse les identifiants de lignes étrangères et les réponses incomplètes',()=>{
    const response=offer();response.lines[0].line_id='22222222-2222-4222-8222-222222222222';
    expect(compareSupplierOffer(snapshot,response,'2026-09-08').blocking.length).toBeGreaterThan(0);
    response.lines=[];
    expect(compareSupplierOffer(snapshot,response,'2026-09-08').blocking.length).toBeGreaterThan(0);
  });
  it('tolère le réordonnancement jsonb des clés mais détecte une exigence modifiée',()=>{
    const copy=Object.fromEntries(Object.entries(snapshot).reverse());
    expect(consultationSnapshotKey(copy)).toBe(consultationSnapshotKey(snapshot));
    const changed=structuredClone(snapshot);changed.lines[0].requirements[0].valeur='6061';
    expect(consultationSnapshotKey(changed)).not.toBe(consultationSnapshotKey(snapshot));
  });
  it('prépare une demande avec les exigences et sans prix concurrent',()=>{
    const text=supplierConsultationRequest(snapshot,'Fournisseur test','Pièces fictives');
    expect(text).toContain('6082 T651');expect(text).toContain('40 u');expect(text).toContain('Certificat matière');expect(text).not.toContain('OFFRE-TEST');
  });
  it('exige justification, version et idempotence et refuse un statut imposé',()=>{
    const valid={action:'SELECT',consultation_id:lineId,offer_id:lineId,expected_version:1,expected_updated_at:'2026-09-08 10:00:00+00',idempotency_key:'consultation-test',reason:'Meilleur délai confirmé'};
    expect(supplierConsultationCommandSchema.safeParse(valid).success).toBe(true);
    expect(supplierConsultationCommandSchema.safeParse({...valid,reason:''}).success).toBe(false);
    expect(supplierConsultationCommandSchema.safeParse({...valid,statut:'ENVOYEE'}).success).toBe(false);
    expect(supplierConsultationCommandSchema.safeParse({...valid,expected_version:undefined}).success).toBe(false);
  });
});
