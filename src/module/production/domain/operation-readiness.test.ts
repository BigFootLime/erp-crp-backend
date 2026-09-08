import {describe,it,expect} from "vitest";
import {assertOperationQuantityCeiling,evaluateOperationReadiness,type OperationReadinessFacts} from "./operation-readiness";
const base:OperationReadinessFacts={id:"cut",label:"Découpe",phase:10,status:"TODO",targetQuantity:100,processedQuantity:0,dossierComplete:true,executionStatus:"BROUILLON",planned:true,machineBlocked:false,preparationMissing:false,programRequired:false,programReady:false,qualityBlocked:false,componentsMissing:false,materials:[{label:"Bruts",availableBlanks:60,allowPartial:true,blockers:[]}],predecessors:[]};
describe("autorisation par opération et quantité",()=>{
  it("permet 60 sur 100 à la découpe sans exiger le programme d’usinage",()=>expect(evaluateOperationReadiness(base)).toMatchObject({canStart:true,availableQuantity:60,partial:true}));
  it("bloque le débit partiel si la gamme exige toute la matière",()=>expect(evaluateOperationReadiness({...base,materials:[{...base.materials[0],allowPartial:false}]}).canStart).toBe(false));
  it("retire du plafond les quantités déjà traitées",()=>expect(evaluateOperationReadiness({...base,processedQuantity:20})).toMatchObject({availableQuantity:40,remainingQuantity:80}));
  it("refuse une réserve mise en quarantaine après affectation",()=>expect(evaluateOperationReadiness({...base,materials:[{...base.materials[0],blockers:["Lot en quarantaine"]}]}).canStart).toBe(false));
  it("exige le programme uniquement pour l’opération concernée",()=>expect(evaluateOperationReadiness({...base,programRequired:true}).blockers).toContainEqual(expect.objectContaining({code:"PROGRAM_REQUIRED"})));
  it("ne transforme pas une déclaration de pièces bonnes en transfert physique",()=>expect(evaluateOperationReadiness({...base,materials:[],predecessors:[{id:"cut",label:"Découpe",good:20,done:false,transferred:0,partial:true,minimum:1}]}).canStart).toBe(false));
  it("libère la seule quantité transférée, et retranche son avancement",()=>expect(evaluateOperationReadiness({...base,processedQuantity:5,materials:[],predecessors:[{id:"cut",label:"Découpe",good:30,done:false,transferred:20,partial:true,minimum:1}]})).toMatchObject({canStart:true,availableQuantity:15}));
  it("conserve le manque de pièces après une opération achevée avec rebut",()=>expect(evaluateOperationReadiness({...base,materials:[],predecessors:[{id:"cut",label:"Découpe",good:90,done:true,transferred:0,partial:false,minimum:100}]})).toMatchObject({availableQuantity:90,partial:true}));
  it.each(["ANNULE","CLOTURE","TERMINE"])("refuse le démarrage de l’OF %s",executionStatus=>expect(evaluateOperationReadiness({...base,executionStatus}).canStart).toBe(false));
  it("refuse le dossier à revalider et une simple simulation",()=>expect(evaluateOperationReadiness({...base,dossierComplete:false,planned:false}).blockers.map(b=>b.code)).toEqual(expect.arrayContaining(["DOSSIER_INCOMPLETE","OPERATION_NOT_PLANNED"])));
});

describe('déclaration des quantités effectivement autorisées',()=>{
  const facts={executionStatus:'EN_COURS',operationStatus:'RUNNING',available:60,consumedAvailable:20,good:18,scrap:2,pending:0,rework:0};
  it('permet 18 bonnes et 2 rebuts issus du débit de 20 bruts',()=>expect(()=>assertOperationQuantityCeiling(facts)).not.toThrow());
  it('exige le débit effectif même si 60 bruts sont réservés',()=>expect(()=>assertOperationQuantityCeiling({...facts,good:21,scrap:0})).toThrow('Déclarez le débit'));
  it('compte les pièces en attente de contrôle et de reprise dans le plafond',()=>expect(()=>assertOperationQuantityCeiling({...facts,consumedAvailable:60,good:55,pending:3,rework:3,scrap:0})).toThrow('dépasse'));
  it('refuse une déclaration faite avant le démarrage réel',()=>expect(()=>assertOperationQuantityCeiling({...facts,executionStatus:'BROUILLON'})).toThrow('Démarrez'));
  it('permet la fin sans nouveau delta après déclaration de tout le lot',()=>expect(()=>assertOperationQuantityCeiling({...facts,available:0,consumedAvailable:0,good:0,scrap:0})).not.toThrow());
  it('le fraisage ne consomme pas une seconde fois la matière de la découpe',()=>expect(()=>assertOperationQuantityCeiling({...facts,consumedAvailable:null,available:20})).not.toThrow());
});
