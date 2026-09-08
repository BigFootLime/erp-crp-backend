import {repoCommandSupplierConsultation,repoReadSupplierConsultations} from '../repository/supplier-consultation.repository';
import type {AuditContext} from '../repository/commande-fournisseur.repository';
import type {SupplierConsultationCommand} from '../validators/supplier-consultation.validators';
export const readSupplierConsultationsSVC=(id:string,role:string|null|undefined,roundId?:string,actorId=0)=>repoReadSupplierConsultations(id,role,roundId,actorId);
export const commandSupplierConsultationSVC=(id:string,body:SupplierConsultationCommand,audit:AuditContext)=>repoCommandSupplierConsultation(id,body,audit);
